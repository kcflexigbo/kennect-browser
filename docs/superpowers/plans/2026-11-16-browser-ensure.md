# Browser Ensure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `browser_ensure`, which launches the user's real Chrome profile when no extension connection exists, waits for the Kennect Browser extension, and returns the connected profile so the window tools have a target.

**Architecture:** `profiles.mjs` gains Chrome profile discovery from `Local State` and the per-profile `Secure Preferences`/`Preferences`. A new `ensure.mjs` orchestrates reuse, profile selection, Chrome launch, and bridge polling with injected dependencies. `controller.mjs` routes an `ensure` command locally; `server.mjs` exposes `browser_ensure` with a per-call child timeout. Reuse is browser-agnostic; only launching is Chrome-only.

**Tech Stack:** Node.js 24, `node:child_process`, `node:fs/promises`, Chrome `Local State` / `Secure Preferences`, MCP stdio server, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-16-browser-ensure-design.md`

## Global Constraints

- Node.js 24 or newer; no new dependencies.
- Version `0.5.0` in `package.json`, both `package-lock.json` fields, `extension/manifest.json`, `server.mjs` `serverInfo`, and the extension hello test/fake manifest.
- v1 launches Chrome only; an already-connected Edge/Brave profile may be reused.
- v1 scans only the default stable Chrome user-data directory. Custom `--user-data-dir`, Chrome Beta, Canary, and SxS are unsupported with a clear error.
- Default timeout 30000 ms; accepted range 5000–60000 ms; exactly one launch attempt per call.
- Launch arguments: `--user-data-dir=<base>`, `--profile-directory=<dir>`, `--new-window`, `--no-first-run`, `--no-default-browser-check`, `about:blank`.
- `spawn` uses `detached: true`, `stdio: "ignore"`, and `unref()`.
- Server child timeout for `browser_ensure` is `ensureChildTimeout(timeoutMs) = min((timeoutMs ?? 30000) + 5000, 65000)`.
- Profile selection: `last_used` if extension-enabled; else the first extension-enabled directory in `last_active_profiles`; else the extension-enabled profile with the highest `active_time`; else fail before launching.
- Extension ID comes from `extension-id.txt`.
- No new manifest permissions; no extension code changes beyond the version bump.
- Reuse any responsive profile when no `profileDirectory` is requested, choosing the persisted default when responsive, else the first by `profileId`.
- Post-launch success requires a normalized directory match or a **new** profile ID; a pre-existing unrelated responsive profile never satisfies the poll.
- Every task ends with `npm test` passing and a commit.

## Review Focus

- Chrome's extension entry is in `Secure Preferences`, not `Preferences`, and a disabled entry is not the same as a missing one — Task 1 tests both files, `state: 0`, and `disable_reasons`.
- A different profile is already connected while the requested profile is not — the poll must not return the wrong profile — Task 3 test 10.
- The server's 15 s child timeout can kill a longer ensure wait — Task 2 tests `ensureChildTimeout`, Task 5 wires it into `execFile`.
- A paused or disconnected extension must produce a clear timeout, not an endless wait — Task 3 timeout test.
- A custom user-data-dir or Beta/Canary install has the extension but the default store does not — Task 1 missing-store test and Task 3 error message.

---

## File Structure

- `profiles.mjs` — export `defaultUserDataDir`; add `chromeProfiles`, `chooseExtensionProfile`.
- `ensure.mjs` (new) — `normalizeDirectory`, `buildLaunchArgs`, `findChromeExecutable`, `ensureChildTimeout`, `ensureBrowser`.
- `controller.mjs` — `ensure` command routed before the bridge path.
- `server.mjs` — `browser_ensure` tool, exclusion list, command map, per-call timeout, version/instructions.
- `package.json`, `package-lock.json`, `extension/manifest.json`, `extension.test.mjs` — version 0.5.0.
- `profiles.test.mjs` — Chrome profile fixture and discovery tests.
- `ensure.test.mjs` (new) — pure helper and orchestration tests with injected dependencies.
- `controller.test.mjs`, `mcp.test.mjs` — routing and schema tests.
- `README.md`, `skills/kennect-browser/SKILL.md` — documentation.
- `docs/superpowers/specs/2026-11-16-browser-ensure-design.md`,
  `docs/superpowers/plans/2026-11-16-browser-ensure.md` — committed with the release.

---

### Task 1: Chrome profile discovery

**Files:**
- Modify: `profiles.mjs` (export `defaultUserDataDir`; add `chromeProfiles`, `chooseExtensionProfile`)
- Test: `profiles.test.mjs`

**Interfaces:**
- Consumes: existing `readFile` import and `path` helpers in `profiles.mjs`.
- Produces:
  - `defaultUserDataDir(browser, {platform, home, env, exePath}) -> string` (exported).
  - `chromeProfiles({userDataDir, extensionId, readFileImpl?}) -> {userDataDir, lastUsed, lastActive, profiles: [{directory, name, activeTime, extensionEnabled, extensionPath}]}`.
  - `chooseExtensionProfile(scan) -> profile | null`.

- [ ] **Step 1: Write the failing fixture and tests**

Add to `profiles.test.mjs`:

```js
import {mkdir} from 'node:fs/promises';
import {chromeProfiles,chooseExtensionProfile,defaultUserDataDir} from './profiles.mjs';
const EXTENSION='bbnpijhhjbmhblobjckieabgmngeicbg';
async function chromeFixture({lastUsed='Default',lastActive=[],profiles}){
 const dir=await mkdtemp(join(tmpdir(),'kennect-chrome-profiles-'));
 const info={};
 for(const p of profiles){
  info[p.directory]={name:p.name??p.directory,...(p.activeTime!==undefined?{active_time:p.activeTime}:{})};
  await mkdir(join(dir,p.directory),{recursive:true});
  const settings=p.extension===undefined?{}:{[EXTENSION]:p.extension};
  await writeFile(join(dir,p.directory,p.file??'Secure Preferences'),JSON.stringify({extensions:{settings}}));
 }
 await writeFile(join(dir,'Local State'),JSON.stringify({profile:{last_used:lastUsed,last_active_profiles:lastActive,info_cache:info}}));
 return dir;
}
test('chrome profile scan prefers the last-used extension profile',async()=>{
 const dir=await chromeFixture({lastUsed:'Profile 1',lastActive:['Profile 2'],profiles:[{directory:'Default',activeTime:3},{directory:'Profile 1',activeTime:2,extension:{location:4}},{directory:'Profile 2',activeTime:1,extension:{location:4}}]});
 try{const scan=await chromeProfiles({userDataDir:dir,extensionId:EXTENSION});assert.equal(chooseExtensionProfile(scan).directory,'Profile 1');}finally{await rm(dir,{recursive:true,force:true})}
});
test('chrome profile scan falls back to recent and then active time',async()=>{
 // lastUsed lacks the extension; lastActive order wins over active_time.
 const a=await chromeFixture({lastUsed:'Default',lastActive:['Profile 2','Profile 1'],profiles:[{directory:'Default',activeTime:9},{directory:'Profile 1',activeTime:5,extension:{location:4}},{directory:'Profile 2',activeTime:1,extension:{location:4}}]});
 try{const scan=await chromeProfiles({userDataDir:a,extensionId:EXTENSION});assert.equal(chooseExtensionProfile(scan).directory,'Profile 2');}finally{await rm(a,{recursive:true,force:true})}
 const b=await chromeFixture({lastUsed:'Default',lastActive:[],profiles:[{directory:'Default',activeTime:9},{directory:'Profile 1',activeTime:2,extension:{location:4}},{directory:'Profile 2',activeTime:7,extension:{location:4}}]});
 try{const scan=await chromeProfiles({userDataDir:b,extensionId:EXTENSION});assert.equal(chooseExtensionProfile(scan).directory,'Profile 2');}finally{await rm(b,{recursive:true,force:true})}
});
test('chrome profile scan reads Preferences only when Secure Preferences is empty',async()=>{
 const dir=await chromeFixture({profiles:[{directory:'Default',extension:{location:4},file:'Preferences'}]});
 try{const scan=await chromeProfiles({userDataDir:dir,extensionId:EXTENSION});assert.equal(scan.profiles[0].extensionEnabled,true);}finally{await rm(dir,{recursive:true,force:true})}
});
test('chrome profile scan treats disabled entries and bad files as not enabled',async()=>{
 const dir=await chromeFixture({profiles:[{directory:'Default',extension:{state:0}},{directory:'Profile 1',extension:{location:4,disable_reasons:['DISABLE_NOT_VERIFIED']}}]});
 try{
  const scan=await chromeProfiles({userDataDir:dir,extensionId:EXTENSION});
  assert.ok(scan.profiles.every(p=>!p.extensionEnabled));
  assert.equal(chooseExtensionProfile(scan),null);
  await writeFile(join(dir,'Profile 1','Secure Preferences'),'not json');
  const again=await chromeProfiles({userDataDir:dir,extensionId:EXTENSION});
  assert.equal(again.profiles.length,2);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('chrome profile scan reports a missing Local State clearly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kennect-chrome-empty-'));
 try{await assert.rejects(chromeProfiles({userDataDir:dir,extensionId:EXTENSION}),/Local State|user-data-dir/);}finally{await rm(dir,{recursive:true,force:true})}
});
test('default user data directories are exported',()=>{
 assert.equal(defaultUserDataDir('chrome',{...windows,exePath:''}),'C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\User Data');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="chrome profile scan|default user data directories" profiles.test.mjs`
Expected: FAIL — `chromeProfiles`/`chooseExtensionProfile` are not exported.

- [ ] **Step 3: Implement the discovery**

- Change `function defaultUserDataDir` to `export function defaultUserDataDir`.
- Add `export async function chromeProfiles({userDataDir, extensionId, readFileImpl = readFile})`:
  - Read `<userDataDir>/Local State`; on failure throw an error naming the path and the unsupported custom/Beta/Canary/SxS case.
  - Read `profile.last_used`, `profile.last_active_profiles` (string array), and `profile.info_cache`.
  - For each profile, try `Secure Preferences` then `Preferences`; parse and look up `extensions.settings[extensionId]`.
  - `extensionEnabled = !!setting && Number(setting.state) !== 0 && !(Array.isArray(setting.disable_reasons) && setting.disable_reasons.length > 0)`.
  - `extensionPath = typeof setting?.path === 'string' ? setting.path : null`.
  - `name` falls back to `directory`; `activeTime` is `Number.isFinite(meta.active_time) ? meta.active_time : null`.
  - A malformed per-profile file is skipped; only `Local State` failure throws.
- Add `export function chooseExtensionProfile(scan)` with the exact selection order from Global Constraints, sorting enabled profiles by `activeTime` descending.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="chrome profile scan|default user data directories" profiles.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add profiles.mjs profiles.test.mjs
git commit -m "feat: discover Chrome profiles with the extension"
```

---

### Task 2: Ensure helpers

**Files:**
- Create: `ensure.mjs`
- Test: `ensure.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeDirectory(value, platform = process.platform) -> string` — trim, backslashes to slashes, strip trailing slashes, lowercase on `win32`/`darwin`.
  - `buildLaunchArgs({userDataDir, profileDirectory}) -> string[]`.
  - `findChromeExecutable({platform, env, home, exists}) -> Promise<{path: string|null, candidates: string[]}>`.
  - `ensureChildTimeout(timeoutMs = 30000) -> number` — `min((timeoutMs ?? 30000) + 5000, 65000)`.
  - Constants `DEFAULT_TIMEOUT_MS = 30000`, `MIN_TIMEOUT_MS = 5000`, `MAX_TIMEOUT_MS = 60000`.

- [ ] **Step 1: Write the failing helper tests**

Create `ensure.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDirectory,buildLaunchArgs,findChromeExecutable,ensureChildTimeout} from './ensure.mjs';
test('normalizes profile directories per platform',()=>{
 assert.equal(normalizeDirectory(' Profile 1 ','win32'),'profile 1');
 assert.equal(normalizeDirectory('C:\\Data\\Profile 1','win32'),'c:/data/profile 1');
 assert.equal(normalizeDirectory('Profile 1','linux'),'Profile 1');
});
test('builds the launch arguments',()=>{
 assert.deepEqual(buildLaunchArgs({userDataDir:'C:\\UD',profileDirectory:'Default'}),['--user-data-dir=C:\\UD','--profile-directory=Default','--new-window','--no-first-run','--no-default-browser-check','about:blank']);
});
test('finds Chrome in the platform candidates',async()=>{
 const win=await findChromeExecutable({platform:'win32',home:'C:\\Users\\X',env:{LOCALAPPDATA:'C:\\Local',ProgramFiles:'C:\\PF'},exists:async p=>p==='C:\\PF\\Google\\Chrome\\Application\\chrome.exe'});
 assert.equal(win.path,'C:\\PF\\Google\\Chrome\\Application\\chrome.exe');
 assert.ok(win.candidates.includes('C:\\Local\\Google\\Chrome\\Application\\chrome.exe'));
 const mac=await findChromeExecutable({platform:'darwin',home:'/Users/x',env:{},exists:async p=>p==='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 assert.equal(mac.path,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 const none=await findChromeExecutable({platform:'linux',home:'/home/x',env:{},exists:async()=>false});
 assert.equal(none.path,null);
 assert.ok(none.candidates.includes('/usr/bin/google-chrome'));
});
test('computes a child timeout above the ensure wait',()=>{
 assert.equal(ensureChildTimeout(30000),35000);
 assert.equal(ensureChildTimeout(60000),65000);
 assert.equal(ensureChildTimeout(),35000);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="normalizes profile directories|builds the launch arguments|finds Chrome|child timeout" ensure.test.mjs`
Expected: FAIL — `ensure.mjs` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `ensure.mjs`:
- `import {access} from 'node:fs/promises'; import {homedir} from 'node:os'; import {join} from 'node:path';`
- `findChromeExecutable` candidates exactly as Global Constraints; default `exists` uses `access(p).then(()=>true,()=>false)`.
- `ensureChildTimeout` exactly as Global Constraints.
- No orchestration yet.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="normalizes profile directories|builds the launch arguments|finds Chrome|child timeout" ensure.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ensure.mjs ensure.test.mjs
git commit -m "feat: add Chrome launch helpers"
```

---

### Task 3: Ensure orchestration

**Files:**
- Modify: `ensure.mjs`
- Test: `ensure.test.mjs`

**Interfaces:**
- Consumes: Task 1 `chromeProfiles`, `chooseExtensionProfile`, `defaultUserDataDir`; Task 2 helpers; `listProfiles` from `bridge-client.mjs`.
- Produces:
  - `ensureBrowser({profileDirectory, timeoutMs, platform, env, home, listProfilesImpl, spawnImpl, profileScanImpl, chromeExecutableImpl, serverVersion, sleep, now}) -> Promise<result>` where result is `{launched, profileId, browser, label, profileDirectory, extensionVersion, profiles, warning}`.
  - `defaultProfileScan({platform, home, env})` reads `extension-id.txt` and calls `chromeProfiles` with `defaultUserDataDir("chrome", …)`.

- [ ] **Step 1: Write the failing orchestration tests**

Add to `ensure.test.mjs`:

```js
import {EventEmitter} from 'node:events';
import {ensureBrowser} from './ensure.mjs';
const profile=(over={})=>({profileId:'chrome:Default:aaaaaa',label:'Test',responsive:true,browser:'chrome',profileDirectory:'Default',extensionVersion:'0.5.0',instanceId:'x',startedAt:0,connectedTab:null,...over});
const listing=(profiles,def=null)=>({default:def,profiles});
const scan=(over={})=>({userDataDir:'C:\\UD',lastUsed:'Default',lastActive:[],profiles:[{directory:'Default',name:'Test',activeTime:3,extensionEnabled:true,extensionPath:'C:\\ext'}],...over});
function child(){const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('spawn'));return c;}
function clock(){let t=0;return{now:()=>t,sleep:async ms=>{t+=ms}}}
test('ensure reuses a responsive profile without launching',async()=>{
 let spawned=0;
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([profile()],'chrome:Default:aaaaaa'),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.launched,false);assert.equal(result.profileId,'chrome:Default:aaaaaa');assert.equal(spawned,0);
});
test('ensure launches the selected profile and waits for a new connection',async()=>{
 const calls=[];let n=0;const list=async()=>{n++;return n===1?listing([]):listing([profile()])};
 const result=await ensureBrowser({listProfilesImpl:list,profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:(path,args)=>{calls.push({path,args});return child()},serverVersion:'0.5.0',...clock()});
 assert.equal(result.launched,true);assert.equal(result.profileId,'chrome:Default:aaaaaa');
 assert.equal(calls.length,1);assert.equal(calls[0].path,'C:/chrome.exe');assert.deepEqual(calls[0].args,buildLaunchArgs({userDataDir:'C:\\UD',profileDirectory:'Default'}));
});
test('ensure reuses a requested profile when it is already responsive',async()=>{
 let spawned=0;
 const target=profile({profileId:'chrome:Profile 7:cccccc',profileDirectory:'Profile 7',label:'Work'});
 const result=await ensureBrowser({profileDirectory:'Profile 7',listProfilesImpl:async()=>listing([target]),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.launched,false);assert.equal(result.profileId,'chrome:Profile 7:cccccc');assert.equal(spawned,0);
});
test('ensure fails before launching when no profile has the extension',async()=>{
 let spawned=0;
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[{directory:'Default',extensionEnabled:false}]}),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0'}),/No Chrome profile|extension enabled/i);
 assert.equal(spawned,0);
});
test('ensure rejects a requested profile without the extension',async()=>{
 await assert.rejects(ensureBrowser({profileDirectory:'Default',listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[{directory:'Default',extensionEnabled:false}]}),serverVersion:'0.5.0'}),/does not have the Kennect Browser extension enabled/i);
});
test('ensure reports a missing Chrome executable with the attempted paths',async()=>{
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:null,candidates:['C:/a/chrome.exe','C:/b/chrome.exe']}),serverVersion:'0.5.0'}),/Checked: C:\/a\/chrome\.exe, C:\/b\/chrome\.exe/);
});
test('the no-extension error names the unsupported custom store',async()=>{
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[]}),serverVersion:'0.5.0'}),/user-data-dir|Beta|Canary|SxS/i);
});
test('ensure times out with a clear connection message',async()=>{
 let spawned=0;
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0',...clock()}),/did not connect within 30 seconds/i);
 assert.equal(spawned,1);
});
test('ensure surfaces a spawn error',async()=>{
 const bad=()=>{const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('error',new Error('ENOENT: chrome')));return c};
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:bad,serverVersion:'0.5.0'}),/ENOENT/);
});
test('ensure warns on a version mismatch',async()=>{
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([profile({extensionVersion:'0.4.0'})]),serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.match(result.warning,/0\.4\.0.*0\.5\.0|does not match/);
});
test('a pre-existing unrelated responsive profile never satisfies the launch poll',async()=>{
 const other=profile({profileId:'chrome:Other:bbbbbb',profileDirectory:'Other'});
 const target=profile({profileId:'chrome:Profile 7:cccccc',profileDirectory:'Profile 7',label:'Work'});
 let n=0;const list=async()=>{n++;return n===1?listing([other]):listing([other,target])};
 const result=await ensureBrowser({profileDirectory:'Profile 7',listProfilesImpl:list,profileScanImpl:async()=>scan({profiles:[{directory:'Profile 7',name:'Work',extensionEnabled:true}]}),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:()=>child(),serverVersion:'0.5.0',...clock()});
 assert.equal(result.profileId,'chrome:Profile 7:cccccc');
});
test('a new profile id without a directory is accepted with an identity warning',async()=>{
 const target=profile({profileId:'chrome:unknown:dddddd',profileDirectory:null,label:null});
 let n=0;const list=async()=>{n++;return n===1?listing([]):listing([target])};
 const result=await ensureBrowser({listProfilesImpl:list,profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:()=>child(),serverVersion:'0.5.0',...clock()});
 assert.equal(result.profileId,'chrome:unknown:dddddd');assert.match(result.warning,/identity/i);
});
test('reuse chooses the persisted default when several profiles are responsive',async()=>{
 const a=profile({profileId:'chrome:A:aaaaaa'}),b=profile({profileId:'chrome:B:bbbbbb',profileDirectory:'B'});
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([a,b],'chrome:B:bbbbbb'),serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.profileId,'chrome:B:bbbbbb');
});
test('reuse returns a responsive Edge profile without launching Chrome',async()=>{
 const edge=profile({profileId:'edge:Default:eeeeee',browser:'edge',label:'Edge'});
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([edge]),serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.browser,'edge');assert.equal(result.launched,false);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="ensure reuses|ensure launches|ensure fails|ensure rejects|ensure reports|ensure times out|ensure warns|pre-existing unrelated|new profile id|persisted default|responsive Edge|requested profile|spawn error|no-extension error" ensure.test.mjs`
Expected: FAIL — `ensureBrowser` is not exported.

- [ ] **Step 3: Implement `ensureBrowser`**

- `import {spawn} from 'node:child_process'; import {readFile} from 'node:fs/promises'; import {listProfiles} from './bridge-client.mjs'; import {readProfileConfig} from './profiles.mjs'; import {chromeProfiles,chooseExtensionProfile,defaultUserDataDir} from './profiles.mjs';`
- `defaultProfileScan({platform,home,env})`: build the default user-data dir, read `extension-id.txt` (new URL relative to `ensure.mjs`), return `chromeProfiles({userDataDir,extensionId})`.
- `readServerVersion()`: parse `package.json` version; cache once.
- Validate `profileDirectory` (trimmed 1–100, no control chars) and `timeoutMs` (integer 5000–60000) before any I/O.
- Reuse, scan, selection, executable, spawn, poll, and result exactly per the spec steps 1–8 and the Global Constraints. Use `buildResult` to compute the version warning and identity warning.
- Poll condition: normalized directory match against `requested ?? chosenScan.directory`, else a `profileId` absent from the pre-launch responsive snapshot. Prefer directory match.
- Return the top-level fields exactly as the spec: `launched`, `profileId`, `browser`, `label`, `profileDirectory`, `extensionVersion`, `profiles`, `warning`.
- `timeout` error text must include "did not connect within N seconds" and the manual Connect/paused guidance.
- `spawn` uses the exact launch args and options; wrap synchronous spawn errors with the executable path.
- Do not add retries.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="ensure reuses|ensure launches|ensure fails|ensure rejects|ensure reports|ensure times out|ensure warns|pre-existing unrelated|new profile id|persisted default|responsive Edge|requested profile|spawn error|no-extension error" ensure.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add ensure.mjs ensure.test.mjs
git commit -m "feat: launch and wait for the user's Chrome"
```

---

### Task 4: Controller `ensure` command

**Files:**
- Modify: `controller.mjs`
- Test: `controller.test.mjs`

**Interfaces:**
- Consumes: Task 3 `ensureBrowser`.
- Produces: `controller.mjs ensure [JSON]` prints the ensure result as JSON and exits 0; validation failures exit nonzero on stderr.

- [ ] **Step 1: Write the failing controller tests**

Add to `controller.test.mjs`:

```js
test('ensure validates options without launching',()=>{
 for(const arg of ['{"timeoutMs":1000}','{"profileDirectory":""}']){
  const r=run('ensure',arg);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Invalid/);
 }
});
test('ensure rejects malformed options',()=>{
 const r=run('ensure','not json');
 assert.notEqual(r.status,0);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test --test-name-pattern="ensure validates|ensure rejects malformed" controller.test.mjs`
Expected: FAIL — `ensure` is not a known command, so the controller attempts the dedicated-browser path.

- [ ] **Step 3: Implement the command**

- Import `ensureBrowser` from `./ensure.mjs`.
- After the `set-default-profile` branch and before `bridgeCall`:
  ```js
  if(command==='ensure'){
   const options=JSON.parse(args[0]||'{}');
   const result=await ensureBrowser(options);
   await new Promise(r=>process.stdout.write(JSON.stringify(result)+'\n',r));
   process.exit(0);
  }
  ```
- `ensureBrowser` validates before any `listProfiles`/spawn, so these tests never launch Chrome.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="ensure validates|ensure rejects malformed" controller.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add controller.mjs controller.test.mjs
git commit -m "feat: add the ensure controller command"
```

---

### Task 5: MCP `browser_ensure` tool and timeout

**Files:**
- Modify: `server.mjs`
- Test: `mcp.test.mjs`

**Interfaces:**
- Consumes: Task 2 `ensureChildTimeout`, Task 4 `ensure` command.
- Produces: MCP tool `browser_ensure({profileDirectory?, timeoutMs?})`; no automatic `profile` property; child timeout `ensureChildTimeout(args.timeoutMs)`.

- [ ] **Step 1: Write the failing MCP tests**

Add to `mcp.test.mjs`:

```js
assert.ok(names.includes('browser_ensure'));
const ensureTool=list.result.tools.find(t=>t.name==='browser_ensure');
assert.equal(ensureTool.inputSchema.properties.profile,undefined);
assert.equal(ensureTool.annotations.readOnlyHint,false);
assert.deepEqual(ensureTool.inputSchema.properties.timeoutMs,{type:'integer',minimum:5000,maximum:60000});
const badEnsureTimeout=await call('tools/call',{name:'browser_ensure',arguments:{timeoutMs:1000}});
assert.equal(badEnsureTimeout.error.code,-32602);
const emptyProfileDir=await call('tools/call',{name:'browser_ensure',arguments:{profileDirectory:''}});
assert.equal(emptyProfileDir.error.code,-32602);
const unknownEnsureArg=await call('tools/call',{name:'browser_ensure',arguments:{bogus:1}});
assert.equal(unknownEnsureArg.error.code,-32602);
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test --test-name-pattern="MCP discovers" mcp.test.mjs`
Expected: FAIL — `browser_ensure` is missing.

- [ ] **Step 3: Implement the tool**

- Add `browser_ensure` to the `tool()` exclusion list with `browser_start`, `browser_batch`, `browser_profiles`, and `browser_set_default_profile`.
- Add the tool with the description and schema from the spec (no `profile`).
- Add the command-map entry:
  ```js
  browser_ensure:['ensure',JSON.stringify({profileDirectory:args.profileDirectory,timeoutMs:args.timeoutMs})],
  ```
- Add `import {ensureChildTimeout} from './ensure.mjs';` and use:
  ```js
  const childTimeout=name==='browser_ensure'?ensureChildTimeout(args.timeoutMs):15000;
  const {stdout}=await execute(process.execPath,[cli,...command],{env,timeout:childTimeout,maxBuffer:32*1024*1024});
  ```
  Keep `browser_start`'s own 15 s execution unchanged.
- Bump `serverInfo.version` to `0.5.0` and append to the instructions:
  "If no browser profile is connected and the user authorizes opening their browser, call browser_ensure; it launches the last-used Chrome profile that has the Kennect extension and waits for it."

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern="MCP discovers" mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add server.mjs mcp.test.mjs
git commit -m "feat: expose browser_ensure over MCP"
```

---

### Task 6: Version 0.5.0, documentation, and full verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `extension/manifest.json`, `extension.test.mjs`, `README.md`, `skills/kennect-browser/SKILL.md`
- Add: `docs/superpowers/specs/2026-11-16-browser-ensure-design.md`, `docs/superpowers/plans/2026-11-16-browser-ensure.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: version 0.5.0 everywhere; user-facing documentation.

- [ ] **Step 1: Bump the version**

Set `0.5.0` in `package.json`, both `package-lock.json` version fields, `extension/manifest.json`, and the extension hello assertion plus fake `getManifest` in `extension.test.mjs`. `server.mjs` was bumped in Task 5.

- [ ] **Step 2: Update README**

- Features: add "Launch/ensure the personal Chrome profile when the extension is not connected."
- Usage: add `node controller.mjs ensure` and a sentence that it opens the real Chrome profile and waits for the extension.
- Known limitations: ensure cannot revive a paused extension; launching is Chrome-only; the default stable Chrome user-data-dir is the only store scanned; one launch attempt per call.
- Distinguish `browser_ensure` from `browser_start`: ensure targets the personal profile with the extension; start targets the dedicated fallback profile without sign-ins.

- [ ] **Step 3: Add the skill section**

Add "Starting a closed browser" to `skills/kennect-browser/SKILL.md`:
- Call `browser_ensure` only with explicit user authorization; it opens a visible personal Chrome window.
- `launched: false` means a profile was already connected.
- If it times out, ask the user to click Connect in the extension; do not retry in a loop.
- Then use `browser_windows`/`browser_open_window` with the returned `profileId`.
- `browser_start` is the separate dedicated fallback without sign-ins.

- [ ] **Step 4: Verify version consistency**

Run: `grep -n '"version"' package.json extension/manifest.json package-lock.json && grep -n "version:'0.5.0'" server.mjs && grep -n "0\.5\.0" extension.test.mjs`
Expected: every location reports `0.5.0`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. Three live tests remain skipped without `KENNECT_BROWSER_LIVE_TESTS=1`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json extension/manifest.json extension.test.mjs README.md skills/kennect-browser/SKILL.md docs/superpowers/specs/2026-11-16-browser-ensure-design.md docs/superpowers/plans/2026-11-16-browser-ensure.md
git commit -m "release: version 0.5.0 with browser ensure"
```

- [ ] **Step 7: Live verification (manual, requires Chrome)**

1. With Chrome **open and connected**: `node controller.mjs ensure` returns `launched: false` and the connected profile.
2. With Chrome **closed**: `node controller.mjs ensure` launches the last-used extension-enabled Chrome profile, waits, and returns `launched: true` with the connected profile.
3. Run `node controller.mjs windows` and confirm the window listing.
4. From the ensured profile, create and close a test window with the window tools.
5. If the extension was paused, confirm the timeout message explains how to reconnect.

If Chrome is unavailable or cannot be closed during execution, report steps 2–5 as not run rather than claiming they passed.

---

## Self-Review

**Spec coverage:** profile discovery (Task 1), launch helpers and timeout formula (Task 2), orchestration/reuse/selection/poll (Task 3), controller routing (Task 4), MCP tool and child timeout (Task 5), version/docs/live verification (Task 6). All spec sections map to a task.

**Type consistency:** `profileDirectory` is a string or undefined; `timeoutMs` is an integer; `profiles` is always the `listProfiles` listing; `activeTime` is a number or null; `extensionEnabled` is a boolean; the result fields are `launched, profileId, browser, label, profileDirectory, extensionVersion, profiles, warning`.

**Review Focus coverage:** Secure Preferences/disabled entries (Task 1), unrelated responsive profile during poll (Task 3), server child timeout (Task 2 helper test + Task 5 wiring), paused-extension timeout (Task 3), custom user-data-dir error (Task 1 missing-store test and Task 3 no-extension error).
