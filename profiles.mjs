import path from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);

export function bridgeDirectory(){
 return process.env.KENNECT_BROWSER_BRIDGE_DIR||path.join(homedir(),'.kennect-browser');
}
function normalizePath(value){
 return String(value??'').replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();
}
export function browserProfileId(identity){
 const browser=String(identity.browser??'').toLowerCase();
 const directory=identity.profileDirectory||'Default';
 const hash=createHash('sha256').update(`${browser}\0${normalizePath(identity.userDataDir)}\0${directory.toLowerCase()}`).digest('hex').slice(0,6);
 return `${browser}:${directory}:${hash}`;
}
function commandValue(command,flag){
 const match=command.match(new RegExp(flag+'=(?:"([^"]*)"|(\\S+))'));
 return match?(match[1]??match[2]):null;
}
function defaultUserDataDir(browser,{platform,home,env,exePath=''}){
 const p=platform==='win32'?path.win32:path.posix;
 if(platform==='win32'){
  const local=env.LOCALAPPDATA||p.join(home,'AppData','Local');
  if(browser==='edge')return p.join(local,'Microsoft','Edge','User Data');
  if(browser==='brave')return p.join(local,'BraveSoftware','Brave-Browser','User Data');
  if(browser==='chromium')return p.join(local,'Chromium','User Data');
  if(/Chrome SxS/i.test(exePath))return p.join(local,'Google','Chrome SxS','User Data');
  if(/Chrome Beta/i.test(exePath))return p.join(local,'Google','Chrome Beta','User Data');
  return p.join(local,'Google','Chrome','User Data');
 }
 if(platform==='darwin'){
  const support=p.join(home,'Library','Application Support');
  if(browser==='edge')return p.join(support,'Microsoft Edge');
  if(browser==='brave')return p.join(support,'BraveSoftware','Brave-Browser');
  if(browser==='chromium')return p.join(support,'Chromium');
  return p.join(support,'Google','Chrome');
 }
 if(browser==='edge')return p.join(home,'.config','microsoft-edge');
 if(browser==='brave')return p.join(home,'.config','BraveSoftware','Brave-Browser');
 if(browser==='chromium')return p.join(home,'.config','chromium');
 return p.join(home,'.config','google-chrome');
}
export function parseBrowserCommandLine(command,options={}){
 if(typeof command!=='string')return null;
 const tokens=command.match(/^\s*(?:"([^"]+)"|(\S+))/);
 const exe=tokens?.[1]??tokens?.[2];
 if(!exe)return null;
 const name=path.basename(exe).toLowerCase();
 const browser=name.includes('msedge')?'edge':name.includes('brave')?'brave':name.includes('chromium')?'chromium':name.includes('chrome')?'chrome':null;
 if(!browser)return null;
 const platform=options.platform??process.platform,home=options.home??homedir(),env=options.env??process.env;
 const userDataDir=commandValue(command,'--user-data-dir')||defaultUserDataDir(browser,{platform,home,env,exePath:exe});
 const profileDirectory=commandValue(command,'--profile-directory')||'Default';
 return{browser,userDataDir,profileDirectory};
}
export function browserIdentityFromProcesses(processes,options={}){
 for(const item of processes??[]){
  const identity=parseBrowserCommandLine(item?.command,options);
  if(identity)return identity;
 }
 return null;
}
async function processChain(){
 if(process.platform==='win32'){
  const script=`[Console]::OutputEncoding=[Text.Encoding]::UTF8;$id=${process.ppid};$items=@();for($i=0;$i -lt 5;$i++){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue;if(-not $p){break};$items+=[pscustomobject]@{pid=$p.ProcessId;name=$p.Name;command=$p.CommandLine};$id=$p.ParentProcessId};ConvertTo-Json -InputObject @($items) -Compress -Depth 3`;
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:4000,windowsHide:true,maxBuffer:64*1024});
  const parsed=JSON.parse(stdout||'[]');
  return Array.isArray(parsed)?parsed:[parsed];
 }
 const chain=[];let pid=process.ppid;
 for(let i=0;i<5&&pid>1;i++){
  const {stdout}=await execFileAsync('ps',['-o','pid=,ppid=,comm=,args=','-p',String(pid)],{timeout:2000});
  const line=stdout.trim();if(!line)break;
  const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);if(!match)break;
  chain.push({pid:Number(match[1]),name:match[3],command:match[4]});pid=Number(match[2]);
 }
 return chain;
}
export async function detectBrowserIdentity(options={}){
 if(process.env.KENNECT_BROWSER_SKIP_IDENTITY==='1')return null;
 try{return browserIdentityFromProcesses(await processChain(),options)}catch{return null}
}
export function selectProfile(entries,requested,defaultProfile){
 const list=Array.isArray(entries)?entries:[];
 const chosen=requested??defaultProfile;
 if(!chosen){
  const responsive=list.filter(entry=>entry.responsive);
  if(responsive.length===1)return responsive[0];
  const lines=list.map(entry=>`  - ${entry.profileId}${entry.responsive?'':' (not responding)'}`).join('\n');
  throw new Error(`No browser profile selected. Connected profiles:\n${lines||'  (none)'}\nPass profile on this call, run browser_set_default_profile once, or run: node controller.mjs set-default-profile <profile>`);
 }
 const entry=list.find(item=>item.profileId===chosen);
 if(!entry)throw new Error(`Unknown browser profile: ${chosen}. Connected profiles: ${list.map(item=>item.profileId).join(', ')||'none'}`);
 if(!entry.responsive)throw new Error(`Browser profile ${chosen} is not responding. Reopen Chrome in that profile.`);
 return entry;
}
function configPath(directory){return path.join(directory,'config.json')}
export async function readProfileConfig(directory=bridgeDirectory()){
 try{
  const parsed=JSON.parse(await readFile(configPath(directory),'utf8'));
  return typeof parsed.defaultProfile==='string'&&parsed.defaultProfile?parsed.defaultProfile:null;
 }catch{return null}
}
export async function writeDefaultProfile(directory,profileId){
 if(typeof profileId!=='string'||!profileId.trim()||profileId.length>200||/[\\/]/.test(profileId))throw new Error('Invalid profile ID.');
 await mkdir(directory,{recursive:true,mode:0o700});
 const file=configPath(directory),temporary=file+'.'+process.pid+'.tmp';
 await writeFile(temporary,JSON.stringify({defaultProfile:profileId},null,2)+'\n',{mode:0o600});
 await rename(temporary,file);
 return profileId;
}
