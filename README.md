# Calendar Events (demo): per-user events from AI Chat

> **Status: NOT VERIFIED LIVE.** Built and tested offline only (7/7 tests with a fake hub and a fake attempt API). Two legs still need one live AI Chat run, see "Open legs" below. Nothing has been created on any hub.

Rox Ops, 2026-10-16. Pattern for @leo_dev: the user asks the agent in the **AI Chat window** ("add a meeting Tue 9:00"), and the agent creates one event for that user. User A sees only A's events, B only B's, the room owner sees both. No hub or sandbox code change.

## How it works

1. **One isolated list**, "Calendar Events (demo)". In an isolated list an item is visible to its creator, its ASSIGNEE, holders of a read grant, and room owners/admins. Everyone else gets it filtered out (`isolated-list-item-filter.ts`).
2. **One item per event**, ASSIGNEE = the person who asked.
3. **Who asked comes from platform metadata, never from the model.** The hub sends `initiatorUserId/initiatorUsername` with the attempt. The sandbox stores it on the attempt row. `calendar_events_create.py` reads `GET /api/attempts/$PRIVOS_ATTEMPT_ID` on its own sandbox and uses that. There is no `--user` argument, and stdout never prints the id or username.
4. If the requester cannot be read (not an AI Chat turn, cron run, API unreachable), the script **refuses** (exit 3). It does not fall back to a guess.

Since the item's creator is the bot, the bot can also see every event. Isolation holds between users, not against the agent.

## One-time setup (room owner, in the hub UI)

1. Create a room for the demo, add the users, and **make the agent bot a room owner** (only owner/admin may set ASSIGNEE on an isolated list; otherwise the hub returns `error-not-allowed`).
2. Create the list **Calendar Events (demo)** with **Isolated list** on (only an owner/admin can turn this on).
3. Add fields with these exact names: `Assignee` (ASSIGNEE), `Start` (DATE_TIME), `End` (DATE_TIME), `Notes` (TEXTAREA). Only `Assignee` is required.
4. The room's sandbox must run in dedicated mode (the script needs Bash).
5. Put `calendar_events_create.py` in the agent's skills and tell the agent in its instructions: "To add a calendar event, run `python3 calendar_events_create.py --title ... --start <ISO with offset> [--end ...] [--notes ...]`. Never pass a user."

## Usage

```bash
python3 calendar_events_create.py --title "Team sync" \
  --start 2026-10-20T09:00:00+07:00 --end 2026-10-20T10:00:00+07:00 --notes "Room 2"
# {"ok": true, "reference": "@Lists:...", "assignedToRequester": true, "start": "2026-10-20T02:00:00Z", ...}
```

`--dry-run` resolves the requester, list and fields without writing. Times are stored in UTC.

| Exit | Meaning |
|------|---------|
| 0 | created, read back, assignee = requester |
| 2 | bad input, list missing, list not isolated, or no `Assignee` field |
| 3 | requester identity unavailable, nothing written |
| 4 | hub write failed (e.g. `error-not-allowed`: bot is not room owner) or read-back mismatch |

## Open legs (need the live run)

| Leg | Risk | Check |
|-----|------|-------|
| Agent can read its own attempt (`/api/attempts/$PRIVOS_ATTEMPT_ID`) from inside the VM, and the row has the initiator | Route may not be reachable from the VM, or the default URL `http://127.0.0.1:${PORT:-3000}/api` may be wrong. Override with `PRIVOS_SANDBOX_API_URL` | `--dry-run` in an AI Chat turn → `requesterResolved: true` |
| Bot as room owner can set ASSIGNEE on an isolated list | Code says yes (`items.ts:148-156`) | Real create → exit 0 |
| A sees only A's, B only B's, owner both | Code says yes | Log in as A and B, open the list |

## Files

- `calendar_events_create.py`: the tool.
- `test_calendar_events_create.py`: offline tests (`python3 test_calendar_events_create.py`).
