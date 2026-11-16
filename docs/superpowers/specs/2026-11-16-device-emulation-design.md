# Device Emulation

Date: 2026-11-16
Status: Draft for approval
Related: window lifecycle 0.4.0, browser ensure 0.5.0

## Intent and why

Window resizing cannot produce exact mobile viewports. Chrome clamps the outer window
width to roughly 500 CSS px inner at 100% scaling, and window bounds include browser
chrome. The DevTools device toolbar solves this with CDP emulation, not window sizing.

Kennect Browser already attaches `chrome.debugger` to connected tabs for snapshots,
input, and screenshots. `browser_emulate_device` will apply per-tab CDP device metrics,
giving exact `innerWidth`/`innerHeight`, device pixel ratio, mobile layout, touch
events, an optional mobile user agent, and orientation — independent of the real
window. Two tabs, even in one window, can hold different viewports.

Per-tab is the chosen model: it mirrors the DevTools device toolbar, gives the most
control, and lets parallel agents audit different viewports without fighting over a
window.

## Goals

1. Apply an exact viewport to one connected HTTP(S) tab:
   `width`, `height`, `deviceScaleFactor`, `mobile`, `touch`, optional `userAgent`,
   optional `orientation`.
2. Return the applied metrics so the agent can verify and convert screenshot
   coordinates.
3. Clear the emulation on request and restore the real viewport.
4. Persist the requested emulation in session storage and reapply it when the
   debugger reattaches after a service-worker restart.
5. Remove stored emulation when the tab closes or the user explicitly disconnects.
6. Enforce an active window claim for emulation start and clear on tabs in that
   window, so another agent cannot change a claimed window's viewport.
7. Report active emulation per tab in `browser_tabs`.
8. Work from MCP and the CLI controller.
9. Verify the path live in real Chrome.

## Non-goals

- No built-in device-preset table in v1; callers pass exact dimensions. Presets can be
  added later.
- No real device fingerprint, GPU, OS, or browser-engine emulation. This changes the
  layout viewport and selected web-platform inputs, not the device identity.
- No network throttling, geolocation, permissions, dark-mode/media-feature emulation,
  or CPU throttling.
- No per-tab claims or locks. Window claims remain the coordination unit.
- No changing the real Chrome window size. Window resize and viewport emulation are
  independent.
- No automatic emulation of new tabs or every tab in a window.
- No CDP-fallback support in v1; like groups, downloads, and windows, this requires
  the extension.
- No mobile user agent unless explicitly requested.
- No emulation of internal pages or local files.
- No guaranteed restoration after a Chrome crash or extension reload; the stored
  state is session-scoped and reapplied when the debugger reattaches.

## Anti-goals

- Silently resizing the window instead of emulating.
- Reporting an emulated viewport when the CDP override failed.
- Applying emulation to the wrong tab or a tab in another session's claimed window.
- Losing the requested emulation silently after a worker restart.
- Blocking page reads while a tab is emulated.
- Spoofing a mobile user agent without an explicit request.
- Leaving an override active without reporting it in `browser_tabs`.

## Current state and constraints

- `extension/worker.js` attaches `chrome.debugger` per tab through `ensureAttached`,
  tracks `attached`, and exposes `cdp(tabId, method, params)`.
- `chrome.debugger.onDetach` clears `attached`, `watching`, `requests`, console state,
  and recordings for the tab.
- `chrome.storage.session` persists state across service-worker restarts and is
  cleared on browser restart or extension reload. Window claims already use it.
- `browser_tabs` lists allowed tabs with tab and group metadata.
- `browser_screenshot` returns a PNG; with emulation, the image dimensions are
  `width × deviceScaleFactor` by `height × deviceScaleFactor`.
- Input and zoom coordinates are CSS viewport pixels. With `deviceScaleFactor > 1`,
  screenshot pixels are scaled relative to those coordinates.
- CDP methods:
  - `Emulation.setDeviceMetricsOverride({width, height, deviceScaleFactor, mobile,
    screenOrientation?})`
  - `Emulation.clearDeviceMetricsOverride`
  - `Emulation.setTouchEmulationEnabled({enabled, maxTouchPoints?})`
  - `Emulation.setEmitTouchEventsForMouse({enabled, configuration?})`
  - `Emulation.setUserAgentOverride({userAgent})` (no clear command; restore the
    original user agent captured at start)
- The extension's manifest has the `debugger` permission; no new permission is needed.
- Window claims live in `windowRegistry`; the emulation state will live in a separate
  `emulations` map in the same session storage.

## Approaches considered

### 1. New per-tab emulation tools (chosen)

`browser_emulate_device` and `browser_clear_device_emulation`, applied to one tab.
State is keyed by tab ID, persisted in session storage, and reapplied on reattach.

Mirrors the DevTools device toolbar, allows different viewports in one window, and
gives explicit dimensions plus mobile/touch/UA/orientation. Costs two tools and a
small state machine.

### 2. Window-scoped emulation

One call applies the same metrics to every connected tab in a window. Simpler mental
model, but tabs cannot differ, and the implementation must iterate tabs and handle
partial failures. It also duplicates the window model instead of complementing it.
Rejected.

### 3. Extend `browser_resize` with `emulate: true`

Fewer tools, but conflates real window resizing with viewport emulation. The two have
different targets, state, clearing behavior, and screenshot consequences. Rejected.

## Design

### Tools

#### `browser_emulate_device`

Arguments (plus the automatic `profile`):

| Argument | Type | Required | Rules |
|---|---|---|---|
| `tabId` | string | no | Defaults to the connected tab; must be a connected HTTP(S) tab |
| `width` | integer | yes | 100–4000 CSS px |
| `height` | integer | yes | 100–4000 CSS px |
| `deviceScaleFactor` | number | no | 1–4; default 1 |
| `mobile` | boolean | no | Default `false` |
| `touch` | boolean | no | Default `false`; enables touch and mouse-to-touch |
| `userAgent` | string | no | 1–500 chars; when omitted, no UA override |
| `orientation` | string | no | `portraitPrimary`, `portraitSecondary`, `landscapePrimary`, `landscapeSecondary` |

Result JSON:

```json
{
  "tabId": "252390366",
  "width": 390,
  "height": 844,
  "deviceScaleFactor": 3,
  "mobile": true,
  "touch": true,
  "userAgent": "…",
  "orientation": "portraitPrimary",
  "applied": true
}
```

- Replaces the tab's previous emulation state; omitted optional fields take their
  defaults rather than merging.
- Captures the extension's own `navigator.userAgent` as the restoration target. It is
  the real browser UA and is not spoofed by a prior page override; the page's UA is
  never read for this.
- Applies metrics first, then touch, then UA. On any failure, attempts a best-effort
  clear and throws; no stored state is left behind.

### Re-emulation semantics

A call replaces the tab's emulation state; omitted optional fields take their
defaults rather than merging.

- If a previous UA override is active and the new call omits `userAgent`, restore the
  original UA before applying the new metrics, so no unreported spoof remains.
- If a new `userAgent` is supplied, reuse the existing `originalUserAgent` when one is
  stored; otherwise use the extension's `navigator.userAgent`. Never recapture from
  the page, because after an override that would capture the spoof.
- The original UA is stored once per emulation state so clear can restore it.

#### `browser_clear_device_emulation`

Arguments: `{tabId?}`. Always clears metrics, disables touch and mouse-to-touch, and
restores the original UA when one was captured. Deletes the stored state. Returns
`{"tabId":"…","cleared":true}`.

### State and persistence

`chrome.storage.session` key `emulations`:

```json
{
  "252390366": {
    "width": 390,
    "height": 844,
    "deviceScaleFactor": 3,
    "mobile": true,
    "touch": true,
    "userAgent": "…",
    "orientation": "portraitPrimary",
    "originalUserAgent": "…"
  }
}
```

- Loaded once at worker startup alongside the window registry.
- `emulationApplied` is an in-memory `Set` of tab IDs currently overridden.
- The worker has an attach-only step and a page-action resolver that attaches, then
  applies stored emulation when the tab is not in `emulationApplied`. If reapplication
  fails, the page action fails with a clear error and the stored state is kept for a
  later retry; it is not silently dropped.
- Emulation commands use the attach-only resolver, assert the window claim, and then
  apply or clear explicitly. They never reapply old state before the claim check.
- `chrome.debugger.onDetach` removes the tab from `emulationApplied` but keeps the
  stored state, so the next action after reattach reapplies it.
- `chrome.tabs.onRemoved` deletes the stored state and the applied marker.
- The popup `disconnect` action clears the `emulations` storage and applied set,
  because the debugger detach resets the overrides.
- Browser restart or extension reload clears session storage; emulation is not
  restored across those events.

### Claims

- Emulation commands resolve and attach the tab without reapplying stored state, then
  `assertWindowAccess(t.windowId, sessionId)` before applying or clearing.
- Reapplying stored emulation during an ordinary page action is restoration of the
  tab's intended state, not a new viewport mutation. Page reads remain available and
  may trigger that restoration after a detach or worker restart. A claim blocks new
  emulation starts and clears, not the restoration itself.
- Page reads, snapshots, screenshots, and evaluation remain available while emulated.
- The claim's renewal behavior is unchanged; emulation does not renew a lease.

### Reporting

`browser_tabs` adds two fields to each tab:

```json
{
  "emulation": {"width":390,"height":844,"deviceScaleFactor":3,"mobile":true,
                "touch":true,"userAgent":"…","orientation":"portraitPrimary"},
  "emulationActive": true
}
```

- `emulation` is the persisted requested state; it survives a detach or service-worker
  restart.
- `emulationActive` is true only when the override is currently applied in this
  worker. After a detach or restart it is false until the next action reapplies it.
- `browser_tabs` is read-only: it does not attach or reapply.
- `originalUserAgent` is never returned. Tabs without emulation report
  `emulation: null` and `emulationActive: false`.

### Screenshots and coordinates

- `browser_screenshot` captures the emulated viewport. With DPR 3 and 390×844, the
  PNG is 1170×2532.
- `browser_mouse` and `browser_zoom` coordinates are CSS viewport pixels. To convert
  screenshot pixels, divide by `deviceScaleFactor`.
- The skill will state this explicitly; `browser_emulate_device` returns the DPR.

### Errors

| Case | Result |
|---|---|
| Tab is internal or local | Existing "cannot be controlled" error |
| Tab is not connected | Existing Connect prompt |
| Another session's claim on the tab's window | Claim-conflict error |
| Invalid width/height/DPR/orientation | Error before any CDP call |
| CDP apply failure | Best-effort clear, then error; no stored state |
| Clear failure | Error; stored state is removed so it is not silently reapplied |
| No emulation state on clear | Clear commands still run; returns `cleared: true` |
| CDP fallback | "requires the Kennect Browser extension" |

## Testing plan

### Extension tests (`extension.test.mjs`)

Extend the fake debugger to record `{method, params}`. Add tests:

1. Emulate applies `Emulation.setDeviceMetricsOverride` with exact width, height, DPR,
   mobile, and no orientation when omitted.
2. `touch: true` adds `setTouchEmulationEnabled` and `setEmitTouchEventsForMouse`;
   `touch: false` disables both on apply.
3. `mobile: true` passes through; default `mobile: false`.
4. Orientation maps to the correct `screenOrientation` type and angle.
5. `userAgent` uses the extension's `navigator.userAgent` as the restoration target
   and applies `setUserAgentOverride`; clear restores it.
6. Clear calls `clearDeviceMetricsOverride`, disables touch and mouse-to-touch, and
   restores the captured UA.
7. A clear with no stored state still clears.
8. Validation rejects width/height/DPR/orientation and control characters in UA
   before any CDP call.
9. A claim blocks another session's emulate and clear; the owner and an unclaimed
   window are allowed.
10. Snapshots and evaluation still work on an emulated tab.
11. `browser_tabs` reports the emulation fields and `null` otherwise.
12. Service-worker restart: emulate, restart, perform a tab action, and assert the
    metrics are reapplied from session storage.
13. `chrome.tabs.onRemoved` removes the stored state.
14. A CDP failure during apply attempts a clear and throws; no state remains.
15. Disconnect clears the emulation store.
16. Re-emulation without a `userAgent` restores the original and removes the override.
17. `browser_tabs` reports `emulation` with `emulationActive:false` after a restart and
    `true` after reapply.
18. A failing reapply during a page action throws and keeps the stored state; clear
    still succeeds through the attach-only path.

### MCP tests (`mcp.test.mjs`)

- Both tools appear; both accept `profile`.
- `width`/`height` are required; `deviceScaleFactor` range; orientation enum.
- Unknown arguments are rejected with -32602.

### Controller tests (`controller.test.mjs`)

- `emulate-device` and `clear-emulation` require the extension in fallback mode.
- Invalid JSON/options exit nonzero without touching Chrome.

### Live verification (manual)

1. Open a connected tab.
2. Emulate 390×844 at DPR 3, mobile, touch.
3. Evaluate `innerWidth`, `innerHeight`, `devicePixelRatio`; expect 390, 844, 3.
4. Screenshot; expect a 1170×2532 PNG.
5. Emulate a second tab at 1440×1000 in the same window; verify each tab keeps its own
   viewport.
6. From another session, attempt to emulate a tab in a claimed window; expect refusal.
7. Snapshot from the other session; expect success.
8. Clear both; verify `innerWidth` returns to the real window viewport.

If Chrome is unavailable, report the live steps as not run.

## Rollout

- Version 0.6.0 in `package.json`, both `package-lock.json` fields,
  `extension/manifest.json`, `server.mjs` `serverInfo`, and the extension hello test.
- README: add the two tools, usage examples, and replace the "no exact viewport"
  limitation with "window resize is clamped; use device emulation for exact
  viewports."
- SKILL.md: add a "Device emulation" section covering per-tab scope, exact viewport
  verification, DPR screenshot conversion, clearing, claims, and the reason to prefer
  it over `browser_resize`.
- Update `browser_resize` and `browser_screenshot` descriptions to point at
  emulation/DPR behavior.

## Decisions made in this design

- Per-tab emulation, not window-scoped.
- Explicit dimensions; no preset table in v1.
- Optional UA, touch, orientation; defaults 1 DPR, desktop, no touch, no UA.
- The original UA is the extension's `navigator.userAgent`, never the page's.
- Re-emulation replaces state; omitting `userAgent` removes a previous override.
- State in session storage, reapplied after debugger reattach; cleared on tab close
  and explicit disconnect.
- A failed reapply fails the page action and keeps the stored state. Emulation
  commands use an attach-only resolver so clear always remains reachable.
- Reapply is restoration of intended state, not a claim-checked viewport mutation.
- `browser_tabs` reports the requested state plus `emulationActive`; it is read-only.
- Window claims enforced for emulation start/clear.
- Extension-only; CDP fallback errors.
- Version 0.6.0.

## Left to the builder

- Exact helper names and fixture builders in `extension.test.mjs`.
- Error wording beyond the required facts.
- Whether to add a `browser_viewport` read tool (not required; evaluate covers it).
- Exact attach-only resolver naming and its page-action contract.
- Live verification commands and cleanup.
