# Window Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class Chrome window management — create, list, target, rename, claim, and close windows — so parallel agents can isolate viewports without manual dragging.

**Architecture:** New extension commands manage windows through `chrome.windows`, with a named-window registry and session leases stored in `chrome.storage.session`. A caller-generated session ID flows from `server.mjs` through the controller, bridge client, and native host into the extension, where claims are enforced against window-scoped mutations only. Four MCP tools expose the lifecycle; four existing tools gain optional `windowId` targeting.

**Tech Stack:** Node.js 24, Chrome MV3 extension, `chrome.windows` / `chrome.tabs` / `chrome.storage.session`, MCP stdio server, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-16-window-lifecycle-design.md`

## Global Constraints

- Node.js 24 or newer; no new dependencies.
- No new Chrome manifest permissions. `chrome.windows` needs none.
- Version `0.4.0` in `package.json`, `package-lock.json`, `extension/manifest.json`, `server.mjs` `serverInfo`, and the extension hello test.
- Registry key is `windowRegistry` in `chrome.storage.session`.
- Window operations are extension-only; the CDP fallback returns a clear error.
- Claims block window-scoped mutations only: `open-tab` into the window, `resize`, `move-tab` into or out of it, `update-window`, `close-window`. Page actions, `select-tab`, `close-tab`, group operations, and downloads are never blocked.
- HTTP(S) URLs only; width 320–4000; height 240–4000; left/top -20000–20000.
- Lease default 1800000 ms; range 60000–86400000 ms.
- `browser_open_window` defaults `focused` to `false` and `reuseExisting` to `false`.
- No password, no default-window setting, no cross-window tab groups.
- Every task ends with `npm test` passing and a commit.

## Review Focus

These are the failure modes most likely to bite a user, and each has a test in the owning task:

- A stale or recycled window ID silently acting on a different window — Task 4/5 tests unknown-window errors and live-window checks.
- Two sessions writing the registry concurrently and losing a name or claim — Task 3 tests concurrent `open-window` calls.
- Duplicate names differing only by case or surrounding whitespace — Task 3 tests normalization.
- An implicit `open-tab` or `resize` bypassing another session's claim — Task 7 tests the resolved-target checks.
- Lease expiry or renewal off by one leaving a window locked too long or unlocked too early — Task 6 tests expiry and renewal against stored timestamps.

---

## File Structure

- `server.mjs` — MCP tool definitions, schema validation, session ID, command map.
- `controller.mjs` — CLI adapter, session ID, extension-only errors, fallback protections.
- `bridge-client.mjs` — request payload including `sessionId`.
- `native-host.mjs` — forwards `sessionId` to the extension.
- `extension/worker.js` — window registry, helpers, window commands, claim enforcement, window targeting.
- `extension/manifest.json` — version only.
- `extension.test.mjs` — fake `chrome.windows`, registry seeding, window tests.
- `mcp.test.mjs` — tool discovery and schema tests.
- `controller.test.mjs` — fallback error tests.
- `bridge-client.test.mjs` — session ID payload test.
- `native-host.test.mjs` — session ID forwarding test.
- `README.md`, `skills/kennect-browser/SKILL.md` — documentation.
- `package.json`, `package-lock.json` — version only.

---

### Task 1: Session ID plumbing

**Files:**
- Modify: `server.mjs:1-9`
- Modify: `controller.mjs:1-11`
- Modify: `bridge-client.mjs:42-44`
- Modify: `native-host.mjs:36-39`
- Test: `bridge-client.test.mjs`
- Test: `native-host.test.mjs`

**Interfaces:**
- Produces: environment variable `KENNECT_BROWSER_SESSION_ID`; bridge payload field `sessionId`; native-host request frame field `sessionId`.

- [ ] **Step 1: Write the failing bridge test**

Extend the `respond` helper to record requests, and add:

```js
test('bridge client sends the agent session id to the native host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kennect-bridge-session-'));
  const requests = [];
  const a = await startHost(directory, 'A', 'dddddddd4444', { onRequest: r => requests.push(r) });
  const previous = process.env.KENNECT_BROWSER_SESSION_ID;
  process.env.KENNECT_BROWSER_SESSION_ID = 'agent-test';
  try {
    await bridgeCall('snapshot', [], undefined, a.profile, { directory, probeTimeoutMs: 1500 });
    assert.ok(requests.some(r => r.sessionId === 'agent-test'));
  } finally {
    if (previous === undefined) delete process.env.KENNECT_BROWSER_SESSION_ID;
    else process.env.KENNECT_BROWSER_SESSION_ID = previous;
    await stopHost(a);
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test --test-name-pattern="agent session id" bridge-client.test.mjs`
Expected: FAIL — `sessionId` is undefined.

- [ ] **Step 3: Implement the plumbing**

- In `server.mjs`, import `randomUUID` from `node:crypto` and, after imports, set
  `if (!process.env.KENNECT_BROWSER_SESSION_ID) process.env.KENNECT_BROWSER_SESSION_ID = randomUUID();`
- In `controller.mjs`, do the same at module top so direct CLI calls get an ID.
- In `bridge-client.mjs` `callHost`, include
  `sessionId: process.env.KENNECT_BROWSER_SESSION_ID ?? ''` in the request body.
- In `native-host.mjs`, in the client-message decoder, compute
  `const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.slice(0, 100) : '';`
  and add `sessionId` to the outbound `{type: 'request', ...}` frame.

- [ ] **Step 4: Run the bridge test to verify it passes**

Run: `node --test --test-name-pattern="agent session id" bridge-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing native-host assertion**

In the existing round-trip test, send `sessionId: 'agent-test'` with the socket frame and assert `request.sessionId === 'agent-test'` in the stdout frame handler. Rename the test to
`native host round-trips framed browser messages and forwards the session id`.

- [ ] **Step 6: Run it and verify it fails**

Run: `node --test --test-name-pattern="forwards the session id" native-host.test.mjs`
Expected: FAIL — `request.sessionId` is undefined.

- [ ] **Step 7: Run both tests to verify they pass**

Run: `node --test bridge-client.test.mjs native-host.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server.mjs controller.mjs bridge-client.mjs native-host.mjs bridge-client.test.mjs native-host.test.mjs
git commit -m "feat: carry agent session id through the browser bridge"
```

---

### Task 2: Extension window fixture, registry, and `browser_windows`

**Files:**
- Modify: `extension/worker.js` (top helpers and command dispatch)
- Modify: `extension.test.mjs` (fake chrome and environment helpers)

**Interfaces:**
- Produces: `WINDOW_REGISTRY_KEY`, `windowRegistry`, `windowsReady`, `withWindowRegistry(fn)`, `saveWindowRegistry()`, `activeClaim(entry, now)`, `ownerLabel(sessionId)`, `pruneWindowRegistry(liveIds)`, `windowSummary(win, entry, sessionId, tabs)`, and the worker command `windows` with args `[nameFilter]`.
- Produces test helpers: `windows` map, `nextWindowId`, `nextTabId`, `seedRegistry(value)`.

- [ ] **Step 1: Extend the fake Chrome environment**

In `extension.test.mjs` `environment()`:

```js
const windows = new Map([[1, { id: 1, focused: true, state: 'normal', left: 0, top: 0, width: 1200, height: 800, type: 'normal' }]]);
let nextWindowId = 10, nextTabId = 10;
```

Add to `chrome`:

```js
windows: {
  create: async options => {
    const id = nextWindowId++;
    const win = { id, focused: options.focused ?? false, state: 'normal', left: options.left ?? 0, top: options.top ?? 0, width: options.width ?? 1200, height: options.height ?? 800, type: 'normal' };
    windows.set(id, win);
    const tab = { id: nextTabId++, url: options.url, title: 'New window', windowId: id };
    pages.set(tab.id, tab);
    return { ...win, tabs: [tab] };
  },
  get: async id => windows.get(id),
  getAll: async () => [...windows.values()].map(w => ({ ...w, tabs: [...pages.values()].filter(t => t.windowId === w.id) })),
  remove: async id => { windows.delete(id); for (const [tabId, tab] of pages) if (tab.windowId === id) pages.delete(tabId); },
  update: async (id, changes) => Object.assign(windows.get(id), changes),
  getLastFocused: async () => [...windows.values()].find(w => w.focused) ?? [...windows.values()][0]
}
```

Extend `tabs.query` to handle `{ windowId }` before the group filter, add a default
`create: async ({ url, windowId }) => { const t = { id: nextTabId++, url, title: 'New tab', windowId: windowId ?? 1 }; pages.set(t.id, t); return t; }`,
and add `move: async (tabIds, { windowId, index }) => { for (const id of [].concat(tabIds)) { const t = pages.get(id); t.windowId = windowId; } }`.

Return `windows` and `seedRegistry` from `environment()`:

```js
async seedRegistry(value) { sessionSaved.windowRegistry = value; await load(); }
```

- [ ] **Step 2: Write the failing listing test**

```js
test('window listing reports names, bounds, and claims', async () => {
  const e = await environment();
  e.sessionSaved.windowRegistry = {
    1: { windowId: 1, name: 'desktop', purpose: 'desktop testing', ownerSession: 'agent-aaaa', claimedAt: Date.now(), leaseUntil: Date.now() + 60000, leaseMs: 60000, createdByTool: true, createdAt: Date.now() }
  };
  await e.restart();
  const result = JSON.parse(await e.scope.action({ command: 'windows', args: [], sessionId: 'agent-aaaa' }));
  assert.equal(result.windows.length, 1);
  const w = result.windows[0];
  assert.equal(w.windowId, 1);
  assert.equal(w.name, 'desktop');
  assert.deepEqual(w.bounds, { left: 0, top: 0, width: 1200, height: 800 });
  assert.equal(w.claimedByYou, true);
  assert.equal(w.claimedByOther, false);
  assert.equal(w.tabCount, 2);
  assert.equal(w.connectedTabCount, 0);
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `node --test --test-name-pattern="window listing reports" extension.test.mjs`
Expected: FAIL — unsupported browser command.

- [ ] **Step 4: Implement the registry and listing**

First change the `action` signature to
`async function action({ command, args = [], tabId, sessionId = 'local' })`.

Add at the top of `extension/worker.js`:

```js
const WINDOW_REGISTRY_KEY = 'windowRegistry';
let windowRegistry = {};
const windowsReady = chrome.storage.session.get(WINDOW_REGISTRY_KEY).then(saved => { windowRegistry = Object.assign({}, saved?.[WINDOW_REGISTRY_KEY] ?? {}); }).catch(() => {});
let windowQueue = Promise.resolve();
function withWindowRegistry(fn) { const run = windowQueue.then(async () => { await windowsReady; return fn(); }); windowQueue = run.catch(() => {}); return run; }
async function saveWindowRegistry() { await chrome.storage.session.set({ [WINDOW_REGISTRY_KEY]: windowRegistry }); }
function activeClaim(entry, now = Date.now()) { return entry && entry.ownerSession && Number(entry.leaseUntil) > now ? entry : null; }
function ownerLabel(sessionId) { return String(sessionId ?? '').slice(0, 8); }
function pruneWindowRegistry(liveIds) { for (const key of Object.keys(windowRegistry)) if (!liveIds.has(Number(key))) delete windowRegistry[key]; }
function windowSummary(win, entry, sessionId, tabs) {
  const claim = activeClaim(entry);
  return {
    windowId: win.id,
    name: entry?.name ?? null,
    purpose: entry?.purpose ?? null,
    createdByTool: entry?.createdByTool ?? false,
    owner: claim ? ownerLabel(claim.ownerSession) : null,
    claimedByYou: !!claim && claim.ownerSession === sessionId,
    claimedByOther: !!claim && claim.ownerSession !== sessionId,
    leaseUntil: claim ? new Date(claim.leaseUntil).toISOString() : null,
    focused: !!win.focused,
    state: win.state ?? 'normal',
    bounds: { left: win.left ?? 0, top: win.top ?? 0, width: win.width ?? 0, height: win.height ?? 0 },
    tabCount: tabs.length,
    connectedTabCount: tabs.filter(t => approved(t.url) && attached.has(t.id)).length
  };
}
```

Before the `if (command === 'tabs')` branch, add:

```js
if (command === 'windows') {
  return withWindowRegistry(async () => {
    const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const live = new Set(all.map(w => w.id));
    pruneWindowRegistry(live);
    const allTabs = await chrome.tabs.query({});
    const name = String(args[0] ?? '').trim().toLowerCase();
    const list = all
      .filter(w => !name || String(windowRegistry[w.id]?.name ?? '').toLowerCase() === name)
      .map(w => windowSummary(w, windowRegistry[w.id], sessionId, allTabs.filter(t => t.windowId === w.id)));
    await saveWindowRegistry();
    return JSON.stringify({ windows: list });
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test --test-name-pattern="window listing reports" extension.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: add the window registry and browser_windows"
```

---

### Task 3: `browser_open_window`

**Files:**
- Modify: `extension/worker.js` (registry helpers, `open-window` command)
- Modify: `extension.test.mjs`

**Interfaces:**
- Consumes: Task 2 registry helpers and the fake `chrome.windows.create`.
- Produces: worker command `open-window` with args `[JSON.stringify(options)]`, returning
  `{ windowId, tabId, name, reused, owner, claimedByYou, leaseUntil }`.
- Produces helpers: `validateWindowName(name)`, `validateWindowPurpose(purpose)`, `validateWindowBounds(options)`, `openWindow(options, sessionId)`.

- [ ] **Step 1: Write the failing creation tests**

```js
test('opening a window creates it with bounds, a name, and a claim', async () => {
  const e = await environment();
  await e.connect();
  const result = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/mobile', width: 390, height: 844, name: 'mobile-390', purpose: 'mobile viewport', claim: true })], sessionId: 'agent-a' }));
  assert.equal(result.reused, false);
  assert.equal(result.name, 'mobile-390');
  const win = e.windows.get(result.windowId);
  assert.equal(win.width, 390);
  assert.equal(win.height, 844);
  assert.equal(win.focused, false);
  assert.equal(e.pages.get(Number(result.tabId)).windowId, result.windowId);
  const entry = e.sessionSaved.windowRegistry[result.windowId];
  assert.equal(entry.name, 'mobile-390');
  assert.equal(entry.ownerSession, 'agent-a');
});

test('window creation refuses duplicate and conflicting names', async () => {
  const e = await environment();
  await e.connect();
  const first = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'Mobile-390', claim: true })], sessionId: 'agent-a' }));
  await assert.rejects(e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/b', name: ' mobile-390 ' })], sessionId: 'agent-a' }), /already/i);
  const reused = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/c', name: 'mobile-390', reuseExisting: true })], sessionId: 'agent-a' }));
  assert.equal(reused.reused, true);
  assert.equal(reused.windowId, first.windowId);
  await assert.rejects(e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/d', name: 'mobile-390', reuseExisting: true })], sessionId: 'agent-b' }), /claimed/i);
});

test('concurrent window creation keeps both registry entries', async () => {
  const e = await environment();
  await e.connect();
  await Promise.all([
    e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/1', name: 'one' })], sessionId: 'agent-a' }),
    e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/2', name: 'two' })], sessionId: 'agent-b' })
  ]);
  const names = Object.values(e.sessionSaved.windowRegistry).map(x => x.name).sort();
  assert.deepEqual(names, ['one', 'two']);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="opening a window|duplicate and conflicting|concurrent window" extension.test.mjs`
Expected: FAIL — unsupported browser command.

- [ ] **Step 3: Implement validation and `openWindow`**

Add helpers:

```js
function validateWindowName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw Error('Window name must be 1-40 characters without control characters.');
  return name;
}
function validateWindowPurpose(value) {
  const purpose = String(value ?? '').trim();
  if (purpose.length > 200) throw Error('Window purpose must be 200 characters or fewer.');
  return purpose;
}
function validateWindowBounds(options) {
  const hasWidth = options.width !== undefined, hasHeight = options.height !== undefined;
  if (hasWidth !== hasHeight) throw Error('Pass width and height together.');
  if (hasWidth && (!Number.isInteger(options.width) || options.width < 320 || options.width > 4000)) throw Error('Invalid window width.');
  if (hasHeight && (!Number.isInteger(options.height) || options.height < 240 || options.height > 4000)) throw Error('Invalid window height.');
  for (const key of ['left', 'top']) if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] < -20000 || options[key] > 20000)) throw Error(`Invalid window ${key}.`);
}
async function openWindow(options, sessionId) {
  if (!allowed(options.url)) throw Error('Only HTTP and HTTPS websites can be opened.');
  const url = new URL(options.url).href;
  validateWindowBounds(options);
  const name = options.name === undefined ? null : validateWindowName(options.name);
  const purpose = options.purpose === undefined ? null : validateWindowPurpose(options.purpose);
  if (options.claim === true && !name) throw Error('A window claim requires a name.');
  const leaseMs = options.leaseMs ?? 1800000;
  if (!Number.isInteger(leaseMs) || leaseMs < 60000 || leaseMs > 86400000) throw Error('Invalid lease duration.');
  return withWindowRegistry(async () => {
    const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    pruneWindowRegistry(new Set(all.map(w => w.id)));
    if (name) {
      const existing = all.find(w => String(windowRegistry[w.id]?.name ?? '').trim().toLowerCase() === name.toLowerCase());
      if (existing) {
        if (!options.reuseExisting) throw Error(`Window name "${name}" is already used by window ${existing.id}.`);
        const entry = windowRegistry[existing.id];
        const claim = activeClaim(entry);
        if (claim && claim.ownerSession !== sessionId) throw Error(`Window ${existing.id} "${entry.name}" is claimed by another agent.`);
        if (options.claim === true) {
          entry.ownerSession = sessionId; entry.claimedAt = Date.now(); entry.leaseMs = leaseMs; entry.leaseUntil = Date.now() + leaseMs;
        }
        await saveWindowRegistry();
        const current = activeClaim(entry);
        return JSON.stringify({ windowId: existing.id, tabId: null, name: entry.name, reused: true, owner: current ? ownerLabel(current.ownerSession) : null, claimedByYou: !!current && current.ownerSession === sessionId, leaseUntil: current ? new Date(current.leaseUntil).toISOString() : null });
      }
    }
    const win = await chrome.windows.create({ url, type: 'normal', focused: options.focused ?? false, ...(options.width !== undefined ? { width: options.width, height: options.height } : {}), ...(options.left !== undefined ? { left: options.left } : {}), ...(options.top !== undefined ? { top: options.top } : {}) });
    const created = win.tabs?.[0] ?? (await chrome.tabs.query({ windowId: win.id }))[0];
    if (!created) throw Error('Chrome did not create a tab in the new window.');
    approvedOrigins.add(new URL(url).origin);
    await tab(created.id, true);
    connectedTab = created.id;
    await persistState();
    const entry = { windowId: win.id, name, purpose, ownerSession: null, claimedAt: null, leaseUntil: null, leaseMs, createdByTool: true, createdAt: Date.now() };
    if (options.claim === true) { entry.ownerSession = sessionId; entry.claimedAt = Date.now(); entry.leaseUntil = Date.now() + leaseMs; }
    windowRegistry[win.id] = entry;
    await saveWindowRegistry();
    const current = activeClaim(entry);
    return JSON.stringify({ windowId: win.id, tabId: String(created.id), name, reused: false, owner: current ? ownerLabel(current.ownerSession) : null, claimedByYou: !!current && current.ownerSession === sessionId, leaseUntil: current ? new Date(current.leaseUntil).toISOString() : null });
  });
}
```

Add the command before the `tab()` resolution:

```js
if (command === 'open-window') return openWindow(JSON.parse(args[0] || '{}'), sessionId);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="opening a window|duplicate and conflicting|concurrent window" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: add browser_open_window with names and claims"
```

---

### Task 4: `browser_update_window`

**Files:**
- Modify: `extension/worker.js`
- Modify: `extension.test.mjs`

**Interfaces:**
- Consumes: Task 2 registry helpers, Task 3 validators.
- Produces: worker command `update-window` with args `[String(windowId), JSON.stringify(changes)]`; helper `updateWindow(windowId, changes, sessionId)`.
- Produces summary shape: `{ windowId, name, purpose, owner, claimedByYou, leaseUntil, focused, state, bounds }`.

- [ ] **Step 1: Write the failing update tests**

```js
test('updating a window resizes and renames only the target', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'desktop' })], sessionId: 'agent-a' }));
  const other = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/b', name: 'other' })], sessionId: 'agent-a' }));
  await e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ width: 800, height: 600, name: 'desktop-main' })], sessionId: 'agent-a' });
  assert.equal(e.windows.get(opened.windowId).width, 800);
  assert.equal(e.windows.get(other.windowId).width, 1200);
  assert.equal(e.sessionSaved.windowRegistry[opened.windowId].name, 'desktop-main');
});

test('window updates reject duplicates, empty changes, and unknown windows', async () => {
  const e = await environment();
  await e.connect();
  const a = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'a' })], sessionId: 'agent-a' }));
  await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/b', name: 'b' })], sessionId: 'agent-a' });
  await assert.rejects(e.scope.action({ command: 'update-window', args: [String(a.windowId), JSON.stringify({ name: 'b' })], sessionId: 'agent-a' }), /already/i);
  await assert.rejects(e.scope.action({ command: 'update-window', args: [String(a.windowId), '{}'], sessionId: 'agent-a' }), /change/i);
  await assert.rejects(e.scope.action({ command: 'update-window', args: ['999', JSON.stringify({ width: 800, height: 600 })], sessionId: 'agent-a' }), /Unknown window/i);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="updating a window|window updates reject" extension.test.mjs`
Expected: FAIL — unsupported browser command.

- [ ] **Step 3: Implement `updateWindow`**

```js
async function updateWindow(windowId, changes, sessionId) {
  if (!Number.isInteger(windowId) || windowId < 0) throw Error('Invalid window ID.');
  const keys = ['width', 'height', 'left', 'top', 'focused', 'state', 'name', 'purpose'];
  if (!keys.some(key => changes[key] !== undefined)) throw Error('Provide at least one window change.');
  validateWindowBounds(changes);
  const states = ['normal', 'minimized', 'maximized', 'fullscreen'];
  if (changes.state !== undefined && !states.includes(changes.state)) throw Error('Invalid window state.');
  return withWindowRegistry(async () => {
    const all = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const live = new Set(all.map(w => w.id));
    pruneWindowRegistry(live);
    const entry = windowRegistry[windowId];
    if (!live.has(windowId) || !entry) throw Error('Unknown window ID. Refresh with browser_windows.');
    const name = changes.name === undefined ? undefined : validateWindowName(changes.name);
    if (name) {
      const conflict = all.find(w => w.id !== windowId && String(windowRegistry[w.id]?.name ?? '').trim().toLowerCase() === name.toLowerCase());
      if (conflict) throw Error(`Window name "${name}" is already used by window ${conflict.id}.`);
    }
    if (changes.purpose !== undefined) entry.purpose = changes.purpose ? validateWindowPurpose(changes.purpose) : null;
    if (name !== undefined) entry.name = name;
    const update = {};
    for (const key of ['width', 'height', 'left', 'top', 'focused', 'state']) if (changes[key] !== undefined) update[key] = changes[key];
    if (changes.width !== undefined) update.state = 'normal';
    if (Object.keys(update).length) await chrome.windows.update(windowId, update);
    if (changes.state !== undefined && changes.width !== undefined && changes.state !== 'normal') await chrome.windows.update(windowId, { state: changes.state });
    await saveWindowRegistry();
    const win = await chrome.windows.get(windowId);
    const tabs = await chrome.tabs.query({ windowId });
    const summary = windowSummary(win, entry, sessionId, tabs);
    return JSON.stringify(summary);
  });
}
```

Add the command:

```js
if (command === 'update-window') return updateWindow(Number(args[0]), JSON.parse(args[1] || '{}'), sessionId);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="updating a window|window updates reject" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: add browser_update_window"
```

---

### Task 5: `browser_close_window`

**Files:**
- Modify: `extension/worker.js`
- Modify: `extension.test.mjs`

**Interfaces:**
- Produces: worker command `close-window` with args `[String(windowId), '1'|'']`; helper `closeWindow(windowId, sessionId, force)`.

- [ ] **Step 1: Write the failing close tests**

```js
test('closing windows refuses untracked and last windows', async () => {
  const e = await environment();
  await e.connect();
  await assert.rejects(e.scope.action({ command: 'close-window', args: ['1', ''], sessionId: 'agent-a' }), /created by browser_open_window/i);
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a' })], sessionId: 'agent-a' }));
  e.windows.delete(1);
  await assert.rejects(e.scope.action({ command: 'close-window', args: [String(opened.windowId), ''], sessionId: 'agent-a' }), /only Chrome window/i);
});

test('closing a tracked window removes it and its registry entry', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'task' })], sessionId: 'agent-a' }));
  const result = JSON.parse(await e.scope.action({ command: 'close-window', args: [String(opened.windowId), ''], sessionId: 'agent-a' }));
  assert.equal(result.closed, true);
  assert.equal(e.windows.has(opened.windowId), false);
  assert.equal(e.sessionSaved.windowRegistry[opened.windowId], undefined);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="closing windows refuses|closing a tracked" extension.test.mjs`
Expected: FAIL — unsupported browser command.

- [ ] **Step 3: Implement `closeWindow`**

```js
async function closeWindow(windowId, sessionId, force) {
  if (!Number.isInteger(windowId) || windowId < 0) throw Error('Invalid window ID.');
  return withWindowRegistry(async () => {
    const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
    pruneWindowRegistry(new Set(all.map(w => w.id)));
    const entry = windowRegistry[windowId];
    if (!entry?.createdByTool) throw Error('Only windows created by browser_open_window in this browser session can be closed. Close user windows manually.');
    if (all.length <= 1) throw Error('Refusing to close the only Chrome window.');
    const claim = activeClaim(entry);
    if (claim && claim.ownerSession !== sessionId && !force) throw Error(`Window ${windowId} is claimed by another agent until ${new Date(claim.leaseUntil).toISOString()}. Use another window or ask the user to release the claim.`);
    await chrome.windows.remove(windowId);
    delete windowRegistry[windowId];
    await saveWindowRegistry();
    return JSON.stringify({ closed: true, windowId });
  });
}
```

Add the command:

```js
if (command === 'close-window') return closeWindow(Number(args[0]), sessionId, args[1] === '1');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="closing windows refuses|closing a tracked" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: add browser_close_window with safety guards"
```

---

### Task 6: Claims, leases, renewal, and claim enforcement

**Files:**
- Modify: `extension/worker.js`
- Modify: `extension.test.mjs`

**Interfaces:**
- Consumes: Task 2 `activeClaim`; Task 3 `openWindow`; Task 4 `updateWindow`; Task 5 `closeWindow`.
- Produces: `assertWindowAccess(windowId, sessionId, { force })`, `renewWindowClaim(entry, sessionId)`, `claimWindow(entry, sessionId, leaseMs)`, `releaseWindow(entry)`, claim and `force` handling in `updateWindow`, `force` in `closeWindow`.

- [ ] **Step 1: Write the failing claim tests**

```js
test('a claim blocks window-scoped updates from another session', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'mobile', claim: true })], sessionId: 'agent-a' }));
  await assert.rejects(e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ width: 500, height: 800 })], sessionId: 'agent-b' }), /claimed by another agent/i);
  await e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ width: 500, height: 800, force: true })], sessionId: 'agent-b' });
  assert.equal(e.windows.get(opened.windowId).width, 500);
});

test('page reads still work in a claimed window', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'mobile', claim: true })], sessionId: 'agent-a' }));
  await e.scope.action({ command: 'snapshot', tabId: Number(opened.tabId), sessionId: 'agent-b' });
  assert.ok(e.calls.includes('Accessibility.getFullAXTree'));
});

test('an expired lease no longer blocks another session', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'mobile', claim: true })], sessionId: 'agent-a' }));
  e.sessionSaved.windowRegistry[opened.windowId].leaseUntil = Date.now() - 1;
  await e.restart();
  await e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ width: 500, height: 800 })], sessionId: 'agent-b' });
  assert.equal(e.windows.get(opened.windowId).width, 500);
});

test('releasing a claim allows another session to update', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'mobile', claim: true })], sessionId: 'agent-a' }));
  await e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ claim: false })], sessionId: 'agent-a' });
  await e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ width: 500, height: 800 })], sessionId: 'agent-b' });
  assert.equal(e.windows.get(opened.windowId).width, 500);
});

test('an owner mutation renews the lease', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'mobile', claim: true })], sessionId: 'agent-a' }));
  const before = Date.now();
  e.sessionSaved.windowRegistry[opened.windowId].leaseUntil = before + 5000;
  await e.restart();
  await e.scope.action({ command: 'update-window', args: [String(opened.windowId), JSON.stringify({ width: 500, height: 800 })], sessionId: 'agent-a' });
  assert.ok(e.sessionSaved.windowRegistry[opened.windowId].leaseUntil > before + 10000);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="claim blocks|page reads still work|expired lease|releasing a claim|owner mutation renews" extension.test.mjs`
Expected: FAIL — claim updates are not enforced.

- [ ] **Step 3: Implement claims and enforcement**

Add:

```js
function assertWindowAccess(windowId, sessionId, { force = false } = {}) {
  const entry = windowRegistry[windowId];
  const claim = activeClaim(entry);
  if (claim && claim.ownerSession !== sessionId && !force) throw Error(`Window ${windowId}${entry?.name ? ` "${entry.name}"` : ''} is claimed by another agent until ${new Date(claim.leaseUntil).toISOString()}. Use another window or ask the user to release the claim.`);
}
function renewWindowClaim(entry, sessionId) {
  if (entry?.ownerSession === sessionId && activeClaim(entry)) entry.leaseUntil = Date.now() + (entry.leaseMs ?? 1800000);
}
function claimWindow(entry, sessionId, leaseMs) {
  if (!entry.name) throw Error('A window claim requires a name.');
  const lease = leaseMs ?? entry.leaseMs ?? 1800000;
  if (!Number.isInteger(lease) || lease < 60000 || lease > 86400000) throw Error('Invalid lease duration.');
  entry.ownerSession = sessionId; entry.claimedAt = Date.now(); entry.leaseMs = lease; entry.leaseUntil = Date.now() + lease;
}
function releaseWindow(entry) { entry.ownerSession = null; entry.claimedAt = null; entry.leaseUntil = null; }
```

In `updateWindow`, before mutating:

```js
assertWindowAccess(windowId, sessionId, { force: changes.force === true });
```

Handle claim changes after the name/bounds work:

```js
if (changes.claim === true) { claimWindow(entry, sessionId, changes.leaseMs); }
else if (changes.claim === false) {
  if (activeClaim(entry) && entry.ownerSession !== sessionId && !changes.force) throw Error(`Window ${windowId} is claimed by another agent.`);
  releaseWindow(entry);
}
if (changes.claim === undefined) renewWindowClaim(entry, sessionId);
```

Add `claim` and `force` to the keys check so `update-window` with only `{ claim: true }` is valid:

```js
const keys = ['width','height','left','top','focused','state','name','purpose','claim'];
```

In `closeWindow`, the claim check already uses `force`; keep it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="claim blocks|page reads still work|expired lease|releasing a claim|owner mutation renews" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: enforce window claims with renewable leases"
```

---

### Task 7: Window targeting in existing tab commands

**Files:**
- Modify: `extension/worker.js`
- Modify: `extension.test.mjs`

**Interfaces:**
- Consumes: Task 6 `assertWindowAccess`, `renewWindowClaim`.
- Produces: `open-tab` args `[url, groupTitle, groupColor, windowId]`; `resize` args `[width, height, windowId]`; `move-tab` args `[index, windowId]`; `tabs` args `[windowId]`; helper `resolveWindowId(explicit, tabId)`.

- [ ] **Step 1: Write the failing targeting tests**

```js
test('open-tab targets an explicit window and resolves the connected tab window', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/window', name: 'target' })], sessionId: 'agent-a' }));
  const explicit = JSON.parse(await e.scope.action({ command: 'open-tab', args: ['https://example.com/explicit', '', '', String(opened.windowId)], sessionId: 'agent-a' }));
  assert.equal(e.pages.get(Number(explicit.targetId)).windowId, opened.windowId);
  e.scope.chrome.tabs.update = async () => {};
  await e.scope.action({ command: 'select-tab', tabId: 2, sessionId: 'agent-a' });
  const implicit = JSON.parse(await e.scope.action({ command: 'open-tab', args: ['https://example.com/implicit', '', ''], sessionId: 'agent-a' }));
  assert.equal(e.pages.get(Number(implicit.targetId)).windowId, 1);
});

test('resize by windowId changes only that window', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a' })], sessionId: 'agent-a' }));
  await e.scope.action({ command: 'resize', args: ['500', '800', String(opened.windowId)], sessionId: 'agent-a' });
  assert.equal(e.windows.get(opened.windowId).width, 500);
  assert.equal(e.windows.get(1).width, 1200);
});

test('move-tab moves to a destination window and tabs filter by window', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a' })], sessionId: 'agent-a' }));
  await e.scope.action({ command: 'move-tab', args: ['0', String(opened.windowId)], sessionId: 'agent-a', tabId: 2 });
  assert.equal(e.pages.get(2).windowId, opened.windowId);
  const filtered = JSON.parse(await e.scope.action({ command: 'tabs', args: [String(opened.windowId)], sessionId: 'agent-a' }));
  assert.ok(filtered.every(t => t.windowId === opened.windowId));
});

test('implicit window targets are blocked by another session claim', async () => {
  const e = await environment();
  await e.connect();
  const opened = JSON.parse(await e.scope.action({ command: 'open-window', args: [JSON.stringify({ url: 'https://example.com/a', name: 'locked', claim: true })], sessionId: 'agent-a' }));
  e.scope.chrome.tabs.update = async () => {};
  await e.scope.action({ command: 'select-tab', tabId: Number(opened.tabId), sessionId: 'agent-b' });
  await assert.rejects(e.scope.action({ command: 'open-tab', args: ['https://example.com/b', '', ''], sessionId: 'agent-b' }), /claimed by another agent/i);
  await assert.rejects(e.scope.action({ command: 'resize', args: ['500', '800'], sessionId: 'agent-b' }), /claimed by another agent/i);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="open-tab targets|resize by windowId|move-tab moves|implicit window targets" extension.test.mjs`
Expected: FAIL — the extra positional arguments are ignored or no claim is raised.

- [ ] **Step 3: Implement target resolution**

Add:

```js
async function resolveWindowId(explicit, tabId) {
  if (explicit !== undefined && explicit !== '') {
    const id = Number(explicit);
    if (!Number.isInteger(id) || id < 0) throw Error('Invalid window ID.');
    return id;
  }
  if (tabId !== undefined) return (await chrome.tabs.get(Number(tabId))).windowId;
  throw Error('Select a website tab first.');
}
```

In `open-tab`:

```js
let targetWindowId = null;
if (args[3] !== undefined && args[3] !== '') targetWindowId = Number(args[3]);
else if (connectedTab !== undefined) targetWindowId = (await chrome.tabs.get(connectedTab)).windowId;
else targetWindowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
assertWindowAccess(targetWindowId, sessionId);
const n = await chrome.tabs.create({ url: args[0], windowId: targetWindowId });
```

Keep the existing origin approval, attach, `connectedTab`, and group logic. After a successful create,
`renewWindowClaim(windowRegistry[targetWindowId], sessionId)` and save the registry. Include `windowId: targetWindowId` in the returned JSON.

In `resize`:

```js
const targetWindowId = args[2] !== undefined && args[2] !== ''
  ? Number(args[2])
  : t.windowId;
assertWindowAccess(targetWindowId, sessionId);
await chrome.windows.update(targetWindowId, { width, height });
renewWindowClaim(windowRegistry[targetWindowId], sessionId);
await saveWindowRegistry();
```

In `move-tab`:

```js
const sourceWindowId = t.windowId;
const destinationWindowId = args[1] !== undefined && args[1] !== '' ? Number(args[1]) : sourceWindowId;
assertWindowAccess(sourceWindowId, sessionId);
if (destinationWindowId !== sourceWindowId) assertWindowAccess(destinationWindowId, sessionId);
await chrome.tabs.move(id, { index: Number(args[0]), ...(destinationWindowId !== sourceWindowId ? { windowId: destinationWindowId } : {}) });
renewWindowClaim(windowRegistry[sourceWindowId], sessionId);
if (destinationWindowId !== sourceWindowId) renewWindowClaim(windowRegistry[destinationWindowId], sessionId);
await saveWindowRegistry();
```

In `tabs`:

```js
if (command === 'tabs') {
  const filter = args[0] !== undefined && args[0] !== '' ? Number(args[0]) : null;
  const all = await chrome.tabs.query({});
  // keep the existing mapping, then filter by windowId when filter is set
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="open-tab targets|resize by windowId|move-tab moves|implicit window targets" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: target windows from tab commands"
```

---

### Task 8: MCP tools and schemas

**Files:**
- Modify: `server.mjs` (tool definitions, validation, command map, version)
- Test: `mcp.test.mjs`

**Interfaces:**
- Consumes: worker commands from Tasks 2-7.
- Produces: MCP tools `browser_windows`, `browser_open_window`, `browser_update_window`, `browser_close_window`; optional `windowId` on `browser_open_tab`, `browser_resize`, `browser_move_tab`, `browser_tabs`.

- [ ] **Step 1: Write the failing MCP tests**

Add to `mcp.test.mjs` (reuse the existing `names` variable):

```js
assert.ok(names.includes('browser_windows'));
assert.ok(names.includes('browser_open_window'));
assert.ok(names.includes('browser_update_window'));
assert.ok(names.includes('browser_close_window'));
const windowsTool = list.result.tools.find(t => t.name === 'browser_windows');
assert.equal(windowsTool.annotations.readOnlyHint, true);
const openWindow = list.result.tools.find(t => t.name === 'browser_open_window');
assert.ok(openWindow.inputSchema.properties.name);
assert.deepEqual(openWindow.inputSchema.required, ['url']);
const updateWindow = list.result.tools.find(t => t.name === 'browser_update_window');
assert.deepEqual(updateWindow.inputSchema.properties.state.enum, ['normal', 'minimized', 'maximized', 'fullscreen']);
const bothTargets = await call('tools/call', { name: 'browser_resize', arguments: { width: 800, height: 600, tabId: '1', windowId: 2 } });
assert.equal(bothTargets.error.code, -32602);
const badState = await call('tools/call', { name: 'browser_update_window', arguments: { windowId: 1, state: 'bogus' } });
assert.equal(badState.error.code, -32602);
const claimWithoutName = await call('tools/call', { name: 'browser_open_window', arguments: { url: 'https://example.com/', claim: true } });
assert.equal(claimWithoutName.error.code, -32602);
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test --test-name-pattern="MCP discovers" mcp.test.mjs`
Expected: FAIL — the new tools are missing.

- [ ] **Step 3: Implement the tools**

Add schemas with the exact ranges from Global Constraints. Use the existing `tool()` helper so `profile` is injected automatically. Mark `browser_windows` read-only. Add the four tools and the new `windowId` properties.

Add manual validation in `runTool` before dispatch:

```js
if (name === 'browser_resize' && args.tabId !== undefined && args.windowId !== undefined) invalid('Pass either tabId or windowId, not both');
if (name === 'browser_open_window' && args.claim === true && !args.name) invalid('claim requires name');
```

Add command-map entries:

```js
browser_windows: ['windows', args.name || ''],
browser_open_window: ['open-window', JSON.stringify({ url: args.url, width: args.width, height: args.height, left: args.left, top: args.top, focused: args.focused, name: args.name, purpose: args.purpose, claim: args.claim, leaseMs: args.leaseMs, reuseExisting: args.reuseExisting })],
browser_update_window: ['update-window', String(args.windowId), JSON.stringify({ width: args.width, height: args.height, left: args.left, top: args.top, focused: args.focused, state: args.state, name: args.name, purpose: args.purpose, claim: args.claim, leaseMs: args.leaseMs, force: args.force })],
browser_close_window: ['close-window', String(args.windowId), args.force ? '1' : ''],
browser_open_tab: ['open-tab', args.url, args.groupTitle || '', args.groupColor || '', args.windowId === undefined ? '' : String(args.windowId)],
browser_resize: ['resize', String(args.width), String(args.height), args.windowId === undefined ? '' : String(args.windowId)],
browser_move_tab: ['move-tab', String(args.index), args.windowId === undefined ? '' : String(args.windowId)],
browser_tabs: ['tabs', args.windowId === undefined ? '' : String(args.windowId)],
```

Bump `serverInfo.version` to `0.4.0` and extend the `instructions` string with:
"Call browser_windows before creating a window. Name task windows and claim them; claims block window-scoped mutations from other agents, not page reads."

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern="MCP discovers" mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add server.mjs mcp.test.mjs
git commit -m "feat: expose window lifecycle MCP tools"
```

---

### Task 9: Controller fallback and command mapping

**Files:**
- Modify: `controller.mjs`
- Test: `controller.test.mjs`

**Interfaces:**
- Consumes: Task 1 session ID; Task 8 command names.
- Produces: clear "requires the Kennect Browser extension" errors for window commands and window-targeted tab commands before the dedicated browser path.

- [ ] **Step 1: Write the failing controller tests**

```js
test('window commands require the extension', () => {
  for (const args of [['windows'], ['open-window', '{}'], ['update-window', '1', '{}'], ['close-window', '1']]) {
    const r = run(...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires the Kennect Browser extension/);
  }
});

test('window targeting in tab commands requires the extension', () => {
  for (const args of [['open-tab', 'https://example.com/', '', '', '1'], ['tabs', '1']]) {
    const r = run(...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires the Kennect Browser extension/);
  }
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="window commands require|window targeting" controller.test.mjs`
Expected: FAIL — the tests hit the dedicated-browser path or report a different error.

- [ ] **Step 3: Implement the guard**

After `bridgeCall` returns null and before `checkUrl` / the `DevToolsActivePort` read:

```js
const extensionOnly = ['windows', 'open-window', 'update-window', 'close-window'];
const targetsWindow = (command === 'open-tab' && args[3]) || (command === 'resize' && args[2]) || (command === 'move-tab' && args[1]) || (command === 'tabs' && args[0]);
if (extensionOnly.includes(command) || targetsWindow) throw new Error('This action requires the Kennect Browser extension. Open the website and click Connect.');
```

Add the four new commands to the existing switch's extension-only list as well, so the error stays correct if the early guard is ever bypassed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="window commands require|window targeting" controller.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add controller.mjs controller.test.mjs
git commit -m "feat: route window commands to the extension"
```

---

### Task 10: Version bump, documentation, and full verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `extension/manifest.json`, `extension.test.mjs`, `README.md`, `skills/kennect-browser/SKILL.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: version 0.4.0 everywhere; user-facing documentation.

- [ ] **Step 1: Bump the version**

Set `0.4.0` in `package.json`, the two `version` fields in `package-lock.json`, `extension/manifest.json`, and change the extension hello assertion in `extension.test.mjs` from `0.3.1` to `0.4.0`. `server.mjs` was already bumped in Task 8.

- [ ] **Step 2: Update README**

Add to Features: window creation, listing, targeting, names, claims, and closing. Add to Known limitations: window names and claims reset with browser/extension restarts; bounds are outer dimensions; only tool-created windows can be closed; window operations require the extension. Add usage examples for `windows` and `open-window`.

- [ ] **Step 3: Add the skill section**

Add a "Windows and claims" section to `skills/kennect-browser/SKILL.md` covering: call `browser_windows` first; name and claim task windows; pass explicit `windowId`; a claim does not block page reads; verify `innerWidth`/`innerHeight` after resize; release or close task windows when finished; names and claims are coordination, not security.

- [ ] **Step 4: Verify version consistency**

Run: `grep -n '"version"' package.json extension/manifest.json && grep -n 'version:' server.mjs && grep -n "0\.4\.0" extension.test.mjs`
Expected: every location reports `0.4.0`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. The three live tests remain skipped without `KENNECT_BROWSER_LIVE_TESTS=1`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json extension/manifest.json extension.test.mjs README.md skills/kennect-browser/SKILL.md
git commit -m "release: version 0.4.0 with window lifecycle"
```

- [ ] **Step 7: Live verification (manual, requires Chrome)**

1. Reload the extension in `chrome://extensions`.
2. Create two windows with different bounds and names.
3. Evaluate `innerWidth` / `innerHeight` in each with explicit `tabId`; confirm they differ.
4. Resize one by `windowId`; confirm the other is unchanged.
5. From a second controller process with a different `KENNECT_BROWSER_SESSION_ID`, attempt the same resize; confirm the claim refusal.
6. Confirm `snapshot` still works from the second session.
7. Release or close the task windows; confirm no user window is affected.

If Chrome is unavailable in the execution environment, report steps 2-7 as not run rather than claiming they passed.

---

## Self-Review

**Spec coverage:** Session identity (Task 1), registry and listing (Task 2), create (Task 3), update (Task 4), close (Task 5), claims/leases/enforcement/renewal (Task 6), window targeting and implicit resolution (Task 7), MCP surface (Task 8), controller fallback (Task 9), versions and docs (Task 10). All spec sections map to a task.

**Type consistency:** `sessionId` is a string throughout; `windowId` is an integer in the extension and a number in MCP schemas; `tabId` remains a string at the MCP boundary and a number in the extension; claim fields are `ownerSession`, `claimedAt`, `leaseUntil`, `leaseMs`.

**Review Focus coverage:** stale/recycled IDs (Tasks 4 and 5), concurrent writes (Task 3), name normalization (Task 3), implicit claim bypass (Task 7), lease expiry/renewal (Task 6).
