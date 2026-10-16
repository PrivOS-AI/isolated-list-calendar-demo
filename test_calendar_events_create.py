#!/usr/bin/env python3
"""Offline tests for calendar_events_create: a fake sandbox attempt API (local HTTP) and a
fake `privos_skill.hub` module. Proves the identity rules, not live hub behaviour."""

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "calendar_events_create.py")

ATTEMPTS = {
    "att_chat": {"id": "att_chat", "initiatorUserId": "uA", "initiatorUsername": "user.a"},
    "att_cron": {"id": "att_cron", "initiatorUserId": None, "initiatorUsername": None},
}

# Fake hub: one isolated list; records writes to a JSON file so the test can inspect them.
FAKE_HUB = r'''
import json, os
STATE = os.environ["FAKE_HUB_STATE"]
ISOLATED = os.environ.get("FAKE_ISOLATED", "1") == "1"
DENY = os.environ.get("FAKE_DENY_ASSIGNEE") == "1"
LIST = {"_id": "L1", "name": "Calendar Events (demo)", "isolatedList": ISOLATED, "defaultStageId": "S1",
        "fieldDefinitions": [{"_id": "fA", "name": "Assignee", "type": "ASSIGNEE"},
                             {"_id": "fS", "name": "Start", "type": "DATE_TIME"},
                             {"_id": "fE", "name": "End", "type": "DATE_TIME"},
                             {"_id": "fN", "name": "Notes", "type": "TEXTAREA"}]}
class R:
    def __init__(self, code, body): self.status_code, self._b, self.text = code, body, json.dumps(body)
    def json(self): return self._b
def _load():
    return json.load(open(STATE)) if os.path.exists(STATE) else {}
class _Hub:
    def get(self, path, **_):
        if path.endswith("/lists"): return R(200, {"lists": [LIST]})
        if "/items/" in path: return R(200, {"item": _load().get("item", {})})
        return R(404, {})
    def post(self, path, json_body=None, **_):
        if DENY: return R(400, {"success": False, "errorType": "error-not-allowed"})
        item = dict(json_body, _id="I1"); json.dump({"item": item}, open(STATE, "w"))
        return R(200, {"item": item})
hub = _Hub()
'''


class AttemptHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        att = ATTEMPTS.get(self.path.rsplit("/", 1)[-1])
        self.send_response(200 if att else 404)
        self.end_headers()
        self.wfile.write(json.dumps(att or {"error": "Attempt not found"}).encode())

    def log_message(self, *_):
        pass


class CalendarEventsCreateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), AttemptHandler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.tmp = tempfile.mkdtemp()
        with open(os.path.join(cls.tmp, "privos_skill.py"), "w") as f:
            f.write(FAKE_HUB)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_script(self, attempt_id, *extra, **env_extra):
        state = os.path.join(self.tmp, f"state-{self.id()}.json")
        env = {"PATH": os.environ["PATH"], "PYTHONPATH": self.tmp, "PRIVOS_ROOM_ID": "R1",
               "PRIVOS_SANDBOX_API_URL": f"http://127.0.0.1:{self.server.server_port}/api",
               "FAKE_HUB_STATE": state, **env_extra}
        if attempt_id:
            env["PRIVOS_ATTEMPT_ID"] = attempt_id
        args = [sys.executable, SCRIPT, "--title", "Team sync", "--start", "2026-10-20T09:00:00+07:00",
                "--end", "2026-10-20T10:00:00+07:00", *extra]
        p = subprocess.run(args, env=env, capture_output=True, text=True)
        written = json.load(open(state))["item"] if os.path.exists(state) else None
        return p.returncode, json.loads(p.stdout), p.stdout, written

    def test_creates_item_assigned_to_requester_and_hides_identity(self):
        code, res, raw, item = self.run_script("att_chat")
        self.assertEqual(code, 0, raw)
        self.assertTrue(res["assignedToRequester"])
        self.assertEqual(res["start"], "2026-10-20T02:00:00Z")
        assignee = next(cf for cf in item["customFields"] if cf["fieldId"] == "fA")
        self.assertEqual(assignee["value"], [{"_id": "uA", "username": "user.a"}])
        self.assertNotIn("uA", raw)
        self.assertNotIn("user.a", raw)

    def test_refuses_without_attempt_id(self):
        code, res, _, item = self.run_script(None)
        self.assertEqual(code, 3)
        self.assertIsNone(item)

    def test_refuses_when_attempt_has_no_initiator(self):
        code, _, _, item = self.run_script("att_cron")
        self.assertEqual(code, 3)
        self.assertIsNone(item)

    def test_refuses_unknown_attempt(self):
        code, _, _, item = self.run_script("att_missing")
        self.assertEqual(code, 3)
        self.assertIsNone(item)

    def test_refuses_non_isolated_list(self):
        code, _, _, item = self.run_script("att_chat", FAKE_ISOLATED="0")
        self.assertEqual(code, 2)
        self.assertIsNone(item)

    def test_reports_assignee_permission_denial(self):
        code, res, _, _ = self.run_script("att_chat", FAKE_DENY_ASSIGNEE="1")
        self.assertEqual(code, 4)
        self.assertEqual(res["hubError"], "error-not-allowed")

    def test_dry_run_writes_nothing(self):
        code, res, _, item = self.run_script("att_chat", "--dry-run")
        self.assertEqual(code, 0)
        self.assertTrue(res["dryRun"])
        self.assertIsNone(item)


if __name__ == "__main__":
    unittest.main()
