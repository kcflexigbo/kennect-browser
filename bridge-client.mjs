import net from 'node:net';import {readdir,stat,readFile} from 'node:fs/promises';import {join} from 'node:path';import {homedir} from 'node:os';
import {pipeName} from './platform.mjs';
export async function bridgeCall(command,args,tabId){
 const dir=process.env.CODEX_BROWSER_BRIDGE_DIR||join(homedir(),'.codex-browser');let entries;
 try{const d=await stat(dir);if(process.platform!=='win32'&&(d.uid!==process.getuid()||(d.mode&0o077)))throw Error('Unsafe local browser bridge directory');entries=await readdir(dir)}catch(e){if(e.code==='ENOENT')return null;throw e}
 const sockets=[];
 if(process.platform==='win32'){
  for(const name of entries.filter(n=>/^\d+\.json$/.test(n))){try{const path=join(dir,name),s=await stat(path),m=JSON.parse(await readFile(path,'utf8'));const pid=Number(name.slice(0,-5));if(m.pid===pid&&m.pipe===pipeName(homedir(),pid)&&/^[a-f0-9]{64}$/.test(m.token))sockets.push({path:m.pipe,time:s.mtimeMs,token:m.token})}catch{}}
 }else{
  for(const name of entries.filter(n=>/^\d+\.sock$/.test(n))){const path=join(dir,name);const s=await stat(path);if(s.isSocket()&&s.uid===process.getuid()&&!(s.mode&0o077))sockets.push({path,time:s.mtimeMs})}
 }
 sockets.sort((a,b)=>b.time-a.time);if(!sockets.length)return null;
 for(const candidate of sockets){
  try{return await new Promise((resolve,reject)=>{
   const socket=net.connect(candidate.path),body=Buffer.from(JSON.stringify({command,args,tabId,...(candidate.token?{token:candidate.token}:{})})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);let buffer=Buffer.alloc(0),settled=false;
   const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value)};
   const timer=setTimeout(()=>done(Error('Browser extension did not respond; action was not retried.')),14000);
   socket.on('connect',()=>socket.write(Buffer.concat([head,body])));socket.on('error',e=>done(e));socket.on('end',()=>done(Error('Extension disconnected.')));
   socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);if(buffer.length<4)return;const size=buffer.readUInt32LE();if(size>32*1024*1024)return done(Error('Browser response too large'));if(buffer.length<size+4)return;try{const m=JSON.parse(buffer.subarray(4,size+4));if(m.error)done(Error(m.error));else done(null,{result:m.result})}catch(e){done(e)}});
  })}catch(e){if(e.code==='ECONNREFUSED'||e.code==='ENOENT')continue;throw e}
 }
 return null;
}
