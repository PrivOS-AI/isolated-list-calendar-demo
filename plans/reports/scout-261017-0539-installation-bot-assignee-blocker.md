# Installation agent bot cannot set ASSIGNEE on an isolated list (STOP)

Date: 2026-10-17 ICT. privos-hub checked at `b72b7f059` (2026-10-13). No code, manifest, pm2 or prod change was made, and nothing was committed.

## Outcome

- (a) Creating the isolated list: **allowed** for the installation bot.
- (b) Setting ASSIGNEE on items in that list: **not allowed** unless the bot holds the `owner` or `admin` role in the room. A normal install does not give it that role.

So step 2 (the app-side fix) would fail on the first item create with "Only a room owner or admin may change the assignee on an isolated list". Following the instructions, I stopped here.

## How the bot is declared (app side, ready to use)

- Manifest: top-level `"agentBot": { "name", "slug" }`, plus permissions with `"executionContext": "background"` or `"both"`. Examples on this host are `meeting-agent/privos-app.json` and `genealogy-privos-mcp-app/privos-app.json`.
- SDK 0.12.3: `serveApp({ createHandler: (ctx) => ... })` passes `ctx.agentBotHub: RoomBoundHubClient` (`node_modules/@privos_ai/app-server/dist/serve-app.d.ts:27`). It sends the bot's `x-user-id`/`x-auth-token`, which the hub delivers over the relay control channel after an admin issues it.

## Source evidence (privos-hub/apps/meteor)

- (a) List create: `app/api/server/v1/lists.ts:117` resolves the bot through `resolveMcpInstallationBotListAuthority`. `:127` requires an isolated, non-cross-team list. `:134` skips the owner/admin check when `appOwnership` is set.
- The bot authority needs a room subscription (`server/services/mcp-installation-agent-bot-list-authority.ts:60-63`) and `lists:write` in the **background** grant (`:70-82`).
- (b) Every item-create path calls `checkItemGrantFieldWrite` with the bot's userId:
  - REST `app/api/server/v1/items.ts:367`
  - internal `app/api/server/v1/internal/rooms/items.ts:176`
  - MCP list tools `server/services/mcp-tool-handlers-lists.ts:433`
- `app/api/server/lib/item-grant-field-write-policy.ts:117` sets `touchesAssignee` for any assignee change on an isolated list. `:125` then denies it unless `isRoomOwnerOrAdmin` (`:92-99`), which is a raw subscription-roles check with no exception for the installation bot or for app-owned lists.
- Bot room membership: `server/services/mcp-installation-agent-bot.ts:377` adds the bot to the installed room with `addUsersToRoomMethod` as a plain member. The only `owner` grant, at `:228`, is for the bot's own "Agent - <name>" room.

## Minimal ways to unblock (none applied)

1. **Room setup only, no code change.** Re-pair with `agentBot` declared, then the room owner (Thanh) sets the installation bot as **owner** in "Calendar Events (demo)". `isRoomOwnerOrAdmin` then passes. Trade-off: the bot gets full owner authority in that room (reading every isolated item, grant fields, room settings), and the app code alone has to guarantee that the assignee is the verified caller.
2. **Hub-side, smallest code change (needs hub approval).** In `checkItemGrantFieldWrite`, allow an assignee change when the caller is the installation bot that owns the list (`canInstallationBotAccessOwnedList(list, userId, 'lists:write')`). Better still, restrict it to the assignee set being exactly the Hub-verified human actor of the signed relay dispatch, so a compromised app cannot assign arbitrary users.

## Unresolved questions

- Is option 1 (bot as room owner) acceptable for this demo room, or is a hub change (option 2) wanted? Either way, a re-pair with the `agentBot` manifest is needed before anything can be saved.
