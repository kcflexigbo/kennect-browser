# Adopt windows opened outside browser_open_window — design

Issue: #9
Date: 2026-11-17
Status: approved in conversation

## Intent

Agents sometimes open Chrome windows outside Kennect (Chrome CLI, Playwright,
another automation tool). `browser_windows` can see those windows, but
`browser_close_window` refuses them because the window registry only records
windows created by `browser_open_window`. Chrome exposes no creator identity,
so the extension cannot infer that the same agent opened an untracked window.
The fix is an explicit adoption step: the agent asserts ownership after user
authorization, then the existing window lifecycle works.

## Goals

- Add `browser_adopt_window({ windowId })` and controller command
  `adopt-window <windowId>`.
- Create a registry entry with `createdByTool:false`, `adopted:true`,
  `adoptedAt`, and `adoptedBy`.
- Expose adoption provenance in `browser_windows`.
- Let `browser_close_window` close adopted windows while still refusing
  untracked windows.
- Preserve the last-normal-window guard and the claim model unchanged.
- Document the explicit-user-authorization requirement in tool descriptions
  and the operating skill.

## Non-goals

- Inferring who opened a window automatically.
- Closing arbitrary untracked windows without adoption.
- Treating adoption as a claim. Naming and claiming remain
  `browser_update_window` operations.
- Saved tab groups (issue #10).

## Approaches

1. **Separate `browser_adopt_window`, then close (chosen).** Explicit,
   auditable, and preserves the close guard. Costs one extra call.
2. `browser_close_window({ windowId, adopt: true })` — one call, but it
   conflates the ownership assertion with a destructive action. A stale or
   guessed ID could close user work in a single step. Rejected.
3. One-time close token from `browser_windows` — protects against guessed IDs,
   but adds protocol surface and no persistent provenance. Rejected for v1;
   possible future hardening.

## Design

### Registry entry

Adoption creates this entry in the session-scoped `windowRegistry`:

```json
{
  "windowId": 123,
  "name": null,
  "purpose": null,
  "createdByTool": false,
  "adopted": true,
  "adoptedAt": 1763337600000,
  "adoptedBy": "<session id>",
  "ownerSession": null,
  "claimedAt": null,
  "leaseUntil": null,
  "leaseMs": 1800000,
  "createdAt": 1763337600000
}
```

`adoptedBy` is provenance. Claims remain separate: `ownerSession` and
`leaseUntil` stay empty until the agent calls `browser_update_window` with
`claim:true` and a name.

### Extension worker

- `adoptWindow(windowId, sessionId)`:
  - Validate an integer window ID.
  - Run inside `withWindowRegistry`, prune dead windows, and require the
    window to be live.
  - If the window already has an entry (tool-created or adopted), return its
    summary unchanged; adoption is idempotent.
  - Otherwise create the adopted entry and save the registry.
  - Return the window summary.
- `windowSummary` adds `adopted`, `adoptedAt` (ISO), and `adoptedBy`
  (short owner label).
- `closeWindow` allows `entry.createdByTool || entry.adopted`; the refusal
  message names `browser_adopt_window`.
- `updateWindow` already works once an entry exists; update its tool
  description to say “tool-created or adopted”.
- Dispatch: `adopt-window` → `adoptWindow(Number(args[0]), sessionId)`.

### MCP and controller

- `server.mjs`: add `browser_adopt_window` with `{ windowId }` required and
  the default destructive (non-read-only) annotation; command map entry
  `['adopt-window', String(args.windowId)]`.
- `controller.mjs`: add `adopt-window` to `extensionOnly` and to the
  dedicated-profile switch fallback.
- Descriptions:
  - `browser_windows` mentions that untracked windows can be adopted.
  - `browser_close_window` accepts windows created by
    `browser_open_window` or adopted with `browser_adopt_window`.
  - `browser_adopt_window` requires explicit user authorization and says
    never to adopt a window the agent did not open.

### Skill

Add to the window guidance: adopt only a window the agent opened outside
Kennect, after explicit user authorization; adoption then allows the existing
rename/claim/close lifecycle. Never adopt a user window.

## Edge cases

- Unknown or dead window: error “Unknown window ID. Refresh with
  browser_windows.”
- Adoption is idempotent for already tool-created or adopted windows.
- Adopting the last normal window is allowed, but closing it is still
  refused by the last-window guard.
- Adopted entries are pruned when the window closes.
- Tool-created windows and claims behave unchanged.
- Adoption does not grant tab or origin access; it only registers window
  ownership.

## Tests

- Extension: untracked close still refused (existing); adopt an untracked
  window; `browser_windows` reports `createdByTool:false`, `adopted:true`,
  and `adoptedBy`; close after adoption succeeds; the last-window guard still
  refuses; idempotent adoption; unknown window errors; tool-created windows
  still close.
- MCP: tool exists, schema requires `windowId`, destructive annotation,
  invalid ID rejected.
- Controller: `adopt-window` requires the extension.
- Full suite green.

## Left to the builder

Exact error wording, test ordering, README/skill edits, and whether the plan
bumps the version now or after the #10 release.
