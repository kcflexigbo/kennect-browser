import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const isolated=mkdtempSync(join(tmpdir(),'kennect-browser-test-'));
test.after(()=>rmSync(isolated,{recursive:true,force:true}));
const liveTest=(name,fn)=>test(name,{skip:process.env.KENNECT_BROWSER_LIVE_TESTS!=='1'},fn);
const cli = new URL('./controller.mjs',import.meta.url);
function run(...args){return spawnSync(process.execPath,[fileURLToPath(cli),...args],{encoding:'utf8',timeout:20000,env:{...process.env,...(process.env.KENNECT_BROWSER_LIVE_TESTS==='1'?{}:{KENNECT_BROWSER_BRIDGE_DIR:join(isolated,'bridge'),KENNECT_BROWSER_PROFILE:join(isolated,'profile')})}});}
liveTest('connects to the dedicated browser and reads a real page',()=>{
 const r=run('snapshot');
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/zhipin\.com/);
 assert.match(r.stdout,/登录|消息|职位/);
});
test('rejects navigation outside BOSS',()=>{
 const r=run('navigate','file:///etc/passwd');
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/Only HTTP or HTTPS website URLs are allowed/);
});
liveTest('lists BOSS tabs without collecting console objects',()=>{
 const r=run('tabs');assert.equal(r.status,0,r.stderr);
 const tabs=JSON.parse(r.stdout);assert.ok(tabs.length>0);assert.ok(tabs.every(t=>t.url.startsWith('https://www.zhipin.com/')));
});

liveTest('executes JavaScript without a continuous console collector',()=>{
 const r=run('evaluate','JSON.stringify({title:document.title,fields:document.querySelectorAll("input").length})');assert.equal(r.status,0,r.stderr);const result=JSON.parse(JSON.parse(r.stdout));assert.match(result.title,/BOSS/);assert.ok(result.fields>=0);
});
