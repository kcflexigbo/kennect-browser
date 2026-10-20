import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
test('MCP discovers browser tools and rejects invalid calls',async()=>{
 const p=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
 const pending=new Map();let id=0;const lines=createInterface({input:p.stdout});
 lines.on('line',line=>{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id)});
 p.on('exit',()=>{for(const resolve of pending.values())resolve({error:{message:'Server exited before responding'}});pending.clear()});
 const call=(method,params={})=>new Promise(resolve=>{const n=++id;const timer=setTimeout(()=>resolve({error:{message:'Timed out'}}),12000);pending.set(n,m=>{clearTimeout(timer);resolve(m)});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')});
 try{
  const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.result?.serverInfo?.name,'codex-browser');
  const list=await call('tools/list');assert.ok(list.result.tools.some(t=>t.name==='browser_snapshot'));assert.ok(list.result.tools.some(t=>t.name==='browser_click'));
  if(process.env.CODEX_BROWSER_LIVE_TESTS==='1'){const read=await call('tools/call',{name:'browser_snapshot',arguments:{}});assert.equal(read.result.isError,false);assert.match(read.result.content[0].text,/zhipin\.com/);}
  const bad=await call('tools/call',{name:'browser_navigate',arguments:{url:'file:///etc/passwd'}});assert.equal(bad.result.isError,true);
  const unknown=await call('tools/call',{name:'shell',arguments:{}});assert.equal(unknown.error.code,-32602);
  const invalid=await call('tools/call',{name:'browser_click',arguments:{nodeId:'bad'}});assert.equal(invalid.error.code,-32602);
 }finally{p.kill();lines.close()}
});
