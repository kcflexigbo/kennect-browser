import path from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
export const HOST='com.codex_browser.local';
export function pipeName(home,pid){return `\\\\.\\pipe\\codex-browser-${createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0,16)}-${pid}`}
const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const cmdQuote=s=>'"'+s.replaceAll('%','%%')+'"';
export function nativeHostPlan(platform,home,root,nodePath){
 const p=platform==='win32'?path.win32:path.posix;const windows=platform==='win32';
 const wrapperPath=platform==='darwin'?p.join(home,'Library/Application Support/Codex Browser/native-host-launcher'):p.join(root,windows?'native-host.cmd':'native-host-launcher');
 const manifestPath=windows?p.join(root,'install',HOST+'.json'):platform==='darwin'?p.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts',HOST+'.json'):p.join(home,'.config/google-chrome/NativeMessagingHosts',HOST+'.json');
 const script=p.join(root,'native-host.mjs');
 const wrapper=windows?`@echo off\r\nsetlocal DisableDelayedExpansion\r\n${cmdQuote(nodePath)} ${cmdQuote(script)} %*\r\n`:`#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(script)} "$@"\n`;
 const manifest={name:HOST,description:'Codex Browser local bridge',path:wrapperPath,type:'stdio',allowed_origins:[]};
 const registry=windows?['ADD',`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,'/ve','/t','REG_SZ','/d',manifestPath,'/f']:undefined;
 return{wrapperPath,manifestPath,wrapper,manifest,registry};
}

export function browserProfile(){
 if(process.env.CODEX_BROWSER_PROFILE)return process.env.CODEX_BROWSER_PROFILE;
 return path.join(homedir(),'.codex-browser','profile');
}
