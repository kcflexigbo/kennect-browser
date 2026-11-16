# Browser Ensure: launch and connect the user's Chrome

Date: 2026-11-16
Status: Draft for approval
Related: window lifecycle 0.4.0 (`docs/superpowers/specs/2026-11-16-window-lifecycle-design.md`)

## Intent and why

The window lifecycle tools run inside the Chrome extension. If Chrome is closed,
there is no extension runtime, so `browser_open_window` cannot create a window.
`browser_start` launches only the dedicated fallback profile at
`~/.kennect-browser/profile`, which has no extension and therefore no window tools.

`browser_ensure` closes that gap: it makes sure the user's real Chrome — their
profile, sign-ins, and extension — is running and connected, launching Chrome when
necessary, so the window tools have a target. It is an explicit, authorized action,
not an automatic background launch.

## Goals

1. If a responsive extension profile already exists, return it without launching
   anything. Reuse is browser-agnostic; only launching is Chrome-only.
2. If none exists, discover Chrome's profiles and identify those where the Kennect
   Browser extension is installed and enabled.
3. Choose the last-used profile that has the extension, falling back to recent
   extension-enabled profiles, and fail before launching when none has it.
4. Launch Chrome into that profile's user-data-dir and profile directory, opening
   `about:blank`.
5. Poll the native bridge until a responsive extension profile appears, up to a
   bounded timeout.
6. Return the connected profile(s), the extension version, and whether Chrome was
   launched; warn when the extension version does not match the server.
7. Work from both the MCP tool and the CLI controller.
8. Require explicit user authorization and make the visible-browser side effect
   clear in the tool description.

## Non-goals

- No automatic launch on server startup, a timer, or a tool call other than
  `browser_ensure`.
- No bypassing a paused or disconnected extension. The tool cannot click Connect.
- No incognito, guest, temporary, or dedicated fallback profile.
- No launching Edge, Brave, or Chromium in v1; an already-connected Edge/Brave
  profile may still be reused.
- No custom `--user-data-dir`, Chrome Beta, Canary, or SxS support in v1; the
  default stable Chrome user-data dir is the only store scanned.
- No Windows Store or portable Chrome variants.
- No closing or restarting Chrome.
- No creating the managed window inside `browser_ensure`; the caller uses
  `browser_open_window` after it returns.
- No automatic extension reload after an update; the tool warns instead.
- No session restore, user-supplied startup URL, or cookie/profile extraction.
- No changes to Chrome settings, the default profile, or the extension's stored
  configuration.

## Anti-goals

- Launching a profile that does not have the extension enabled.
- Launching without the user's authorization.
- Reporting a connected profile when none appeared.
- Retrying launches in a loop.
- Falling back silently to the dedicated profile.
- Reading or returning account emails, cookies, or profile preference contents
  beyond the profile directory and display name needed for selection.
- Passing user URLs or restoring prior tabs during launch.

## Current state and constraints

- `start.mjs` locates Chrome and launches the dedicated profile. Its executable
  candidates are reusable, but its behavior is not: it must keep launching the
  dedicated profile, not the personal one.
- `profiles.mjs` already knows the platform default user-data directories and can
  detect a browser from a running process. Its `defaultUserDataDir` helper is
  currently private.
- Chrome's `<user-data-dir>/Local State` contains:
  - `profile.last_used` — the profile Chrome would open by default;
  - `profile.last_active_profiles` — a recent-profile list;
  - `profile.info_cache` — per-directory `name` and `active_time`.
- The extension entry lives in `<profile>/Secure Preferences` under
  `extensions.settings[<extension-id>]`. On the development machine, three profiles
  carry it there with `location: 4` (unpacked) and the path pointing at this
  checkout. `Preferences` is checked as a fallback because the file location is a
  Chrome implementation detail.
- The extension ID is stable and stored in `extension-id.txt`
  (`bbnpijhhjbmhblobjckieabgmngeicbg`), pinned by the manifest `key`.
- An entry is treated as enabled when it exists, `state` is not `0`, and
  `disable_reasons` is absent or empty. A missing `state` means enabled.
- The extension auto-connects on Chrome startup through
  `chrome.runtime.onStartup` unless the user previously paused it
  (`autoConnect: false`) or the extension is disabled.
- The native host must already be registered by setup. The bridge directory and
  native messaging path are unchanged.
- Chrome executable candidates, matching `start.mjs`:
  - Windows: `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`,
    `%ProgramFiles%\Google\Chrome\Application\chrome.exe`,
    `%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe`;
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
  - Linux: `/usr/bin/google-chrome`, `/usr/bin/chromium`,
    `/usr/bin/chromium-browser`.
- `spawn` must use `detached: true`, `stdio: "ignore"`, and `unref()`.
- Launch arguments: `--user-data-dir=<base>`, `--profile-directory=<dir>`,
  `--new-window`, `--no-first-run`, `--no-default-browser-check`, `about:blank`.
- If Chrome is already running, a second launch is handed to the existing process
  and usually opens a window; it does not fire `runtime.onStartup`. A paused or
  disconnected extension therefore cannot be revived by launching.
- The bridge probe is `listProfiles({probeTimeoutMs: 1000})`. Poll every 500 ms.
- Default timeout 30 s; accepted range 5–60 s.
- The server and extension versions are kept in sync. This feature bumps them to
  0.5.0.
- `server.mjs` runs controller children with a fixed 15 s timeout. `browser_ensure`
  must use a per-call timeout of `timeoutMs + 5000` (maximum 65000) or the wait
  will be killed before the designed timeout message. A batched `browser_ensure`
  call goes through the same inner path and gets the same timeout.

## Approaches considered

### 1. New `browser_ensure` tool, `ensure.mjs`, and discovery in `profiles.mjs` (chosen)

`profiles.mjs` exposes profile discovery and exports the existing default
user-data-dir helper. A new `ensure.mjs` orchestrates reuse, selection, launch, and
polling with injected dependencies. `controller.mjs` gains an `ensure` command that
runs locally; `server.mjs` exposes `browser_ensure`.

Clean separation from the dedicated fallback, testable without Chrome, and one
discoverable tool. Costs a new module and one more tool.

### 2. Extend `browser_start` with `target: "personal"`

Fewer tools, but `browser_start` means the isolated fallback today. Overloading it
risks an agent launching the personal browser when it expected the dedicated one.
`start.mjs` is also a script without test seams. Rejected.

### 3. Launch inside `browser_open_window`

One call, but mixes a Node-side process launch into an extension-only tool, makes a
launch failure look like a window-tool failure, and complicates authorization and
testing. Rejected.

## Design

### Module boundaries

- `profiles.mjs`
  - Export `defaultUserDataDir(browser, {platform, home, env, exePath})` (already
    implemented privately).
  - Add `chromeProfiles({userDataDir, readFile})`:
    - reads `Local State`;
    - returns `{lastUsed, lastActive, profiles}` where each profile is
      `{directory, name, activeTime, extensionEnabled, extensionPath}`;
    - reads `Secure Preferences` first, then `Preferences`, for the extension ID;
    - ignores unreadable or malformed files per profile rather than failing the
      whole scan;
    - throws only when `Local State` is missing or unparseable.
  - Add `chooseExtensionProfile(scan)`:
    - `lastUsed` if its profile has `extensionEnabled`;
    - else the first extension-enabled directory in `lastActive`;
    - else the extension-enabled profile with the highest `activeTime`;
    - else `null`.
- `ensure.mjs`
  - `ensureBrowser({profileDirectory, timeoutMs, listProfilesImpl, spawnImpl,
    chromeProfilesImpl, chromeExecutableImpl, sleep, now})` returns:
    ```json
    {
      "launched": true,
      "profileId": "chrome:…:…",
      "browser": "chrome",
      "label": "…",
      "profileDirectory": "Default",
      "extensionVersion": "0.5.0",
      "profiles": [ … ],
      "warning": "…"
    }
    ```
  - `profiles` is always the bridge listing from `listProfiles`, never the scan
    result. The top-level fields describe the chosen profile.
    ```
  - Steps:
    1. `listProfiles()` and record every responsive profile ID in a pre-launch
       snapshot. If a responsive profile exists:
       - without `profileDirectory`, choose the persisted default profile when it
         is responsive, else the first responsive profile by `profileId`. Return
         it with `launched: false`; do not scan `Local State`.
       - with `profileDirectory`, return the responsive profile whose normalized
         metadata `profileDirectory` matches; if none matches, continue to launch
         the requested profile.
    2. Resolve the default stable Chrome user-data-dir and scan profiles.
    3. If `profileDirectory` is supplied, select that profile; otherwise
       `chooseExtensionProfile`.
    4. If the selected profile is missing or lacks the extension, throw before
       launching. The message lists the checked profile directories and says to
       load/enable the extension in `chrome://extensions`; it also notes that a
       custom `--user-data-dir`, Beta, Canary, or SxS install is not supported in
       this version.
    5. Locate Chrome; throw with the attempted paths if not found.
    6. Spawn Chrome detached with the launch arguments.
    7. Poll `listProfiles()` every 500 ms until the timeout. Success requires a
       responsive profile that either:
       - matches the requested/selected directory by normalized
         `metadata.profileDirectory` (preferred), or
       - has a `profileId` absent from the pre-launch snapshot.
       A pre-existing unrelated responsive profile must never satisfy the poll.
       If several qualify, prefer the directory match, then the first new
       `profileId`. If only a new profile ID qualifies (Chrome was already running
       and identity detection did not report the directory), use it and add an
       identity-not-confirmed note to `warning`.
    8. Warn when the chosen profile's `extensionVersion` differs from the
       server's `package.json` version.
  - Errors are actionable:
    - no extension-enabled profile: fail before launch;
    - Chrome missing: list attempted paths;
    - spawn failure: include the OS error;
    - timeout: "Chrome was launched, but the Kennect Browser extension did not
      connect within N seconds. Open the extension in that profile and click
      Connect; check that it is not paused or disabled."
- `controller.mjs`
  - `ensure` runs before the bridge/dedicated-browser path and prints the JSON.
  - It does not require a connected profile.
  - On failure, prints the message to stderr and exits nonzero.
- `server.mjs`
  - New tool `browser_ensure`:
    - arguments: `{profileDirectory?: string, timeoutMs?: integer}`;
    - `profileDirectory` 1–100 characters, no control characters;
    - `timeoutMs` 5000–60000;
    - no automatic `profile` argument (add to the `tool()` exclusion list with
      `browser_start`, `browser_batch`, `browser_profiles`,
      `browser_set_default_profile`);
    - not read-only; description states it opens a visible browser and requires
      explicit user authorization;
    - command map entry `browser_ensure: ['ensure', JSON.stringify({profileDirectory, timeoutMs})]`.
  - Extend the MCP `instructions` string: "If no browser profile is connected and
    the user authorizes opening their browser, call browser_ensure; it launches the
    last-used Chrome profile that has the Kennect extension and waits for it."
  - Bump `serverInfo.version` and `package.json` to 0.5.0.

### Selection detail

`last_active_profiles` is a list of directories. The scan preserves its order.
`active_time` is Chrome's seconds-since-1601 value; it is compared numerically and
never displayed.

If `profileDirectory` is supplied and the profile has the extension but is not the
last used, it wins: the caller asked for it explicitly. If it lacks the extension,
fail; do not silently choose another profile.

### Reuse behavior

A responsive bridge profile is proof that a Chromium browser and the extension
are already connected, regardless of which browser or profile it is. Without an
explicit `profileDirectory`, `browser_ensure` chooses the persisted default when
it is responsive, else the first responsive profile by `profileId`, returns it,
and does not launch. Reuse is browser-agnostic; the top-level `browser` and
`label` reflect the chosen profile. With an explicit directory, an exact
normalized `metadata.profileDirectory` match is required; otherwise the tool
treats the request as "launch this profile" and proceeds.

### Version warning

The ensure module reads `package.json` once. If the connected extension version is
older or newer than the server version, it returns:
`"Connected extension 0.4.0 does not match server 0.5.0. Reload the extension in chrome://extensions."`
The warning does not fail the call; the window tools may still work.

### User-data-dir scope

v1 scans only the default stable Chrome user-data directory for the current
platform. A custom `--user-data-dir`, Chrome Beta, Canary, or SxS installation is
not supported; the no-extension error names that limitation. A future version can
add an explicit `userDataDir` argument.

### Privacy

- Profile discovery reads `Local State`, `Preferences`, and `Secure Preferences`.
- It returns profile directories, display names, extension presence, and active
  times. It never returns account emails, cookies, or preference contents.
- The existing `browser_profiles` output already exposes the extension's profile
  label (which may be an account email); `browser_ensure` reuses that listing.

### Authorization and safety

- The tool description: "Ensure a personal Chrome profile is running and connected.
  If none is connected, launch the last-used Chrome profile that has the Kennect
  Browser extension, open about:blank, and wait for the extension. This opens a
  visible browser window; obtain explicit user authorization first."
- The tool is marked destructive per the existing helper.
- One launch attempt per call. No retry loop.
- `about:blank` only; no user URL or session restore.
- No incognito or temporary profile.
- The dedicated `browser_start` behavior is unchanged.

## Testing plan

### `profiles.test.mjs`

Fixture user-data directories built in temp folders:

1. `Local State` with two profiles and `last_used` set: chooses the last-used one
   when it has the extension.
2. Last-used lacks the extension: falls back to the extension-enabled profile in
   `last_active_profiles`.
3. No `last_active_profiles` match: falls back to the highest `active_time`.
4. Extension entry only in `Secure Preferences`: detected.
5. Entry with `state: 0` or non-empty `disable_reasons`: not enabled.
6. No profile has the extension: `chooseExtensionProfile` returns null.
7. Malformed per-profile preference file: that profile is skipped, the scan
   survives.
8. Missing `Local State`: clear error.

### `ensure.test.mjs`

Injected `listProfilesImpl`, `spawnImpl`, `chromeProfilesImpl`,
`chromeExecutableImpl`, and `sleep`:

1. Responsive profile exists: returns `launched: false`, never spawns.
2. Responsive profile matches a requested `profileDirectory`: returns it.
3. No responsive profile, extension profile found: spawns once with the expected
   executable and arguments, polls, returns `launched: true`.
4. No extension-enabled profile: throws before spawning.
5. Requested `profileDirectory` lacks the extension: throws before spawning.
6. Chrome executable missing: lists the attempted paths.
7. Spawn error: surfaces the error.
8. Timeout: reports that Chrome was launched and the extension did not connect.
9. Extension version mismatch: returns the warning.
10. `chooseExtensionProfile` ordering is covered in `profiles.test.mjs`.
11. The spawn call uses `--user-data-dir`, `--profile-directory`, `--new-window`,
    `--no-first-run`, `--no-default-browser-check`, and `about:blank`.
12. A pre-existing unrelated responsive profile does not satisfy the post-launch
    poll; the requested profile must connect.
13. A new profile ID with no matching directory is accepted with an identity
    warning.
14. Multiple responsive profiles on reuse: the persisted default is chosen when
    responsive, else the first by `profileId`.
15. An Edge/Brave responsive profile is reused and reported with its browser.
16. No extension-enabled profile: the error names the custom user-data-dir,
    Beta, Canary, and SxS limitation.

### `mcp.test.mjs`

- `browser_ensure` appears in `tools/list`.
- It does not receive an automatic `profile` property.
- `profileDirectory` and `timeoutMs` validate; an unknown argument is rejected.
- The tool is not read-only.

### Controller

- `controller.test.mjs` asserts `ensure` is routed locally and rejects an invalid
  `timeoutMs` without launching. A spawn-free dry path is provided by passing a
  malformed `timeoutMs`.
- Live launch behavior is verified manually; unit tests inject the spawn.

### Live verification (manual)

1. With Chrome **open and connected**: `node controller.mjs ensure` returns
   `launched: false` and the connected profile.
2. With Chrome **closed**: `node controller.mjs ensure` launches Chrome into the
   last-used extension profile, waits, and returns `launched: true` with the
   connected profile. Confirm the extension is 0.5.0 or the warning names the
   mismatch.
3. Then run `node controller.mjs windows`, `open-window`, and `close-window` against
   the launched browser.
4. If the extension was paused, confirm the timeout message explains how to
   reconnect.

If Chrome is unavailable or the user cannot close it during execution, report the
launch path as not run rather than claiming it passed.

## Rollout

- Version 0.5.0 in `package.json`, `package-lock.json`, `extension/manifest.json`,
  `server.mjs` `serverInfo`, and the extension hello test.
- README: add the `ensure` usage and distinguish it from `browser_start`.
- `skills/kennect-browser/SKILL.md`: add a "Starting a closed browser" section —
  call `browser_ensure` only with user authorization; it opens the visible personal
  browser; if it times out, ask the user to click Connect rather than retrying.
- After merge, comment on the window-lifecycle work if relevant; no new issue
  required unless the user wants one.

## Decisions made in this design

- Tool name `browser_ensure`; `browser_start` remains the dedicated fallback.
- Launching is Chrome-only in v1; an already-connected Edge/Brave profile may be
  reused.
- Target selection: last-used extension-enabled profile, then recent extension
  profiles, then newest `active_time`, else fail before launching.
- Optional `profileDirectory` override; no `profileId` input.
- Reuse any responsive profile when no directory is requested, choosing the
  persisted default when responsive, else the first by `profileId`.
- Post-launch success requires a normalized directory match or a new profile ID;
  a pre-existing unrelated responsive profile never satisfies the poll.
- Server child timeout for `browser_ensure` is `timeoutMs + 5000`, maximum 65000.
- v1 scans only the default stable Chrome user-data-dir; custom directories and
  Beta/Canary/SxS are deferred.
- The result has no `profileName`; it reports `profileId`, `label`, `browser`, and
  `profileDirectory`.
- Open `about:blank`; no session restore or user URL.
- One launch attempt; no retry loop.
- Default timeout 30 s; range 5–60 s.
- Warn on extension/server version mismatch; do not fail.
- New `ensure.mjs` module with injected dependencies; discovery in `profiles.mjs`.
- Version 0.5.0.

## Left to the builder

- Exact function signatures inside `ensure.mjs` and the fixture builder in
  `profiles.test.mjs`.
- Error wording beyond the required facts (profile directories, attempted paths,
  timeout, version mismatch, identity not confirmed).
- Server-side child timeout wiring for `browser_ensure`.
- Whether to expose `ensure` as a CLI-only dry run (not required).
- Platform-specific process cleanup; the launched Chrome is intentionally detached
  and must survive the Node process.
- Exact live-verification commands and Chrome close/reopen steps.
