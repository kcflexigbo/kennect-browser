#!/usr/bin/env node
import {readFile,mkdir,access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {bridgeCall} from './bridge-client.mjs';
import {browserProfile} from './platform.mjs';
const profile=browserProfile();
async function running(){
 try{const port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(!Number.isInteger(port)||port<1||port>65535)return false;const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)});return r.ok}catch{return false}
}
try{
 const bridge=await bridgeCall('status',[]);if(bridge){console.log('Reusing the Chrome website connected through Codex Browser.');process.exit(0)}
 if(await running()){console.log('Dedicated browser is running.');process.exit(0)}
 await mkdir(profile,{recursive:true,mode:0o700});
 const candidates=process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:process.platform==='win32'?[join(process.env.LOCALAPPDATA||homedir(),'Google/Chrome/Application/chrome.exe'),join(process.env.ProgramFiles||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Google/Chrome/Application/chrome.exe')]:['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
 let chromePath;for(const path of candidates){try{await access(path);chromePath=path;break}catch{}}if(!chromePath)throw new Error('Google Chrome was not found. Install Chrome or use the extension with an existing Chrome window.');
 const child=spawn(chromePath,[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','https://example.com/'],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();
 let ready=false;for(let i=0;i<30;i++){if(await running()){ready=true;break}await new Promise(r=>setTimeout(r,250))}
 if(!ready)throw new Error('Chrome did not become ready. Close only the dedicated browser and try the launcher again.');
 console.log('Dedicated browser opened. Sign into the website here once; the profile keeps your session.');
}catch(e){console.error(e.message);process.exitCode=1}
