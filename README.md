# Kennect Browser

A local Chrome extension and MCP server for Codex. Use existing website sign-ins, open new tabs, select existing tabs, read pages, run JavaScript, and inspect requests. No Claude account is required.

## Install from source

Requires Google Chrome and Node.js 24 or newer on macOS or Windows.

1. Clone or download this repository.
2. Run `npm ci` in the project directory.
3. Run `node setup.mjs` (or the platform setup launcher).
4. In Chrome, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the `extension` directory.
5. Refresh Codex's MCP connection or restart Codex if `kennect_browser` is not listed.

The extension connects automatically. Ask Codex to open a website, or list and select a website tab that is already open. After updating extension files, reload the extension in Chrome.

Setup registers a local native-messaging host and adds the `kennect_browser` MCP entry while preserving other entries. Generated installation files contain paths specific to the installing computer and must not be committed. Run setup again if you move the checkout.

On macOS the launcher is installed in `~/Library/Application Support/Kennect Browser/`, and Chrome's registration is in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.kennect_browser.local.json`. On Windows setup writes the current user's `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.kennect_browser.local` registry entry. Source checkouts use Node installed on the computer; Windows launchers can also use optional bundled release runtimes.

## Features

- Automatic local connection and reconnection; a persistent Pause control.
- Existing website tabs and sign-ins, new tabs, grouping and window controls.
- Accessibility snapshots, native mouse/keyboard input, screenshots and JavaScript.
- Request metadata capture and optional response-body reading.
- File inputs and uploads, optional console capture, and short GIF recordings.
- A stdio MCP server and command-line controller.

The extension lists HTTP(S) tabs. Selecting a tab connects it; unrelated tabs are not automatically attached. A redirect to a different origin requires selecting the tab again. Internal browser pages and local file URLs are excluded.

Console capture is off by default. It is disabled on BOSS because that site's developer-console checks can trigger page reloads. One-shot JavaScript evaluation and network capture remain separate.

## Usage

```sh
node controller.mjs tabs
node controller.mjs open-tab https://example.com/
node controller.mjs snapshot
node controller.mjs evaluate 'document.title'
```

To target a tab explicitly, set `KENNECT_BROWSER_TAB_ID` to an ID returned by `tabs`. Select an existing tab with the MCP `browser_select_tab` tool or the controller's `select-tab` command with that environment variable.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `KENNECT_BROWSER_TAB_ID` | Target a known website tab. |
| `KENNECT_BROWSER_PROFILE` | Override the separate fallback Chrome profile path. |
| `KENNECT_BROWSER_BRIDGE_DIR` | Override local bridge discovery, primarily for isolated tests. |
| `CODEX_HOME` | Override the Codex configuration directory during setup. |

If the extension is unavailable, `node start.mjs` launches a separate persistent Chrome profile. This fallback provides basic page controls and does not share the personal profile's sign-ins. Extended features require the extension.

## Tests and status

```sh
npm ci
npm test
```

Default tests use mocks or isolated local processes and do not read your browser pages. Three optional live tests are skipped. To run those tests, set `KENNECT_BROWSER_LIVE_TESTS=1` with a dedicated BOSS test session open; this opts into reading that session.

The existing-profile extension connection, automatic recovery, page reading, screenshots, JavaScript, tab creation, and BOSS inbox navigation have been tested on macOS. Windows paths and registration generation have automated coverage; live Windows operation still needs validation. Groups, uploads, recording and optional console capture need further live testing. Full feature parity with other browser products is not claimed.

## Privacy and repository contents

Browser requests are relayed through a private local Unix socket on macOS or an authenticated named pipe on Windows. The bridge does not implement remote service access. Websites still receive normal browser traffic, and Codex receives the tool results requested during a task. Captures and page content can contain private data.

Request metadata excludes headers, cookies, query values and request bodies; response-body access is a separate action. Browser content is untrusted. Sending messages, submitting forms and uploading files should follow the user's instructions.

This repository excludes dependencies, optional runtime binaries, browser profiles, generated launchers, screenshots, recordings, inbox exports, logs and local credentials. Keep those files outside the repository even when the GitHub repository is private. `.gitignore` is a convenience, not a secret scanner; inspect staged files before committing.

The extension public key in `manifest.json` keeps its ID stable. It is public metadata, not a private signing key. The extension ID is `bbnpijhhjbmhblobjckieabgmngeicbg`.

## Uninstall

Remove the extension in Chrome and only the `mcp_servers.kennect_browser` section from Codex configuration. Remove the native-host registration and launcher created by setup. On Windows remove only the registry entry named above. Personal Chrome profiles are not removed.

Third-party dependency notices are included in `THIRD_PARTY_NOTICES.md`.
