# Device Emulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-tab CDP device emulation so agents can hold exact mobile and desktop viewports independent of the real Chrome window.

**Architecture:** `extension/worker.js` adds an `emulations` map in session storage, CDP apply/clear helpers, two commands, and per-tab reporting in `browser_tabs`. Ordinary tab actions reapply stored emulation after a debugger reattach; emulation commands use an attach-only path so claims are checked before any apply. `server.mjs` exposes two tools; `controller.mjs` routes the CLI commands.

**Tech Stack:** Chrome MV3 extension, `chrome.debugger` → CDP `Emulation.*`, `chrome.storage.session`, Node.js 24, MCP stdio, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-16-device-emulation-design.md`

## Global Constraints

- Node.js 24 or newer; no new dependencies.
- Version `0.6.0` in `package.json`, both `package-lock.json` fields, `extension/manifest.json`, `server.mjs` `serverInfo`, and the extension hello test/fake manifest.
- Emulation is per tab; no window is resized.
- Width and height 100–4000; `deviceScaleFactor` 1–4; orientation enum `portraitPrimary`, `portraitSecondary`, `landscapePrimary`, `landscapeSecondary`.
- Defaults: DPR 1, `mobile: false`, `touch: false`, no UA override, no orientation.
- Original UA is the extension's `navigator.userAgent`, never the page's.
- Re-emulation replaces state; omitting `userAgent` removes a previous override by restoring the original.
- State lives in `chrome.storage.session` key `emulations`; reapplied after debugger reattach, cleared on tab close and explicit disconnect.
- A failed reapply fails the page action and keeps the stored state; clear remains reachable through the attach-only path.
- Reapply is restoration, not a claim-checked mutation; emulation start/clear are claim-checked.
- `browser_tabs` reports requested `emulation` and `emulationActive`; it never returns `originalUserAgent`.
- Extension-only; the CDP fallback returns the existing "requires the Kennect Browser extension" error.
- Every task ends with `npm test` passing and a commit.

## Review Focus

- Re-emulating without a `userAgent` must remove an earlier UA override — Task 1 test.
- A failed reapply must fail the page action and keep state, while clear still works — Task 2 tests.
- A non-owner must not apply or clear emulation before the claim check — Task 1 claim test uses the attach-only resolver.
- `browser_tabs` must distinguish requested state from currently applied state — Task 1 and Task 2 tests.
- Screenshot pixels scale by DPR, so coordinates need conversion — documented and live-checked in Task 5.

---

## File Structure

- `extension/worker.js` — emulation state, CDP helpers, commands, reapply, tab reporting.
- `extension.test.mjs` — fake debugger param recording and emulation tests.
- `server.mjs` — `browser_emulate_device`, `browser_clear_device_emulation`, descriptions, version.
- `controller.mjs`, `controller.test.mjs` — CLI routing and fallback errors.
- `mcp.test.mjs` — tool/schema tests.
- `README.md`, `skills/kennect-browser/SKILL.md` — documentation.
- `package.json`, `package-lock.json`, `extension/manifest.json`, `extension.test.mjs` — version 0.6.0.
- `docs/superpowers/specs/2026-11-16-device-emulation-design.md`,
  `docs/superpowers/plans/2026-11-16-device-emulation.md` — committed with the release.

---

### Task 1: Core emulation commands and tab reporting

**Files:**
- Modify: `extension/worker.js`
- Modify: `extension.test.mjs`

**Interfaces:**
- Produces: `EMULATION_KEY`, `emulations`, `emulationApplied`, `emulationsReady`, `withEmulationState(fn)`, `saveEmulations()`, `validateEmulation(options)`, `publicEmulation(state)`, `applyEmulation(tabId, state)`, `clearEmulation(tabId, state)`, `emulateDevice(options, sessionId, tabId)`, `clearDeviceEmulation(sessionId, tabId)`, `tabForEmulation(id)`, and worker commands `emulate-device` / `clear-emulation`.
- Produces: `browser_tabs` fields `emulation` and `emulationActive`.

- [ ] **Step 1: Write the failing core tests**

Add to `extension.test.mjs`:

```js
test('device emulation applies exact CDP metrics',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 const result=JSON.parse(await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,deviceScaleFactor:3,mobile:true,touch:true,userAgent:'MobileUA',orientation:'portraitPrimary'})],tabId:1,sessionId:'agent-a'}));
 assert.equal(result.applied,true);assert.equal(result.width,390);assert.equal(result.height,844);
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setDeviceMetricsOverride').params,{width:390,height:844,deviceScaleFactor:3,mobile:true,screenOrientation:{type:'portraitPrimary',angle:0}});
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setTouchEmulationEnabled').params,{enabled:true,maxTouchPoints:5});
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setEmitTouchEventsForMouse').params,{enabled:true,configuration:'mobile'});
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setUserAgentOverride').params,{userAgent:'MobileUA'});
});
test('device emulation defaults to desktop without touch',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:1440,height:1000})],tabId:1,sessionId:'agent-a'});
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setDeviceMetricsOverride').params,{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setTouchEmulationEnabled').params,{enabled:false});
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setEmitTouchEventsForMouse').params,{enabled:false});
});
test('device emulation clears and restores the original UA',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,userAgent:'MobileUA'})],tabId:1,sessionId:'agent-a'});
 calls.length=0;
 const result=JSON.parse(await e.scope.action({command:'clear-emulation',args:[],tabId:1,sessionId:'agent-a'}));
 assert.equal(result.cleared,true);
 assert.ok(calls.some(c=>c.method==='Emulation.clearDeviceMetricsOverride'));
 assert.deepEqual(calls.find(c=>c.method==='Emulation.setUserAgentOverride').params,{userAgent:'test-agent'});
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('re-emulation without a userAgent removes the override',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,userAgent:'MobileUA'})],tabId:1,sessionId:'agent-a'});
 calls.length=0;
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:1440,height:1000})],tabId:1,sessionId:'agent-a'});
 assert.deepEqual(calls[0].params,{userAgent:'test-agent'});
 assert.equal(calls.some(c=>c.method==='Emulation.setUserAgentOverride'&&c.params.userAgent==='MobileUA'),false);
 assert.equal(e.sessionSaved.emulations[1].userAgent,null);
});
test('device emulation rejects invalid metrics before CDP',async()=>{
 const e=await environment();await e.connect();
 const calls=[];e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 for(const options of [{},{width:99,height:844},{width:390,height:844,deviceScaleFactor:5},{width:390,height:844,orientation:'sideways'},{width:390,height:844,userAgent:'bad\u0001ua'}]){
  await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify(options)],tabId:1,sessionId:'agent-a'}),/Invalid/);
 }
 assert.equal(calls.length,0);
});
test('a window claim blocks emulation from another session',async()=>{
 const e=await environment();await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'locked',claim:true})],sessionId:'agent-a'}));
 const tabId=Number(opened.tabId);
 await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId,sessionId:'agent-b'}),/claimed by another agent/i);
 await assert.rejects(e.scope.action({command:'clear-emulation',args:[],tabId,sessionId:'agent-b'}),/claimed by another agent/i);
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId,sessionId:'agent-a'});
 await e.scope.action({command:'clear-emulation',args:[],tabId,sessionId:'agent-a'});
});
test('tab listing reports requested and active emulation',async()=>{
 const e=await environment();await e.connect();
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,deviceScaleFactor:3,mobile:true,touch:true,orientation:'portraitPrimary'})],tabId:1,sessionId:'agent-a'});
 const tabs=JSON.parse(await e.scope.action({command:'tabs'}));
 const tab=tabs.find(t=>t.tabId==='1');
 assert.deepEqual(tab.emulation,{width:390,height:844,deviceScaleFactor:3,mobile:true,touch:true,userAgent:null,orientation:'portraitPrimary'});
 assert.equal(tab.emulationActive,true);
 const other=tabs.find(t=>t.tabId==='2');
 assert.equal(other.emulation,null);assert.equal(other.emulationActive,false);
});
test('a CDP apply failure leaves no emulation state',async()=>{
 const e=await environment();await e.connect();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')throw Error('CDP failed');return{}};
 await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'}),/Could not apply device emulation/i);
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="device emulation|re-emulation|window claim blocks emulation|tab listing reports requested|CDP apply failure" extension.test.mjs`
Expected: FAIL — unsupported browser command.

- [ ] **Step 3: Implement the core**

Add near the window registry helpers:

```js
const EMULATION_KEY='emulations';
let emulations={};
const emulationApplied=new Set();
const emulationsReady=chrome.storage.session.get(EMULATION_KEY).then(saved=>{emulations=Object.assign({},saved?.[EMULATION_KEY]??{})}).catch(()=>{});
let emulationQueue=Promise.resolve();
function withEmulationState(fn){const run=emulationQueue.then(async()=>{await emulationsReady;return fn()});emulationQueue=run.catch(()=>{});return run}
async function saveEmulations(){await chrome.storage.session.set({[EMULATION_KEY]:emulations})}
const originalUserAgent=globalThis.navigator?.userAgent??'';
const orientationAngles={portraitPrimary:0,landscapePrimary:90,portraitSecondary:180,landscapeSecondary:270};
```

Add:

```js
function validateEmulation(options){
 if(!Number.isInteger(options.width)||options.width<100||options.width>4000)throw Error('Invalid emulation width.');
 if(!Number.isInteger(options.height)||options.height<100||options.height>4000)throw Error('Invalid emulation height.');
 const deviceScaleFactor=options.deviceScaleFactor??1;
 if(typeof deviceScaleFactor!=='number'||!Number.isFinite(deviceScaleFactor)||deviceScaleFactor<1||deviceScaleFactor>4)throw Error('Invalid device scale factor.');
 if(options.mobile!==undefined&&typeof options.mobile!=='boolean')throw Error('Invalid mobile flag.');
 if(options.touch!==undefined&&typeof options.touch!=='boolean')throw Error('Invalid touch flag.');
 let userAgent=null;
 if(options.userAgent!==undefined){
  if(typeof options.userAgent!=='string')throw Error('Invalid user agent.');
  userAgent=options.userAgent.trim();
  if(!userAgent||userAgent.length>500||/[\u0000-\u001f\u007f]/.test(userAgent))throw Error('Invalid user agent.');
 }
 const orientation=options.orientation??null;
 if(orientation!==null&&!Object.hasOwn(orientationAngles,orientation))throw Error('Invalid orientation.');
 return{width:options.width,height:options.height,deviceScaleFactor,mobile:options.mobile===true,touch:options.touch===true,userAgent,orientation};
}
function publicEmulation(state){return{width:state.width,height:state.height,deviceScaleFactor:state.deviceScaleFactor,mobile:state.mobile,touch:state.touch,userAgent:state.userAgent??null,orientation:state.orientation??null}}
async function applyEmulation(id,state){
 await cdp(id,'Emulation.setDeviceMetricsOverride',{width:state.width,height:state.height,deviceScaleFactor:state.deviceScaleFactor,mobile:state.mobile,...(state.orientation?{screenOrientation:{type:state.orientation,angle:orientationAngles[state.orientation]}}:{})});
 await cdp(id,'Emulation.setTouchEmulationEnabled',{enabled:state.touch,...(state.touch?{maxTouchPoints:5}:{})});
 await cdp(id,'Emulation.setEmitTouchEventsForMouse',{enabled:state.touch,...(state.touch?{configuration:'mobile'}:{})});
 if(state.userAgent)await cdp(id,'Emulation.setUserAgentOverride',{userAgent:state.userAgent});
}
async function clearEmulation(id,state){
 await cdp(id,'Emulation.clearDeviceMetricsOverride');
 await cdp(id,'Emulation.setTouchEmulationEnabled',{enabled:false});
 await cdp(id,'Emulation.setEmitTouchEventsForMouse',{enabled:false});
 if(state?.userAgent&&state?.originalUserAgent)await cdp(id,'Emulation.setUserAgentOverride',{userAgent:state.originalUserAgent});
}
async function tabForEmulation(id){
 const targetId=id??connectedTab;if(!Number.isInteger(targetId))throw Error('Select a website tab first.');
 const t=await chrome.tabs.get(targetId);if(!t)throw Error('Tab not found. Take a fresh tabs list.');
 if(!t.url&&t.pendingUrl)t.url=t.pendingUrl;
 if(!allowed(t.url))throw Error('Browser internal pages and local files cannot be controlled.');
 if(!approved(t.url))throw Error('Open this website and click Connect in the Kennect Browser extension first.');
 await ensureAttached(t);
 return t;
}
async function emulateDevice(options,sessionId,tabId){
 const next=validateEmulation(options);
 return withEmulationState(async()=>{
  const t=await tabForEmulation(tabId?Number(tabId):undefined);
  assertWindowAccess(t.windowId,sessionId);
  const previous=emulations[t.id]??null;
  const state={...next,originalUserAgent:previous?.originalUserAgent??originalUserAgent};
  try{
   if(previous?.userAgent&&!state.userAgent)await cdp(t.id,'Emulation.setUserAgentOverride',{userAgent:state.originalUserAgent});
   await applyEmulation(t.id,state);
  }catch(error){
   await clearEmulation(t.id,state).catch(()=>{});
   delete emulations[t.id];emulationApplied.delete(t.id);await saveEmulations();
   throw Error(`Could not apply device emulation: ${error.message}`);
  }
  emulations[t.id]=state;emulationApplied.add(t.id);await saveEmulations();
  return JSON.stringify({tabId:String(t.id),...publicEmulation(state),applied:true});
 });
}
async function clearDeviceEmulation(sessionId,tabId){
 return withEmulationState(async()=>{
  const t=await tabForEmulation(tabId?Number(tabId):undefined);
  assertWindowAccess(t.windowId,sessionId);
  const state=emulations[t.id]??{originalUserAgent};
  try{await clearEmulation(t.id,state)}catch(error){
   delete emulations[t.id];emulationApplied.delete(t.id);await saveEmulations();
   throw Error(`Could not clear device emulation: ${error.message}`);
  }
  delete emulations[t.id];emulationApplied.delete(t.id);await saveEmulations();
  return JSON.stringify({tabId:String(t.id),cleared:true});
 });
}
```

- Change `tab()` to accept `reapply` only if needed later; Task 1 uses `tabForEmulation` for emulation commands.
- Change the `action` top to `await Promise.all([stateReady,windowsReady,emulationsReady]);`.
- Add dispatch before `open-window`:
  ```js
  if(command==='emulate-device')return emulateDevice(JSON.parse(args[0]||'{}'),sessionId,tabId);
  if(command==='clear-emulation')return clearDeviceEmulation(sessionId,tabId);
  ```
- Add to the `tabs` mapping:
  ```js
  emulation:emulations[t.id]?publicEmulation(emulations[t.id]):null,emulationActive:emulationApplied.has(t.id)
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="device emulation|re-emulation|window claim blocks emulation|tab listing reports requested|CDP apply failure" extension.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: add per-tab device emulation"
```

---

### Task 2: Persistence, reapply, and lifecycle cleanup

**Files:**
- Modify: `extension/worker.js`
- Modify: `extension.test.mjs`

**Interfaces:**
- Consumes: Task 1 emulation state and helpers.
- Produces: `applyStoredEmulation(tabId)`, `tab()` reapply, `chrome.debugger.onDetach` cleanup, `chrome.tabs.onRemoved` cleanup, and disconnect cleanup.

- [ ] **Step 1: Extend the fake Chrome**

In `extension.test.mjs`, change the fake `tabs` object to include:

```js
onRemoved:{addListener(fn){lifecycle.tabRemoved=fn}}
```

- [ ] **Step 2: Write the failing persistence tests**

```js
test('service worker restart reapplies stored emulation',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return method==='Accessibility.getFullAXTree'?{nodes:[]}:{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,deviceScaleFactor:2,mobile:true})],tabId:1,sessionId:'agent-a'});
 calls.length=0;
 await e.restart();
 await e.scope.action({command:'snapshot',tabId:1,sessionId:'agent-a'});
 assert.ok(calls.some(c=>c.method==='Emulation.setDeviceMetricsOverride'&&c.params.width===390));
 const tabs=JSON.parse(await e.scope.action({command:'tabs'}));
 assert.equal(tabs.find(t=>t.tabId==='1').emulationActive,true);
});
test('a failed reapply fails the page action and keeps the state',async()=>{
 const e=await environment();await e.connect();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')return{};return method==='Accessibility.getFullAXTree'?{nodes:[]}:{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 await e.restart();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')throw Error('reapply failed');return{}};
 await assert.rejects(e.scope.action({command:'snapshot',tabId:1,sessionId:'agent-a'}),/Could not reapply device emulation/i);
 assert.ok(e.sessionSaved.emulations[1]);
});
test('clear still works after a failed reapply',async()=>{
 const e=await environment();await e.connect();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')return{};return method==='Accessibility.getFullAXTree'?{nodes:[]}:{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 await e.restart();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')throw Error('reapply failed');return{}};
 await assert.rejects(e.scope.action({command:'snapshot',tabId:1,sessionId:'agent-a'}),/Could not reapply device emulation/i);
 e.scope.chrome.debugger.sendCommand=async()=>({});
 const result=JSON.parse(await e.scope.action({command:'clear-emulation',args:[],tabId:1,sessionId:'agent-a'}));
 assert.equal(result.cleared,true);
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('closing a tab clears its stored emulation',async()=>{
 const e=await environment();await e.connect();
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 assert.ok(e.sessionSaved.emulations[1]);
 e.lifecycle.tabRemoved(1);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('disconnect clears stored emulation',async()=>{
 const e=await environment();await e.connect();
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 await e.disconnect();
 assert.equal(e.sessionSaved.emulations,undefined);
});
```

- [ ] **Step 3: Run them and verify they fail**

Run: `node --test --test-name-pattern="service worker restart reapplies|failed reapply|clear still works|closing a tab clears|disconnect clears stored" extension.test.mjs`
Expected: FAIL — emulation is not reapplied or cleared.

- [ ] **Step 4: Implement persistence and cleanup**

- Add `applyStoredEmulation`:
  ```js
  async function applyStoredEmulation(id){
   return withEmulationState(async()=>{
    const state=emulations[id];if(!state||emulationApplied.has(id))return;
    try{await applyEmulation(id,state);emulationApplied.add(id)}
    catch(error){throw Error(`Could not reapply device emulation: ${error.message}`)}
   });
  }
  ```
- Change `tab()` to call `await ensureAttached(t);await applyStoredEmulation(t.id);` for ordinary page actions. `tabForEmulation` remains attach-only.
- `chrome.debugger.onDetach`: add `emulationApplied.delete(tabId);`.
- Add:
  ```js
  chrome.tabs.onRemoved.addListener(tabId=>{emulationApplied.delete(tabId);if(emulations[tabId])void withEmulationState(async()=>{delete emulations[tabId];await saveEmulations()}).catch(()=>{})});
  ```
- In the popup `disconnect` handler, clear emulation state and remove the storage key:
  ```js
  emulations={};emulationApplied.clear();await chrome.storage.session.remove(['approvedOrigins','connectedTab',EMULATION_KEY]);
  ```
  Keep the existing detach loop.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="service worker restart reapplies|failed reapply|clear still works|closing a tab clears|disconnect clears stored" extension.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add extension/worker.js extension.test.mjs
git commit -m "feat: persist and reapply device emulation"
```

---

### Task 3: MCP tools and schemas

**Files:**
- Modify: `server.mjs`
- Test: `mcp.test.mjs`

**Interfaces:**
- Consumes: worker commands `emulate-device` and `clear-emulation`.
- Produces: MCP tools `browser_emulate_device` and `browser_clear_device_emulation`.

- [ ] **Step 1: Write the failing MCP tests**

Add to `mcp.test.mjs`:

```js
assert.ok(names.includes('browser_emulate_device'));
assert.ok(names.includes('browser_clear_device_emulation'));
const emulateTool=list.result.tools.find(t=>t.name==='browser_emulate_device');
assert.deepEqual(emulateTool.inputSchema.required,['width','height']);
assert.deepEqual(emulateTool.inputSchema.properties.orientation.enum,['portraitPrimary','portraitSecondary','landscapePrimary','landscapeSecondary']);
assert.equal(emulateTool.inputSchema.properties.deviceScaleFactor.minimum,1);
assert.equal(emulateTool.inputSchema.properties.deviceScaleFactor.maximum,4);
const badEmulationWidth=await call('tools/call',{name:'browser_emulate_device',arguments:{width:99,height:844}});
assert.equal(badEmulationWidth.error.code,-32602);
const badEmulationDpr=await call('tools/call',{name:'browser_emulate_device',arguments:{width:390,height:844,deviceScaleFactor:5}});
assert.equal(badEmulationDpr.error.code,-32602);
const badEmulationOrientation=await call('tools/call',{name:'browser_emulate_device',arguments:{width:390,height:844,orientation:'sideways'}});
assert.equal(badEmulationOrientation.error.code,-32602);
const unknownEmulationArg=await call('tools/call',{name:'browser_emulate_device',arguments:{width:390,height:844,bogus:1}});
assert.equal(unknownEmulationArg.error.code,-32602);
const clearEmulation=list.result.tools.find(t=>t.name==='browser_clear_device_emulation');
assert.ok(clearEmulation.inputSchema.properties.tabId);
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test --test-name-pattern="MCP discovers" mcp.test.mjs`
Expected: FAIL — the tools are missing.

- [ ] **Step 3: Implement the tools**

- Add `browser_emulate_device`:
  - properties: `tabId`, `width` integer 100–4000, `height` integer 100–4000, `deviceScaleFactor` number 1–4, `mobile` boolean, `touch` boolean, `userAgent` string 1–500, `orientation` enum;
  - required `['width','height']`;
  - description: exact per-tab viewport; does not resize the window; screenshots scale by DPR; claims enforced; clear when done.
- Add `browser_clear_device_emulation`: `{tabId}`; description.
- Command map:
  ```js
  browser_emulate_device:['emulate-device',JSON.stringify({width:args.width,height:args.height,deviceScaleFactor:args.deviceScaleFactor,mobile:args.mobile,touch:args.touch,userAgent:args.userAgent,orientation:args.orientation})],
  browser_clear_device_emulation:['clear-emulation'],
  ```
- Update `browser_resize` description to point at `browser_emulate_device` for exact viewports.
- Bump `serverInfo.version` to `0.6.0` and add to instructions:
  "Use browser_emulate_device for exact per-tab mobile or desktop viewports; window resizing is clamped by Chrome."

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern="MCP discovers" mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add server.mjs mcp.test.mjs
git commit -m "feat: expose device emulation over MCP"
```

---

### Task 4: Controller commands

**Files:**
- Modify: `controller.mjs`
- Test: `controller.test.mjs`

**Interfaces:**
- Consumes: Task 3 command names.
- Produces: CLI `emulate-device [JSON]` and `clear-emulation`, with extension-only errors in fallback.

- [ ] **Step 1: Write the failing controller tests**

Add to `controller.test.mjs`:

```js
test('device emulation commands require the extension',()=>{
 for(const args of [['emulate-device','{"width":390,"height":844}'],['clear-emulation']]){
  const r=run(...args);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/requires the Kennect Browser extension/);
 }
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test --test-name-pattern="device emulation commands require" controller.test.mjs`
Expected: FAIL — the commands hit the dedicated-browser path.

- [ ] **Step 3: Implement the guard**

Add `'emulate-device'` and `'clear-emulation'` to the controller's `extensionOnly` list and to the switch's extension-only case list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern="device emulation commands require" controller.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add controller.mjs controller.test.mjs
git commit -m "feat: route device emulation commands"
```

---

### Task 5: Version 0.6.0, documentation, and live verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `extension/manifest.json`, `extension.test.mjs`, `README.md`, `skills/kennect-browser/SKILL.md`
- Add: `docs/superpowers/specs/2026-11-16-device-emulation-design.md`, `docs/superpowers/plans/2026-11-16-device-emulation.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: version 0.6.0 and user-facing documentation.

- [ ] **Step 1: Bump the version**

Set `0.6.0` in `package.json`, both `package-lock.json` fields, `extension/manifest.json`, and the extension hello assertion plus fake `getManifest` in `extension.test.mjs`. `server.mjs` was bumped in Task 3.

- [ ] **Step 2: Update README**

- Features: add per-tab device emulation with exact dimensions, DPR, mobile, touch, UA, and orientation.
- Usage: add `node controller.mjs emulate-device '{"width":390,"height":844,"deviceScaleFactor":3,"mobile":true,"touch":true}'` and `node controller.mjs clear-emulation`.
- Known limitations: replace the window-width caveat with "window resizing is clamped; use device emulation for exact viewports. Emulation is per tab, is not a real device fingerprint, resets and reapplies with the debugger, and screenshots scale by DPR."

- [ ] **Step 3: Add the skill section**

Add "Device emulation" to `skills/kennect-browser/SKILL.md`:
- Per-tab; does not resize the window.
- Verify `innerWidth`, `innerHeight`, `devicePixelRatio` after applying.
- Screenshot dimensions are viewport × DPR; divide screenshot coordinates by DPR before mouse/zoom.
- Touch and UA are optional; a failed reapply blocks until clear.
- Claims on the tab's window are enforced; clear emulation when finished.

- [ ] **Step 4: Verify version consistency**

Run: `grep -n '"version"' package.json extension/manifest.json package-lock.json && grep -n "version:'0.6.0'" server.mjs && grep -n "0\.6\.0" extension.test.mjs`
Expected: every location reports `0.6.0`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. Three live tests remain skipped without `KENNECT_BROWSER_LIVE_TESTS=1`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json extension/manifest.json extension.test.mjs README.md skills/kennect-browser/SKILL.md docs/superpowers/specs/2026-11-16-device-emulation-design.md docs/superpowers/plans/2026-11-16-device-emulation.md
git commit -m "release: version 0.6.0 with device emulation"
```

- [ ] **Step 7: Live verification (manual)**

1. Open a connected tab (`open-tab https://example.com/`).
2. Emulate 390×844 at DPR 3, mobile, touch.
3. Evaluate `innerWidth`, `innerHeight`, `devicePixelRatio`; expect 390, 844, 3.
4. Screenshot; expect a 1170×2532 PNG.
5. Emulate a second tab at 1440×1000 in the same window; verify each tab keeps its own viewport.
6. From another session, attempt to emulate a tab in a claimed window; expect refusal.
7. Snapshot from the other session; expect success.
8. Clear both; verify `innerWidth` returns to the real window viewport.

If Chrome is unavailable, report the live steps as not run.

---

## Self-Review

**Spec coverage:** core apply/clear and reporting (Task 1), persistence/reapply/cleanup (Task 2), MCP surface (Task 3), controller (Task 4), version/docs/live (Task 5). All spec sections map to a task.

**Type consistency:** emulation state is `{width, height, deviceScaleFactor, mobile, touch, userAgent, orientation, originalUserAgent}`; public state omits `originalUserAgent`; `tabId` is a string at the MCP boundary and a number in the worker; orientation values match the enum.

**Review Focus coverage:** UA removal (Task 1), failed reapply and clear (Task 2), claim check via attach-only (Task 1), requested vs active reporting (Tasks 1-2), DPR documentation/live (Task 5).
