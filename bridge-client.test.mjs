import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bridgeCall,listProfiles} from './bridge-client.mjs';
import {writeDefaultProfile} from './profiles.mjs';

function frame(value){const body=Buffer.from(JSON.stringify(value));const head=Buffer.alloc(4);head.writeUInt32LE(body.length);return Buffer.concat([head,body])}
async function waitFor(check){for(let i=0;i<100;i++){if(await check())return true;await new Promise(r=>setTimeout(r,25))}return false}
function respond(child,label){
 let buffer=Buffer.alloc(0);
 child.stdout.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4){
   const size=buffer.readUInt32LE();
   if(buffer.length<size+4)return;
   const message=JSON.parse(buffer.subarray(4,size+4));
   buffer=buffer.subarray(size+4);
   if(message.type!=='request')continue;
   const result=message.command==='ping'?'pong':message.command==='status'?JSON.stringify({title:label,url:'https://example.com/',transport:'extension',tabId:1}):`${label} ${message.command}`;
   child.stdin.write(frame({type:'response',id:message.id,result}));
  }
 });
}
async function startHost(directory,label,instanceId,{answer=true}={}){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./native-host.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],env:{...process.env,KENNECT_BROWSER_BRIDGE_DIR:directory,KENNECT_BROWSER_SKIP_IDENTITY:'1'}});
 if(answer)respond(child,label);
 const file=join(directory,`${child.pid}.json`);
 assert.ok(await waitFor(async()=>{try{await readFile(file);return true}catch{return false}}),'discovery file missing');
 child.stdin.write(frame({type:'hello',instanceId,extensionVersion:'0.3.0',userAgent:'test-agent'}));
 assert.ok(await waitFor(async()=>{try{return JSON.parse(await readFile(file,'utf8')).instanceId===instanceId}catch{return false}}),'hello not recorded');
 return{child,profile:`extension:${instanceId.slice(0,8)}`};
}
async function stopHost(host){
 host.child.stdin.end();host.child.kill();
 await new Promise(resolve=>{if(host.child.exitCode!==null)resolve();else host.child.once('exit',resolve)});
}

test('bridge lists connected profiles, uses the configured default, and honors an explicit profile',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kennect-bridge-test-'));
 const a=await startHost(directory,'A','aaaaaaaa1111');
 const b=await startHost(directory,'B','bbbbbbbb2222');
 const options={directory,probeTimeoutMs:1500};
 try{
  const listing=await listProfiles(options);
  assert.deepEqual(listing.profiles.map(profile=>profile.profileId).sort(),[a.profile,b.profile].sort());
  assert.ok(listing.profiles.every(profile=>profile.responsive));
  await assert.rejects(bridgeCall('snapshot',[],undefined,undefined,options),/No browser profile selected/);
  await writeDefaultProfile(directory,a.profile);
  assert.equal((await bridgeCall('snapshot',[],undefined,undefined,options)).result,'A snapshot');
  assert.equal((await bridgeCall('snapshot',[],undefined,b.profile,options)).result,'B snapshot');
  await assert.rejects(bridgeCall('snapshot',[],undefined,'extension:99999999',options),/Unknown browser profile/);
 }finally{await stopHost(a);await stopHost(b);await rm(directory,{recursive:true,force:true})}
});

test('an explicit profile never falls back to the dedicated browser',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kennect-bridge-test-'));
 try{
  assert.equal(await bridgeCall('snapshot',[],undefined,undefined,{directory,probeTimeoutMs:200}),null);
  await assert.rejects(bridgeCall('snapshot',[],undefined,'chrome:Default:aaaaaa',{directory,probeTimeoutMs:200}),/Unknown browser profile/);
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('an unresponsive connection is listed but cannot be selected',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kennect-bridge-test-'));
 const silent=await startHost(directory,'Silent','cccccccc3333',{answer:false});
 const options={directory,probeTimeoutMs:600};
 try{
  const listing=await listProfiles(options);
  assert.equal(listing.profiles.length,1);
  assert.equal(listing.profiles[0].profileId,silent.profile);
  assert.equal(listing.profiles[0].responsive,false);
  await assert.rejects(bridgeCall('snapshot',[],undefined,silent.profile,options),/not responding/);
 }finally{await stopHost(silent);await rm(directory,{recursive:true,force:true})}
});
