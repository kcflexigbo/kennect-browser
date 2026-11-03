import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const isolated=mkdtempSync(join(tmpdir(),'kennect-mcp-test-'));
test.after(()=>rmSync(isolated,{recursive:true,force:true}));
test('MCP discovers browser tools and rejects invalid calls',async()=>{
 const p=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{...process.env,KENNECT_BROWSER_BRIDGE_DIR:join(isolated,'bridge'),KENNECT_BROWSER_PROFILE:join(isolated,'profile')}});
 const pending=new Map();let id=0;const lines=createInterface({input:p.stdout});
 lines.on('line',line=>{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id)});
 p.on('exit',()=>{for(const resolve of pending.values())resolve({error:{message:'Server exited before responding'}});pending.clear()});
 const call=(method,params={})=>new Promise(resolve=>{const n=++id;const timer=setTimeout(()=>resolve({error:{message:'Timed out'}}),12000);pending.set(n,m=>{clearTimeout(timer);resolve(m)});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')});
 try{
  const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result?.serverInfo?.name,'kennect-browser');
  const list=await call('tools/list');assert.ok(list.result.tools.some(t=>t.name==='browser_snapshot'));assert.ok(list.result.tools.some(t=>t.name==='browser_click'));
  const names=list.result.tools.map(t=>t.name);assert.ok(names.includes('browser_profiles'));assert.ok(names.includes('browser_set_default_profile'));assert.ok(names.includes('browser_download'));assert.ok(names.includes('browser_download_status'));
  const missingDownload=await call('tools/call',{name:'browser_download',arguments:{}});assert.equal(missingDownload.error.code,-32602);
  const badDownloadId=await call('tools/call',{name:'browser_download_status',arguments:{downloadId:'x'}});assert.equal(badDownloadId.error.code,-32602);
  const openTab=list.result.tools.find(t=>t.name==='browser_open_tab');assert.ok(openTab.inputSchema.properties.groupTitle);assert.ok(openTab.inputSchema.properties.groupColor);
  const profiles=await call('tools/call',{name:'browser_profiles',arguments:{}});assert.equal(profiles.result.isError,false);assert.deepEqual(JSON.parse(profiles.result.content[0].text),{default:null,profiles:[]});
  const unknownProfile=await call('tools/call',{name:'browser_set_default_profile',arguments:{profile:'chrome:Default:aaaaaa'}});assert.equal(unknownProfile.result.isError,true);assert.match(unknownProfile.result.content[0].text,/Unknown browser profile/);
  const missingProfile=await call('tools/call',{name:'browser_set_default_profile',arguments:{}});assert.equal(missingProfile.error.code,-32602);
  const requestedProfile=await call('tools/call',{name:'browser_tabs',arguments:{profile:'chrome:Default:aaaaaa'}});assert.equal(requestedProfile.result.isError,true);assert.match(requestedProfile.result.content[0].text,/Unknown browser profile/);
  if(process.env.KENNECT_BROWSER_LIVE_TESTS==='1'){const read=await call('tools/call',{name:'browser_snapshot',arguments:{}});assert.equal(read.result.isError,false);assert.match(read.result.content[0].text,/zhipin\.com/);}
  const bad=await call('tools/call',{name:'browser_navigate',arguments:{url:'file:///etc/passwd'}});assert.equal(bad.result.isError,true);
  const unknown=await call('tools/call',{name:'shell',arguments:{}});assert.equal(unknown.error.code,-32602);
  const invalid=await call('tools/call',{name:'browser_click',arguments:{nodeId:'bad'}});assert.equal(invalid.error.code,-32602);
 }finally{p.kill();lines.close()}
});
