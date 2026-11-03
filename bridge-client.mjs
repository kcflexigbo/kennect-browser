import net from 'node:net';
import {readdir,stat,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pipeName} from './platform.mjs';
import {bridgeDirectory,readProfileConfig,selectProfile} from './profiles.mjs';

function alive(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return true}catch(error){return error.code==='EPERM'}
}
async function discover(directory){
 let entries;
 try{const info=await stat(directory);if(process.platform!=='win32'&&(info.uid!==process.getuid()||(info.mode&0o077)))throw Error('Unsafe local browser bridge directory');entries=await readdir(directory)}catch(error){if(error.code==='ENOENT')return[];throw error}
 const candidates=[];
 if(process.platform==='win32'){
  for(const name of entries.filter(entry=>/^\d+\.json$/.test(entry))){
   try{
    const path=join(directory,name),info=await stat(path),metadata=JSON.parse(await readFile(path,'utf8')),pid=Number(name.slice(0,-5));
    if(metadata.pid!==pid||metadata.pipe!==pipeName(homedir(),pid)||!/^[a-f0-9]{64}$/.test(metadata.token))continue;
    if(!alive(pid)){void rm(path,{force:true}).catch(()=>{});continue}
    candidates.push({pid,path:metadata.pipe,token:metadata.token,metadata,time:info.mtimeMs});
   }catch{}
  }
 }else{
  for(const name of entries.filter(entry=>/^\d+\.sock$/.test(entry))){
   try{
    const path=join(directory,name),info=await stat(path),pid=Number(name.slice(0,-5));
    if(!info.isSocket()||info.uid!==process.getuid()||(info.mode&0o077))continue;
    if(!alive(pid)){void rm(path,{force:true}).catch(()=>{});void rm(join(directory,`${pid}.json`),{force:true}).catch(()=>{});continue}
    let metadata={};try{metadata=JSON.parse(await readFile(join(directory,`${pid}.json`),'utf8'))}catch{}
    candidates.push({pid,path,token:undefined,metadata,time:info.mtimeMs});
   }catch{}
  }
 }
 return candidates;
}
function profileIdOf(candidate){
 const metadata=candidate.metadata??{};
 return metadata.profileId||(metadata.instanceId?`extension:${metadata.instanceId.slice(0,8)}`:`pid:${candidate.pid}`);
}
function callHost(candidate,command,args,tabId,timeoutMs){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(candidate.path),body=Buffer.from(JSON.stringify({command,args,tabId,...(candidate.token?{token:candidate.token}:{})})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);
  let buffer=Buffer.alloc(0),settled=false;
  const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value)};
  const timer=setTimeout(()=>done(Object.assign(Error('Browser extension did not respond; action was not retried.'),{code:'TIMEOUT'})),timeoutMs);
  socket.on('connect',()=>socket.write(Buffer.concat([head,body])));
  socket.on('error',error=>done(error));
  socket.on('end',()=>done(Error('Extension disconnected.')));
  socket.on('data',data=>{
   buffer=Buffer.concat([buffer,data]);
   if(buffer.length<4)return;
   const size=buffer.readUInt32LE();
   if(size>32*1024*1024)return done(Error('Browser response too large'));
   if(buffer.length<size+4)return;
   try{const message=JSON.parse(buffer.subarray(4,size+4));done(null,message.error?{error:message.error}:{result:message.result})}catch(error){done(error)}
  });
 });
}
async function probe(candidate,timeoutMs){
 try{await callHost(candidate,'ping',[],undefined,timeoutMs);return true}catch{return false}
}
async function connectedTab(candidate,timeoutMs){
 try{const response=await callHost(candidate,'status',[],undefined,timeoutMs);if(response.error)return null;const status=JSON.parse(response.result);return typeof status.title==='string'?status.title:null}catch{return null}
}
function entriesWithResponsiveness(results){
 const entries=new Map();
 for(const {candidate,responsive} of results){
  const profileId=profileIdOf(candidate),existing=entries.get(profileId);
  if(!existing||(responsive&&!existing.responsive)||(responsive===existing.responsive&&candidate.time>existing.time)){
   const metadata=candidate.metadata??{};
   entries.set(profileId,{profileId,responsive,candidate,browser:metadata.browser??null,profileDirectory:metadata.profileDirectory??null,extensionVersion:metadata.extensionVersion??null,instanceId:metadata.instanceId??null,startedAt:metadata.startedAt??null});
  }
 }
 return entries;
}
export async function listProfiles({directory=bridgeDirectory(),probeTimeoutMs=2000}={}){
 const candidates=await discover(directory);
 const results=await Promise.all(candidates.map(async candidate=>({candidate,responsive:await probe(candidate,probeTimeoutMs)})));
 const entries=entriesWithResponsiveness(results);
 const profiles=[];
 for(const entry of [...entries.values()].sort((a,b)=>a.profileId.localeCompare(b.profileId))){
  profiles.push({profileId:entry.profileId,responsive:entry.responsive,browser:entry.browser,profileDirectory:entry.profileDirectory,extensionVersion:entry.extensionVersion,instanceId:entry.instanceId,startedAt:entry.startedAt,connectedTab:entry.responsive?await connectedTab(entry.candidate,probeTimeoutMs):null});
 }
 return {default:await readProfileConfig(directory),profiles};
}
export async function bridgeCall(command,args,tabId,requestedProfile,{directory=bridgeDirectory(),probeTimeoutMs=2000}={}){
 const candidates=await discover(directory),defaultProfile=await readProfileConfig(directory),chosen=requestedProfile??defaultProfile;
 if(!candidates.length){
  if(chosen)throw new Error(`Unknown browser profile: ${chosen}. No browser profiles are connected.`);
  return null;
 }
 const results=await Promise.all(candidates.map(async candidate=>({candidate,responsive:await probe(candidate,probeTimeoutMs)})));
 const entries=[...entriesWithResponsiveness(results).values()];
 const selected=selectProfile(entries,requestedProfile,defaultProfile);
 return callHost(selected.candidate,command,args,tabId,14000).then(response=>{
  if(response.error)throw Error(response.error);
  return{result:response.result};
 });
}
