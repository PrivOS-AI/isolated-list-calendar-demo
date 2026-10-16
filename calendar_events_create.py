#!/usr/bin/env python3
"""
calendar_events_create — create one event in the isolated list "Calendar Events (demo)"
and assign it to the person who asked in AI Chat.

Identity rule: the assignee is NEVER taken from the model or a CLI argument. It comes
only from platform metadata: the running attempt's `initiatorUserId` /
`initiatorUsername`, read from the sandbox API with `PRIVOS_ATTEMPT_ID`. If that
metadata is missing the script refuses (exit 3) instead of creating an unassigned or
mis-assigned event. Stdout never prints the user id or username, so the requester's
identity does not enter the model context through this tool either.

Status: NOT VERIFIED LIVE. Reading the attempt from inside the agent VM, and the bot
being allowed to set ASSIGNEE (it must be room owner/admin on an isolated list), both
need one live AI Chat run before this is called working.

Env (all set by the sandbox except the optional overrides):
  PRIVOS_ATTEMPT_ID        id of the attempt this turn runs in (required)
  PRIVOS_ROOM_ID           room that holds the list (or pass --room-id)
  PRIVOS_SANDBOX_API_URL   optional, sandbox API base; default http://127.0.0.1:${PORT:-3000}/api
  CALENDAR_LIST_NAME       optional, default "Calendar Events (demo)"

Exit codes: 0 created and verified, 2 bad input or list/field setup, 3 requester
identity unavailable, 4 hub write/read-back failed or assignee mismatch.
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

DEFAULT_LIST_NAME = "Calendar Events (demo)"
# Field names the room owner creates on the list (see README.md, "One-time setup").
FIELD_ASSIGNEE = "Assignee"
FIELD_START = "Start"
FIELD_END = "End"
FIELD_NOTES = "Notes"


def out(payload, code):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(code)


def iso_utc(value, label):
    """Accept ISO 8601 with offset (e.g. 2026-10-20T09:00:00+07:00); return UTC Z form."""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        out({"ok": False, "error": f"{label} is not ISO 8601: {value}"}, 2)
    if dt.tzinfo is None:
        out({"ok": False, "error": f"{label} needs a timezone offset, e.g. +07:00"}, 2)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_requester():
    """Return (user_id, username) of the AI Chat sender from the attempt row, or exit 3."""
    attempt_id = os.environ.get("PRIVOS_ATTEMPT_ID", "").strip()
    if not attempt_id:
        out({"ok": False, "error": "PRIVOS_ATTEMPT_ID not set; cannot identify the requester"}, 3)
    base = os.environ.get("PRIVOS_SANDBOX_API_URL") or f"http://127.0.0.1:{os.environ.get('PORT', '3000')}/api"
    url = f"{base.rstrip('/')}/attempts/{quote(attempt_id, safe='')}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            attempt = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # network, 404, non-JSON: all mean "identity unavailable"
        out({"ok": False, "error": f"cannot read own attempt from sandbox API: {type(exc).__name__}"}, 3)
    user_id = (attempt.get("initiatorUserId") or "").strip()
    username = (attempt.get("initiatorUsername") or "").strip()
    if not user_id or not username:
        out({"ok": False, "error": "attempt has no initiator (not an AI Chat turn?); refusing to create"}, 3)
    return user_id, username


def hub_call(method, path, body=None):
    """Hub request through the PrivOS skill SDK (egress proxy injects the bot key)."""
    from privos_skill import hub  # provided by the sandbox (PYTHONPATH)

    fn = {"GET": hub.get, "POST": hub.post}[method]
    resp = fn(f"/api/v1{path}", json_body=body) if body is not None else fn(f"/api/v1{path}")
    try:
        data = resp.json()
    except ValueError:
        data = {"raw": resp.text[:300]}
    return resp.status_code, data


def find_list(room_id, list_name):
    status, data = hub_call("GET", f"/internal/rooms/{room_id}/lists")
    lists = data.get("lists", data if isinstance(data, list) else [])
    match = [l for l in lists if l.get("name") == list_name]
    if status != 200 or not match:
        out({"ok": False, "error": f'list "{list_name}" not found in room (HTTP {status})'}, 2)
    lst = match[0]
    if not lst.get("isolatedList"):
        out({"ok": False, "error": f'list "{list_name}" is not isolated; refusing (events would be visible to all)'}, 2)
    return lst


def resolve_fields(room_id, lst):
    defs = lst.get("fieldDefinitions")
    if not defs:
        _, data = hub_call("GET", f"/internal/rooms/{room_id}/lists/{lst['_id']}/fields")
        defs = data.get("fields", data.get("fieldDefinitions", data if isinstance(data, list) else []))
    by_name = {f.get("name"): f for f in defs}
    assignee = by_name.get(FIELD_ASSIGNEE)
    if not assignee or assignee.get("type") != "ASSIGNEE":
        out({"ok": False, "error": f'list needs an ASSIGNEE field named "{FIELD_ASSIGNEE}"'}, 2)
    return by_name


def first_stage_id(room_id, lst):
    if lst.get("defaultStageId"):
        return lst["defaultStageId"]
    _, data = hub_call("GET", f"/internal/rooms/{room_id}/stages?listId={quote(lst['_id'], safe='')}")
    stages = data.get("stages", data if isinstance(data, list) else [])
    if not stages:
        out({"ok": False, "error": "list has no stage"}, 2)
    return sorted(stages, key=lambda s: s.get("order", 0))[0]["_id"]


def main():
    ap = argparse.ArgumentParser(description="Create a calendar event for the AI Chat requester.")
    ap.add_argument("--title", required=True)
    ap.add_argument("--start", required=True, help="ISO 8601 with offset, e.g. 2026-10-20T09:00:00+07:00")
    ap.add_argument("--end", help="ISO 8601 with offset")
    ap.add_argument("--notes", default="")
    ap.add_argument("--room-id", default=os.environ.get("PRIVOS_ROOM_ID", ""))
    ap.add_argument("--list-name", default=os.environ.get("CALENDAR_LIST_NAME", DEFAULT_LIST_NAME))
    ap.add_argument("--dry-run", action="store_true", help="resolve identity, list and fields; do not write")
    args = ap.parse_args()

    if not args.room_id:
        out({"ok": False, "error": "no room id (PRIVOS_ROOM_ID or --room-id)"}, 2)
    start = iso_utc(args.start, "--start")
    end = iso_utc(args.end, "--end") if args.end else None
    if end and end < start:
        out({"ok": False, "error": "--end is before --start"}, 2)

    # Identity first: no list access or write happens without a verified requester.
    user_id, username = read_requester()
    lst = find_list(args.room_id, args.list_name)
    fields = resolve_fields(args.room_id, lst)
    stage_id = first_stage_id(args.room_id, lst)

    custom = [{"fieldId": fields[FIELD_ASSIGNEE]["_id"], "value": [{"_id": user_id, "username": username}]}]
    for name, value in ((FIELD_START, start), (FIELD_END, end), (FIELD_NOTES, args.notes or None)):
        if value and name in fields:
            custom.append({"fieldId": fields[name]["_id"], "value": value})

    if args.dry_run:
        out({"ok": True, "dryRun": True, "requesterResolved": True, "list": args.list_name,
             "fields": [f for f in (FIELD_START, FIELD_END, FIELD_NOTES) if f in fields]}, 0)

    body = {"name": args.title, "listId": lst["_id"], "stageId": stage_id, "customFields": custom}
    status, created = hub_call("POST", f"/internal/rooms/{args.room_id}/items", body)
    item = created.get("item") if isinstance(created.get("item"), dict) else created
    item_id = item.get("_id") if isinstance(item, dict) else None
    if status != 200 or not item_id:
        # error-not-allowed here means the bot is not owner/admin of the room.
        out({"ok": False, "error": f"create failed (HTTP {status})",
             "hubError": created.get("errorType") or created.get("error")}, 4)

    # Read back and confirm the stored assignee is exactly the requester.
    status, got = hub_call("GET", f"/internal/rooms/{args.room_id}/items/{item_id}")
    got = got.get("item", got)
    stored = next((cf.get("value") for cf in got.get("customFields", [])
                   if cf.get("fieldId") == fields[FIELD_ASSIGNEE]["_id"]), None) or []
    matches = [a.get("_id") for a in stored] == [user_id]
    reference = f"@Lists:{args.room_id}/{lst['_id']}/{item_id}/{quote(args.title, safe='')}"
    if status != 200 or not matches:
        out({"ok": False, "error": "read-back failed or assignee mismatch", "reference": reference}, 4)
    out({"ok": True, "reference": reference, "assignedToRequester": True, "start": start, "end": end}, 0)


if __name__ == "__main__":
    main()
