#!/usr/bin/env node
import net from 'node:net';
import {mkdir,chmod,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {pipeName} from './platform.mjs';
const dir=process.env.KENNECT_BROWSER_BRIDGE_DIR||join(homedir(),'.kennect-browser');await mkdir(dir,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(dir,0o700);
const token=randomBytes(32).toString('hex');
const windows=process.platform==='win32',socketPath=windows?pipeName(homedir(),process.pid):join(dir,`${process.pid}.sock`),discoveryPath=join(dir,`${process.pid}.json`),pending=new Map(),clients=new Set();
function frame(value){const body=Buffer.from(JSON.stringify(value));const head=Buffer.alloc(4);head.writeUInt32LE(body.length);return Buffer.concat([head,body])}
function decode(stream,limit,callback){let buffer=Buffer.alloc(0);stream.on('data',data=>{buffer=Buffer.concat([buffer,data]);while(buffer.length>=4){const n=buffer.readUInt32LE();if(n>limit){stream.destroy();return}if(buffer.length<n+4)return;try{callback(JSON.parse(buffer.subarray(4,n+4).toString()))}catch{stream.destroy();return}buffer=buffer.subarray(n+4)}})}
decode(process.stdin,32*1024*1024,msg=>{if(msg.type!=='response')return;const task=pending.get(msg.id);if(!task)return;pending.delete(msg.id);clearTimeout(task.timer);task.client.write(frame(msg))});
const server=net.createServer(client=>{clients.add(client);decode(client,1024*1024,msg=>{
 if(windows&&(typeof msg.token!=='string'||msg.token.length!==64||!timingSafeEqual(Buffer.from(msg.token),Buffer.from(token)))){client.destroy();return;}
 const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);client.write(frame({id:msg.id,error:'Browser action timed out; it was not retried.'}))},12000);
 pending.set(id,{client,timer});process.stdout.write(frame({type:'request',id,command:msg.command,args:msg.args??[],tabId:msg.tabId}));
 });client.on('error',()=>{});client.on('close',()=>{clients.delete(client);for(const[id,p]of pending)if(p.client===client){clearTimeout(p.timer);pending.delete(id)}})});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve)});if(windows)await writeFile(discoveryPath,JSON.stringify({pid:process.pid,pipe:socketPath,token}),{mode:0o600});else await chmod(socketPath,0o600);
process.stdout.write(frame({type:'ready'}));
async function stop(){for(const c of clients)c.destroy();server.close();await rm(windows?discoveryPath:socketPath,{force:true});process.exit(0)}
process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
