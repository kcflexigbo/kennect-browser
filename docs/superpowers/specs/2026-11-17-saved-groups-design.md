# Saved Chrome tab groups — design

Issue: #10
Date: 2026-11-17
Status: draft (builder check pending)

## Intent

Agents create tab groups, finish, and close their tabs. Chrome can keep those
groups as saved tab groups in bookmarks. `browser_groups` only sees live
`chrome.tabGroups`, and `browser_tabs` only sees live tabs, so saved groups
accumulate invisibly. Reading the Bookmarks file from the agent is blocked on
macOS without Full Disk Access. Add a read-only `browser_saved_groups` surface
that lists saved groups from the connected Chrome profile, with no new
extension permission and no network traffic.

## Goals

- Add the `browser_saved_groups` MCP tool and the controller `saved-groups`
  command.
- List saved groups with name, color, tabs (title and URL), and a stable
  folder/id reference. Work when none of the group's tabs are open.
- Read the connected Chrome profile's local `Bookmarks` file through the
  native host; do not add the extension `bookmarks` permission.
- Return a clear error when the file is missing, unreadable, or malformed.
- Keep all titles/URLs local; never send them anywhere or log them.
- Document the limits and add tests.

## Non-goals

- Deleting or renaming saved groups. A follow-up would need the `bookmarks`
  permission or careful Bookmarks-file writes.
- Classifying ordinary bookmark folders as saved groups.
- Live/open-tab annotation. Use `browser_tabs` for that in v1.
- Other browsers or profiles beyond the connected/selected profile.
- Durable audit logs.

## Constraints

- `chrome.bookmarks` exposes no `meta_info`, no saved-group `folderType`, and
  no color; `chrome.tabGroups` covers only live groups. A bookmark-tree walk
  through the extension API cannot identify saved groups.
- The native host resolves `metadata.userDataDir` and
  `metadata.profileDirectory` from the Chrome process chain
  (`detectBrowserIdentity`). It can read
  `<userDataDir>/<profileDirectory>/Bookmarks` on Windows.
- macOS TCC: the native host is a child of Chrome, so it may inherit Chrome's
  access to its own profile, but macOS 27 adds MACL protection around
  Chrome/Firefox profile directories. This must be tested; no Full Disk
  Access is requested or promised.
- The registry/extension state is session-scoped; the native host command is
  local and read-only.
- Response caps: 500 saved groups and 10,000 tabs.
- No new dependencies.

## Approaches

1. **Native-host local reader (chosen).** Read the real Bookmarks JSON, parse
   the saved-group metadata, and respond over the existing local socket. Exact
   data, no extension permission, works on Windows. macOS TCC is the risk.
2. **`chrome.bookmarks` folder listing.** Add the `bookmarks` permission and
   walk the tree. It can list folders but cannot identify saved groups or
   colors; it would be a generic bookmark-folder browser. Rejected for v1.
3. **Kennect-owned registry.** Record groups Kennect creates and list those
   after the tabs close. Reliable for future Kennect groups, but it cannot
   clean the existing backlog or see groups from other tools. Not sufficient
   as the primary surface.

## Design

### Flow

`browser_saved_groups` → server command `saved-groups` → controller
`bridgeCall` → native-host socket → local handler (not forwarded to the
extension) → read/parse `Bookmarks` → response.

### Native-host handler

- Resolve `userDataDir` and `profileDirectory` from `detectBrowserIdentity`.
  Add test-only overrides `KENNECT_BROWSER_USER_DATA_DIR` and
  `KENNECT_BROWSER_PROFILE_DIR`.
- Validate `profileDirectory` is a single path segment: non-empty, no `/`,
  `\`, `.` or `..`.
- Read `join(userDataDir, profileDirectory, 'Bookmarks')`.
- Walk `roots.bookmark_bar`, `roots.other`, and `roots.synced` recursively.
- Treat a folder as a saved group when its `meta_info` object has a key
  matching `/^tab_group_/`. The spike confirms the exact key; the tolerant
  predicate avoids hard-coding one Chrome version.
- Extract:
  - `id`: `meta_info.tab_group_id`, else `node.guid`, else `node.id`.
  - `name`: `node.name`.
  - `color`: `meta_info.tab_group_color` or `null`.
  - `collapsed`: `meta_info.tab_group_collapsed`, normalized to a boolean or
    `null`.
  - `tabs`: direct children with an HTTP(S) `url`; return `{title, url}`.
- Return `{groups, source:'bookmarks', profileDirectory}`.
- Do not read or return bookmark content outside saved-group folders.
- Cap at 500 groups and 10,000 tabs; stop walking beyond a 5,000-node safety
  limit and include `truncated:true` when a cap is hit.
- No writes; no token or secret data.

### MCP and controller

- `browser_saved_groups` is read-only, accepts no arguments beyond the generic
  `profile`, and describes the local Bookmarks source and the macOS caveat.
- Add `saved-groups` to the server command map.
- Add `saved-groups` to `extensionOnly` and to the dedicated-profile switch
  fallback so the no-extension error is clear.
- No manifest permission change.

### macOS

If the file read fails with `EACCES`/`EPERM`, return a clear error: the host
could not read Chrome's Bookmarks file; macOS may require Full Disk Access;
no permission was requested. Document the limitation in the skill. A macOS
spike is required before claiming support there.

## Edge cases

- No saved groups → empty `groups` array.
- Missing file → clear error naming the expected path.
- Malformed JSON → clear parse error; do not crash the native host.
- Saved group with zero tabs → include it.
- Duplicate ids → keep both; no dedupe in v1.
- Deep or cyclic JSON → node cap prevents runaway work.
- Chrome writes the file atomically; a transient parse error is surfaced, not
  retried in a loop.
- Multiple connected profiles → use the selected/default profile, as with
  other tools.

## Tests

- `native-host.test.mjs`: temp `userDataDir/Default/Bookmarks` fixture with two
  saved-group folders carrying `meta_info.tab_group_id`/`tab_group_color`, one
  ordinary folder, and one unreadable/missing case. Call `saved-groups` over
  the socket; assert only saved groups, exact name/color/tabs, and the error
  paths.
- `mcp.test.mjs`: `browser_saved_groups` exists, is `readOnlyHint:true`, and
  its description mentions the local Bookmarks source and the macOS caveat.
- `controller.test.mjs`: `saved-groups` requires the extension.
- Full suite green.

## Spike

Before finalizing the parser: save one tab group in Chrome, then inspect the
Bookmarks JSON `meta_info` keys without printing titles or URLs. Confirm the
exact saved-group key(s), adjust the predicate/extraction, and test the same
read on macOS if available. If the key is absent or macOS blocks the read,
record the finding and document the limitation before shipping.

## Left to the builder

The exact metadata key(s) from the spike, whether to add live/open-tab
annotation in a follow-up, delete/rename in a follow-up, macOS TCC behavior,
and final response-shape details.
