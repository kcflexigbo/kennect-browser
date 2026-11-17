# Window Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent explicitly adopt a Chrome window it opened outside `browser_open_window`, so it can name, claim, and close that window without weakening the guard against closing user windows.

**Architecture:** Add `browser_adopt_window` plus the controller command `adopt-window`. Adoption creates a session-registry entry marked `createdByTool:false, adopted:true` with provenance; `browser_windows` reports it; `closeWindow` accepts adopted entries. The last-normal-window guard and the claim model stay unchanged.

**Tech Stack:** Node.js 24+, Node test runner, Chrome MV3 extension, MCP stdio server.

**Spec:** `docs/superpowers/specs/2026-11-17-adopt-window-design.md`

## Global Constraints

- No new dependencies.
- Node test runner: `npm test` (which is `node --test *.test.mjs`).
- Do not add `Co-Authored-By` trailers to any commit (user preference).
- The window registry is session-scoped in `chrome.storage.session`.
- Adoption records provenance; it is not a claim. Claims stay on `browser_update_window`.
- Never auto-close an untracked window. Adoption is the only new path to closing one.
- Keep the last-normal-window guard and existing claim behavior unchanged.
- Version after this branch: 0.7.0.

## Review Focus

- Adopting an already tool-created or already adopted window must not flip its provenance or reset `adoptedBy` / `adoptedAt`.
- An adopted window that is the last normal window must still be refused by the close guard.
- A claim held by another session must still block closing an adopted window unless `force` is passed.
- An unknown or already-closed window ID must fail adoption clearly and leave no registry entry.
- Closing an adopted window must remove its registry entry and the window listing must show `createdByTool:false` plus `adopted:true`.

---

### Task 1: Worker adoption path and extension tests

**Files:**
- Modify: `extension/worker.js` (`windowSummary`, `closeWindow`, new `adoptWindow`, action dispatch)
- Test: `extension.test.mjs`

**Interfaces:**
- Produces: `adoptWindow(windowId: number, sessionId: string): Promise<string>` returning a JSON window summary.
- Produces: action command `adopt-window` with `args: [String(windowId)]`.
- Produces: registry fields `adopted: true`, `adoptedAt: number`, `adoptedBy: string`, `createdByTool: false`.
- Produces: `windowSummary` fields `adopted: boolean`, `adoptedAt: string|null`, `adoptedBy: string|null`.

- [ ] **Step 1: Write the failing extension tests**

Add these tests to `extension.test.mjs`. Use the existing `environment()` helper and `scope.action` shape.

```js
test('adopting an untracked window records provenance and allows close',async()=>{
 const e=await environment();
 await e.connect();
 const raw=await e.scope.chrome.windows.create({url:'https://example.com/raw'});
 const adopted=JSON.parse(await e.scope.action({command:'adopt-window',args:[String(raw.id)],sessionId:'agent-a'}));
 assert.equal(adopted.windowId,raw.id);
 assert.equal(adopted.createdByTool,false);
 assert.equal(adopted.adopted,true);
 assert.equal(adopted.adoptedBy,'agent-a');
 const listed=JSON.parse(await e.scope.action({command:'windows',args:[],sessionId:'agent-a'})).windows.find(w=>w.windowId===raw.id);
 assert.equal(listed.adopted,true);
 assert.equal(listed.createdByTool,false);
 const closed=JSON.parse(await e.scope.action({command:'close-window',args:[String(raw.id),''],sessionId:'agent-a'}));
 assert.equal(closed.closed,true);
 assert.equal(e.windows.has(raw.id),false);
 assert.equal(e.sessionSaved.windowRegistry[raw.id],undefined);
});
test('adoption is idempotent and never changes a tool-created window',async()=>{
 const e=await environment();
 await e.connect();
 const raw=await e.scope.chrome.windows.create({url:'https://example.com/raw'});
 const first=JSON.parse(await e.scope.action({command:'adopt-window',args:[String(raw.id)],sessionId:'agent-a'}));
 const second=JSON.parse(await e.scope.action({command:'adopt-window',args:[String(raw.id)],sessionId:'agent-b'}));
 assert.equal(second.adopted,true);
 assert.equal(second.adoptedBy,'agent-a');
 assert.equal(second.adoptedAt,first.adoptedAt);
 const tool=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/tool'})],sessionId:'agent-a'}));
 const toolAdopt=JSON.parse(await e.scope.action({command:'adopt-window',args:[String(tool.windowId)],sessionId:'agent-b'}));
 assert.equal(toolAdopt.createdByTool,true);
 assert.equal(toolAdopt.adopted,false);
 assert.equal(e.sessionSaved.windowRegistry[tool.windowId].adopted,undefined);
});
test('adopting an unknown window fails',async()=>{
 const e=await environment();await e.connect();
 await assert.rejects(e.scope.action({command:'adopt-window',args:['999'],sessionId:'agent-a'}),/Unknown window/i);
});
test('the last-window guard still refuses an adopted window',async()=>{
 const e=await environment();await e.connect();
 const raw=await e.scope.chrome.windows.create({url:'https://example.com/raw'});
 await e.scope.action({command:'adopt-window',args:[String(raw.id)],sessionId:'agent-a'});
 e.windows.delete(1);e.pages.delete(1);
 await assert.rejects(e.scope.action({command:'close-window',args:[String(raw.id),''],sessionId:'agent-a'}),/only Chrome window/i);
});
test('a claim on an adopted window blocks another session from closing it',async()=>{
 const e=await environment();await e.connect();
 const raw=await e.scope.chrome.windows.create({url:'https://example.com/raw'});
 await e.scope.action({command:'adopt-window',args:[String(raw.id)],sessionId:'agent-a'});
 await e.scope.action({command:'update-window',args:[String(raw.id),JSON.stringify({name:'adopted',claim:true})],sessionId:'agent-a'});
 await assert.rejects(e.scope.action({command:'close-window',args:[String(raw.id),''],sessionId:'agent-b'}),/claimed by another agent/i);
});
```

Also update the existing `closing windows refuses untracked and last windows` test so its refusal assertion names adoption:

```js
await assert.rejects(e.scope.action({command:'close-window',args:['1',''],sessionId:'agent-a'}),error=>{
 assert.match(error.message,/created by browser_open_window/i);
 assert.match(error.message,/browser_adopt_window/i);
 return true;
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test --test-name-pattern="adopt|last-window guard|claim on an adopted" extension.test.mjs`
Expected: FAIL — the `adopt-window` command is unknown and the refusal does not name `browser_adopt_window`.

- [ ] **Step 3: Implement the worker changes**

In `extension/worker.js`, add the provenance fields to `windowSummary` after `createdByTool`:

```js
adopted:entry?.adopted??false,adoptedAt:entry?.adoptedAt?new Date(entry.adoptedAt).toISOString():null,adoptedBy:entry?.adoptedBy?ownerLabel(entry.adoptedBy):null,
```

Add `adoptWindow` next to the other window functions:

```js
async function adoptWindow(windowId,sessionId){
 if(!Number.isInteger(windowId)||windowId<0)throw Error('Invalid window ID.');
 return withWindowRegistry(async()=>{
  const all=await chrome.windows.getAll({windowTypes:['normal']});
  const live=new Set(all.map(w=>w.id));
  pruneWindowRegistry(live);
  if(!live.has(windowId))throw Error('Unknown window ID. Refresh with browser_windows.');
  let entry=windowRegistry[windowId];
  if(!entry){
   entry={windowId,name:null,purpose:null,createdByTool:false,adopted:true,adoptedAt:Date.now(),adoptedBy:sessionId,ownerSession:null,claimedAt:null,leaseUntil:null,leaseMs:1800000,createdAt:Date.now()};
   windowRegistry[windowId]=entry;
   await saveWindowRegistry();
  }
  const win=await chrome.windows.get(windowId);
  const tabs=await chrome.tabs.query({windowId});
  return JSON.stringify(windowSummary(win,entry,sessionId,tabs));
 });
}
```

Change the close guard in `closeWindow`:

```js
if(!entry?.createdByTool&&!entry?.adopted)throw Error('Only windows created by browser_open_window or adopted with browser_adopt_window can be closed. Adopt the window first or close user windows manually.');
```

Add the dispatch next to the other window commands in `action`:

```js
if(command==='adopt-window')return adoptWindow(Number(args[0]),sessionId);
```

- [ ] **Step 4: Run the extension tests to verify they pass**

Run: `node --test --test-name-pattern="adopt|last-window guard|claim on an adopted|closing windows refuses" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: adopt untracked windows for closing"
```

---

### Task 2: MCP tool and controller command

**Files:**
- Modify: `server.mjs` (tool list, command map, server instructions)
- Modify: `mcp.test.mjs`
- Modify: `controller.mjs` (`extensionOnly`, dedicated-profile switch fallback)
- Test: `controller.test.mjs`

**Interfaces:**
- Consumes: action command `adopt-window` with `args: [String(windowId)]` from Task 1.
- Produces: MCP tool `browser_adopt_window` with required `windowId` (integer, minimum 0).
- Produces: controller command `adopt-window <windowId>`.

- [ ] **Step 1: Write the failing MCP and controller tests**

In `mcp.test.mjs`, after the existing `browser_close_window` assertions, add:

```js
assert.ok(names.includes('browser_adopt_window'));
const adoptWindow=list.result.tools.find(t=>t.name==='browser_adopt_window');
assert.deepEqual(adoptWindow.inputSchema.required,['windowId']);
assert.equal(adoptWindow.annotations.readOnlyHint,false);
assert.match(adoptWindow.description,/user authorization/i);
assert.match(adoptWindow.description,/never adopt/i);
const badAdopt=await call('tools/call',{name:'browser_adopt_window',arguments:{windowId:-1}});
assert.equal(badAdopt.error.code,-32602);
assert.match(list.result.tools.find(t=>t.name==='browser_windows').description,/adopt/i);
assert.match(list.result.tools.find(t=>t.name==='browser_close_window').description,/adopt/i);
assert.match(list.result.tools.find(t=>t.name==='browser_update_window').description,/adopt/i);
```

In `controller.test.mjs`, add `['adopt-window','1']` to the loop in `window commands require the extension`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test mcp.test.mjs controller.test.mjs`
Expected: FAIL — the MCP tool is missing and `adopt-window` does not produce the extension-only error.

- [ ] **Step 3: Implement the MCP and controller surface**

In `server.mjs`, add the tool next to `browser_close_window`:

```js
tool('browser_adopt_window','Adopt a live Chrome window that browser_open_window did not create, so it can be named, claimed, and closed in this browser session. Call only after explicit user authorization; never adopt a window the agent did not open.',{windowId:{type:'integer',minimum:0}},['windowId']),
```

Add the command map entry beside the other window commands:

```js
browser_adopt_window:['adopt-window',String(args.windowId)],
```

Add this sentence to the `serverInfo.instructions` string: `Adopt a window you opened outside Kennect with browser_adopt_window only after user authorization; never adopt a user window.`

Update the agent-facing descriptions so adoption is discoverable:

- `browser_windows`: mention adoption provenance and that untracked windows can be adopted.
- `browser_close_window`: say “created by browser_open_window or adopted with browser_adopt_window”.
- `browser_update_window`: say “tool-created or adopted window”.

Add assertions to `mcp.test.mjs` that those three descriptions match `/adopt/i`.

In `controller.mjs`, add `'adopt-window'` to `extensionOnly` and add `case 'adopt-window':` to the dedicated-profile switch fallback that throws `This action requires the Kennect Browser extension...`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test mcp.test.mjs controller.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add server.mjs mcp.test.mjs controller.mjs controller.test.mjs
git commit -m "feat: expose window adoption over MCP and CLI"
```

---

### Task 3: Documentation and version 0.7.0

**Files:**
- Modify: `skills/kennect-browser/SKILL.md` (Windows and claims section)
- Modify: `README.md` (features, usage, limitations)
- Modify: `package.json`, `package-lock.json` (both version fields), `extension/manifest.json`
- Modify: `server.mjs` (`serverInfo.version`)
- Modify: `extension.test.mjs` (fake `getManifest` version and hello assertion)

**Interfaces:**
- Consumes: `browser_adopt_window` / `adopt-window` from Tasks 1–2.

- [ ] **Step 1: Update the skill and README**

In `skills/kennect-browser/SKILL.md`:

- Change “Only windows created by `browser_open_window` in the current browser session can be closed” to “Only windows created by `browser_open_window` or adopted with `browser_adopt_window` in the current browser session can be closed”.
- Add: “If you opened a window outside Kennect (Chrome CLI or another tool), adopt it with `browser_adopt_window` after explicit user authorization, then use the existing rename/claim/close lifecycle. Adopt only a window you opened yourself; never adopt a user window.”

In `README.md`:

- Feature list: add adoption of agent-opened windows.
- Usage: add `node controller.mjs adopt-window <windowId>` near the window examples.
- Limitations: change “only windows created by the tool can be closed” to include adopted windows.

- [ ] **Step 2: Bump the version to 0.7.0**

Set `0.7.0` in `package.json`, both `0.6.0` version fields in `package-lock.json`, `extension/manifest.json`, the `serverInfo.version` in `server.mjs`, the fake `getManifest` version and the hello assertion in `extension.test.mjs`.

- [ ] **Step 3: Verify version consistency**

Run: `grep -n '"version"' package.json extension/manifest.json package-lock.json && grep -n "version:'0.7.0'" server.mjs && grep -n "0\.7\.0" extension.test.mjs`
Expected: every location reports `0.7.0`.

- [ ] **Step 4: Run the full suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add skills/kennect-browser/SKILL.md README.md package.json package-lock.json extension/manifest.json server.mjs extension.test.mjs
git commit -m "release: version 0.7.0 with window adoption"
```
