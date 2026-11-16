# Window lifecycle, names, and claims

Date: 2026-11-16
Status: Draft for approval
Issue: https://github.com/kcflexigbo/kennect-browser/issues/4

## Intent and why

Kennect Browser is tab-centric. It can open a tab, select a tab, and resize the window
that a tab happens to occupy, but it cannot create a window, list windows, target a
window, or give a window a name. That gap blocks parallel viewport testing: two agents
sharing one Chrome profile cannot hold different window sizes without a human dragging
tabs into separate windows.

This design adds a window layer:

- create, list, update, and close Chrome windows;
- target a window explicitly when opening or moving tabs;
- name a window and record its purpose, so agents can see that a window belongs to
  another agent and avoid it;
- claim a window for a session with a renewable lease, enforced against window-scoped
  mutations only.

The claim is a coordination guardrail, not a security boundary. It exists to stop two
cooperating agents from resizing or closing each other's test windows. It does not
protect page content from another agent that deliberately ignores it.

## Goals

1. Two agents in the same Chrome profile can create independent windows and resize them
   without affecting each other.
2. An agent can discover window names, purposes, bounds, state, and ownership before
   creating another window.
3. Window names are unique among live windows; creation and rename reject duplicates.
4. A window can be claimed by a session with a lease. Another session's window-scoped
   mutation fails with a clear error until the lease expires or is released.
5. Page reads and page actions in a claimed window remain possible, so a stale lease
   never blocks debugging.
6. Existing tab-only calls keep their current behavior when the target window is
   unclaimed. Implicit target windows are resolved explicitly so a claim cannot be
   bypassed by omitting `windowId`.
7. Window operations are available through the MCP schema and work inside
   `browser_batch`.

## Non-goals

- No password or secret token. A claim is identified by the caller's session ID.
- No enforcement on page actions: snapshot, click, fill, type, key, scroll, screenshot,
  evaluate, network, console, recording, file inputs, upload, download, close-tab,
  select-tab.
- No cross-window tab groups. Chrome tab groups are per window.
- No exact viewport or device emulation. Window bounds are outer window dimensions.
  Agents verify `innerWidth` / `innerHeight` when exact viewport matters.
- No Chrome-visible window name. The registry and tool output carry the name.
- No persistence across browser restart or extension reload. Window IDs reset too, so
  session-scoped storage is the correct lifetime.
- No CDP-fallback support. Window operations require the extension, like groups,
  downloads, and uploads.
- No per-agent selection isolation. `connectedTab` remains shared; parallel agents must
  pass explicit `tabId` / `windowId` on every call.

## Anti-goals

- Closing a user window that was not created by `browser_open_window` in this browser
  session.
- Closing the last normal Chrome window and terminating the browser.
- A claim that cannot be recovered: leases must expire, and `force` must exist with
  explicit user authorization.
- Names, purposes, or claims being described as security isolation in tool output or
  documentation.
- Breaking any existing tool call that does not mention a window.

## Constraints

- Chrome's `windows` API has no window name or title. Names are extension-side metadata.
- `windows.create` returns the new Window with its tabs. Window bounds include browser
  chrome, not just the page viewport.
- Window IDs are unique within a browser session. `chrome.storage.session` survives
  service-worker restarts and is cleared on browser restart or extension reload.
- `windows.update` cannot apply bounds while a window is minimized, maximized, or
  fullscreen. Set `state: "normal"` first.
- The bridge opens a new socket per tool call, so the native host cannot identify the
  caller across calls. A session ID must be supplied by the caller.
- `chrome.windows` requires no additional manifest permission. The extension already
  has `tabs`, `storage`, and `tabGroups`.
- The MCP schema validator supports flat primitives and arrays only, not `oneOf`.
  Mutual exclusion (`tabId` vs `windowId`) is checked in `server.mjs`.
- The extension test harness loads `worker.js` as a single `vm` script with a fake
  `chrome`. Window logic must stay inline in `worker.js`; extracting an ES module would
  force a test-harness rewrite.
- Tests must not depend on wall-clock sleeps for lease expiry. Expiry is tested by
  rewriting session storage and restarting the worker.

## Approaches considered

### 1. Dedicated window tools plus `windowId` on existing tools (chosen)

Add `browser_windows`, `browser_open_window`, `browser_update_window`, and
`browser_close_window`. Add optional `windowId` to `browser_open_tab`,
`browser_resize`, `browser_move_tab`, and a filter to `browser_tabs`.

Discoverable; matches the repo's one-tool-per-action convention; lock checks live in
one place; works in batches. Costs four tools and focused additions to an already dense
worker.

### 2. Flags on existing tools only

`browser_open_tab({newWindow, width, height, name})` and
`browser_resize({windowId})`. Smaller surface, but no list, focus, rename, claim, or
close, and an agent cannot see a named window before creating another. Fixes issue #4
but does not deliver window management. Rejected.

### 3. One `browser_window` tool with an `action` enum

Compact tool count, but action-dependent arguments weaken validation and discovery,
batches become awkward, and it breaks the one-tool-per-action pattern. Rejected.

### Internal structure

Window registry and enforcement stay inline in `extension/worker.js` as helper
functions. No new extension module. This follows from the test-harness constraint.

## Data model

`chrome.storage.session` key `windowRegistry`, an object keyed by window ID:

```json
{
  "123": {
    "windowId": 123,
    "name": "mobile-390",
    "purpose": "mobile viewport testing",
    "ownerSession": "8f14e45f",
    "claimedAt": 1763251200000,
    "leaseUntil": 1763253000000,
    "leaseMs": 1800000,
    "createdByTool": true,
    "createdAt": 1763251200000
  }
}
```

Rules:

- Entries are created only by `browser_open_window`. `browser_update_window` can add a
  name, purpose, or claim to a live window that has an entry, but it cannot create an
  entry for an untracked user window. This keeps close permission tied to tool-created
  windows.
- `createdByTool` is always `true` for registry entries. The field is stored for clarity
  and future migration.
- A claim is active when `ownerSession` is set and `leaseUntil > Date.now()`.
- Expired claims are cleared lazily during registry reads and writes.
- `name` is unique among live windows, compared case-insensitively after trimming.
- A missing registry entry means an untracked window: visible in `browser_windows`, but
  not closeable and not claimable.
- Registry entries for windows that no longer exist are pruned whenever windows are
  read or mutated.
- All registry reads and writes go through a promise-chain mutex so concurrent calls
  cannot lose updates.

### Session identity

- `server.mjs` generates `KENNECT_BROWSER_SESSION_ID` once at startup if the
  environment does not already set it, and leaves it in `process.env` so every
  controller child inherits it. One MCP server process = one agent session.
- `controller.mjs` generates one for a direct CLI invocation if absent.
- `bridge-client.mjs` includes `sessionId` in the request payload.
- `native-host.mjs` forwards `sessionId` (string, capped at 100 characters) in the
  request frame.
- `extension/worker.js` reads `sessionId` from the request and defaults to `"local"`.
- A claim stores the full session ID. Tool output shows only the first 8 characters as
  the owner label.
- The session ID is an identifier, not a secret. Another local process could spoof it.
  This is acceptable for a coordination guardrail.

## API

### New tools

#### `browser_windows` (read-only)

Arguments: `{ name?: string }` (plus the automatic `profile`).

Returns JSON:

```json
{
  "windows": [
    {
      "windowId": 123,
      "name": "mobile-390",
      "purpose": "mobile viewport testing",
      "createdByTool": true,
      "owner": "8f14e45f",
      "claimedByYou": true,
      "claimedByOther": false,
      "leaseUntil": "2026-11-16T03:30:00.000Z",
      "focused": false,
      "state": "normal",
      "bounds": {"left": 0, "top": 0, "width": 390, "height": 844},
      "tabCount": 1,
      "connectedTabCount": 1
    }
  ]
}
```

- Lists normal windows only (`windowTypes: ["normal"]`).
- Returns no tab titles or URLs.
- Filters by name when provided; no match returns an empty list.
- Prunes dead windows and expired claims.
- `claimedByYou` is true when the active claim belongs to the caller's session.

#### `browser_open_window`

Arguments:

| Argument | Type | Required | Rules |
|---|---|---|---|
| `url` | string | yes | HTTP(S) only, no credentials |
| `width` | integer | no | 320–4000; must be paired with `height` |
| `height` | integer | no | 240–4000; must be paired with `width` |
| `left` | integer | no | -20000–20000 |
| `top` | integer | no | -20000–20000 |
| `focused` | boolean | no | Default `false` so automation does not steal focus |
| `name` | string | no | 1–40 chars, trimmed, no control chars, unique |
| `purpose` | string | no | 1–200 chars |
| `claim` | boolean | no | Claims the window for the caller; requires `name` |
| `leaseMs` | integer | no | 60000–86400000; default 1800000 (30 min) |
| `reuseExisting` | boolean | no | Default `false` |

Behavior:

- Validates URL, bounds, name, purpose, and claim/name pairing before creating anything.
- If `name` matches a live window:
  - `reuseExisting: false` → error naming the existing window ID.
  - `reuseExisting: true` → return the existing window with `reused: true`; do not change
    its bounds. If another session holds an active claim, error. If `claim: true` and the
    window is unclaimed or owned by the caller, claim or renew it before returning.
    Without `claim: true`, existing ownership is left unchanged.
- Creates a normal window with the URL, optional bounds, and `focused`.
- Approves the origin, attaches the debugger, and makes the new tab the connected tab,
  matching `browser_open_tab`.
- Writes the registry entry, claims it when requested, persists state, and returns:

```json
{"windowId": 123, "tabId": "456", "name": "mobile-390", "reused": false,
 "owner": null, "claimedByYou": false, "leaseUntil": null}
```

On reuse, the claim fields reflect the existing window's ownership.

- On reuse, `tabId` is `null`; the agent should call `browser_tabs({windowId})`.

#### `browser_update_window`

Arguments: `{ windowId, width?, height?, left?, top?, focused?, state?, name?, purpose?,
claim?, leaseMs?, force? }`.

- At least one mutation must be present.
- `state` enum: `normal`, `minimized`, `maximized`, `fullscreen`.
- Width/height paired and range-checked as above; `left`/`top` range-checked.
- Bounds and non-normal state together: apply bounds first with `state: "normal"`, then
  apply the requested state in a second `windows.update`.
- `name` uniqueness excludes the same window. Renaming is a window-scoped mutation.
- `claim: true` requires the window to have a `name` (existing or supplied) and sets the
  owner to the caller, `claimedAt` to now, `leaseMs` to the supplied or existing value,
  and `leaseUntil` to now + `leaseMs`.
- `claim: false` releases the claim. Only the owner can release; `force` overrides.
- Every successful window-scoped mutation by the owner renews the lease; see
  Enforcement.
- A mutation by another session with an active claim fails unless `force: true`.
- `force` is documented as requiring explicit user authorization. It does not bypass
  the unknown-window or untracked-window checks.
- Returns JSON with the applied state, bounds, name, purpose, owner, and lease.

#### `browser_close_window`

Arguments: `{ windowId, force?: boolean }`.

- Refuses untracked windows: only windows created by `browser_open_window` in this
  browser session are closeable.
- Refuses to close the last normal window, even with `force`.
- Refuses another session's active claim unless `force: true`.
- Removes the window and its registry entry, and returns
  `{"closed": true, "windowId": 123}`.
- The tool description states that closing a window closes all its tabs and requires
  explicit user authorization.

### Extended tools

- `browser_open_tab` adds `windowId?: integer`. The tab is created in that window; the
  window must exist and must not be claimed by another session. If omitted, the target
  is resolved as described under Enforcement. Returns `windowId` in addition to
  `targetId` and `groupId`.
- `browser_resize` adds `windowId?: integer`. `tabId` and `windowId` are mutually
  exclusive. With neither, it resizes the connected tab's window. With `windowId`, it
  resizes that window. The target window must not be claimed by another session.
- `browser_move_tab` adds `windowId?: integer` as the destination window. Both the
  source window and the destination window are checked for another session's active
  claim.
- `browser_tabs` adds `windowId?: integer` to filter the listing to one window.

### Tool count and annotations

- 41 tools total.
- `browser_windows` is `readOnlyHint: true`.
- `browser_open_window`, `browser_update_window`, and `browser_close_window` are
  destructive per the existing helper.
- All four new tools accept `profile`; they are not added to the helper's exclusion
  list.

## Enforcement

`assertWindowAccess(windowId, sessionId, {force})` is called before every
window-scoped mutation, whether the caller named a window or not:

- `open-tab` against the resolved target window (see below);
- `open-window` when `reuseExisting` targets a live named window;
- `update-window`, `close-window`;
- `move-tab` for both the source and destination windows;
- `resize` against the resolved target window.

It is not called by page actions, `select-tab`, `close-tab`, group operations, or
downloads. The design intentionally leaves those available in another agent's window.

### Target resolution for calls that omit `windowId`

Claims must not be bypassable by leaving `windowId` out, so every window-scoped
command resolves its target window before mutating anything:

- `open-tab`: explicit `windowId`, else the connected tab's window, else
  `chrome.windows.getLastFocused({windowTypes: ["normal"]})`. The resolved window ID is
  passed to `chrome.tabs.create` so Chrome's own "current window" choice cannot land the
  tab elsewhere.
- `resize`: explicit `windowId`, else the `tabId`'s window, else the connected tab's
  window.
- `move-tab`: the tab's current window is the source; the destination is explicit
  `windowId` or the source. If there is no connected tab and no explicit target, the
  command fails with the existing "Select a website tab first" error.
- `select-tab` and page actions are unchanged.

This is a deliberate behavior change for `open-tab` without `windowId`: it now opens in
the connected tab's window rather than whichever window Chrome considers current. That
makes task tabs land where the agent is already working and makes claims enforceable.

### Lease renewal

After a successful window-scoped mutation, if the window's active claim belongs to the
caller, renew `leaseUntil` to now + the stored `leaseMs`. This applies to `open-tab` into
the window, `resize`, `move-tab` into or out of it, and `update-window`.
`browser_windows` does not renew. `close-window` removes the entry rather than renewing.
A failed or refused call never renews.

Two conflict variants:

```
Window 123 "mobile-390" is claimed by another agent until 2026-11-16T03:30:00.000Z.
Use another window or ask the user to release the claim.
```

`browser_update_window` and `browser_close_window` append:

```
Or pass force with explicit user authorization.
```

`browser_open_tab`, `browser_resize`, and `browser_move_tab` have no `force` argument
and use the first variant. A caller that needs to override reaches
`browser_update_window` or `browser_close_window` explicitly.

The owner label is the first 8 characters of the session ID.

## Protocol changes

`bridge-client.mjs` payload:

```json
{"command": "...", "args": [], "tabId": "...", "sessionId": "..."}
```

`native-host.mjs` request frame:

```json
{"type": "request", "id": "...", "command": "...", "args": [], "tabId": "...", "sessionId": "..."}
```

The Windows bridge token remains unchanged. Older callers that omit `sessionId` are
treated as `"local"`. Older extensions ignore the extra field.

## Storage and service-worker lifecycle

- `windowRegistry` is loaded once at worker startup into memory, with a `windowsReady`
  promise, mirroring `downloadsReady`.
- Every write serializes the whole registry object back to session storage.
- A promise-chain mutex protects read-modify-write sequences.
- On worker restart, names, purposes, and claims reload from session storage. The
  regression test must cover this.
- On browser restart or extension reload, registry entries vanish. Existing windows
  become untracked: visible, not closeable, not claimable. This is documented.

## Error cases

| Case | Result |
|---|---|
| Unknown window ID | "Unknown window ID. Refresh with browser_windows." |
| Untracked window passed to update/close | Error; only tool-created windows are managed |
| Duplicate name on create | Error with the existing window ID |
| Duplicate name on rename | Error with the existing window ID |
| Claim without name | Error before any window is created |
| Claim conflict | Claim-conflict error above |
| Both `tabId` and `windowId` on resize | JSON-RPC invalid params (-32602) |
| Non-HTTP(S) URL | Error; only HTTP(S) is allowed |
| Close last normal window | Error; browser termination is never a tool side effect |
| CDP fallback used | "Window operations require the Kennect Browser extension." |

## Testing plan

### Extension tests (`extension.test.mjs`)

Extend the fake `chrome` with `windows.create/get/getAll/remove/update`, `tabs.create`
accepting `windowId`, `tabs.query` accepting `windowId`, and `tabs.move`.

Add tests:

1. `browser_windows` lists a named tool-created window with bounds, owner, and counts.
2. Opening a window creates it, connects its tab, and returns windowId/tabId.
3. A duplicate name is refused; `reuseExisting` returns the existing window.
4. Rename to an existing name is refused.
5. Resize by `windowId` changes only that window.
6. `open-tab` with `windowId` lands in that window.
7. `move-tab` moves a tab to the destination window.
8. Closing an untracked window is refused.
9. Closing a tracked window removes it and its registry entry.
10. Closing the last normal window is refused.
11. A claim blocks a window-scoped mutation from another session.
12. A claim does not block `snapshot` from another session.
13. `force` overrides an active claim.
14. An expired lease no longer blocks another session (rewrite session storage, restart).
15. Names, purposes, and claims survive a service-worker restart.
16. `browser_tabs` filters by `windowId`.
17. `resize({tabId})` is refused when that tab's window is claimed by another session.
18. `open-tab` without `windowId` lands in the connected tab's window and is refused
    when that window is claimed by another session.
19. `move-tab` checks the source window as well as the destination.
20. `reuseExisting` with `claim: true` claims an unclaimed window; without `claim`, it
    leaves ownership unchanged.
21. An owner's successful mutation extends `leaseUntil` (rewrite session storage,
    restart, perform a window-scoped action, compare).

### MCP tests (`mcp.test.mjs`)

- All four new tools appear in `tools/list`.
- `browser_windows` is read-only.
- `browser_open_window` requires `url`; rejects an unknown argument.
- `browser_update_window` requires `windowId`; rejects an invalid `state`.
- `browser_resize` with both `tabId` and `windowId` returns -32602.
- `browser_tabs` accepts `windowId`.

### Controller and native-host tests

- Controller maps the new commands and errors clearly in fallback mode.
- Native host forwards `sessionId` and caps its length.

### Live verification (manual, after extension reload)

1. Create two windows with different bounds and different names.
2. Evaluate `innerWidth` / `innerHeight` in each via explicit `tabId`; confirm they
   differ.
3. Resize one by `windowId`; confirm the other is unchanged.
4. From a second controller process with a different
   `KENNECT_BROWSER_SESSION_ID`, attempt the same resize; confirm the refusal.
5. Confirm `snapshot` still works from the second session.
6. Release or close the task windows; confirm no user window is affected.

## Rollout

- Version 0.4.0 in `package.json`, `package-lock.json`, `extension/manifest.json`,
  `server.mjs` `serverInfo`, and the extension hello test.
- No new manifest permissions.
- Update README feature list, known limitations, and usage examples.
- Add a "Windows and claims" section to `skills/kennect-browser/SKILL.md`.
- After merge, comment on issue #4 with the shipped behavior and close it.

## Decisions made in this design

- Full window lifecycle, not a `newWindow` flag.
- Names and claims live in extension session storage; Chrome has no native name.
- No password. Claims use the caller's session ID with a renewable lease.
- Enforcement covers window-scoped mutations only, not page reads.
- Inline code in `worker.js`; no new extension module.
- `focused` defaults to `false` for new windows.
- `reuseExisting` defaults to `false`.
- Default lease 30 minutes; range 1 minute to 24 hours.
- `browser_close_window` is limited to tool-created windows and refuses the last normal
  window.
- Enforcement covers window-scoped mutations only, not page reads. Implicit target
  windows are resolved and checked too, so omitting `windowId` does not bypass a claim.
- `open-tab` without `windowId` opens in the connected tab's window, else the last
  focused normal window, instead of relying on Chrome's implicit current window.
- `reuseExisting` with `claim: true` claims or renews an unclaimed window; without
  `claim`, existing ownership is unchanged.
- Every successful owner window-scoped mutation renews the lease.
- `force` exists only on `browser_update_window` and `browser_close_window`; the other
  window tools use the generic conflict message.
- Version 0.4.0.

## Left to the builder

- Exact helper layout inside `worker.js`.
- Fake-chrome fixture shape and test ordering.
- Exact error wording beyond the required facts (window ID, name, owner, expiry).
- Whether to add a popup indicator for named windows (not required).
- Live-verification script details.
