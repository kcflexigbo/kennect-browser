import {access,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {listProfiles} from './bridge-client.mjs';
import {chromeProfiles,chooseExtensionProfile,defaultUserDataDir} from './profiles.mjs';
export const DEFAULT_TIMEOUT_MS=30000,MIN_TIMEOUT_MS=5000,MAX_TIMEOUT_MS=60000;
export function normalizeDirectory(value,platform=process.platform){
 const normalized=String(value??'').trim().replaceAll('\\','/').replace(/\/+$/,'');
 return platform==='linux'?normalized:normalized.toLowerCase();
}
export function buildLaunchArgs({userDataDir,profileDirectory}){
 return [`--user-data-dir=${userDataDir}`,`--profile-directory=${profileDirectory}`,'--new-window','--no-first-run','--no-default-browser-check','about:blank'];
}
export function ensureChildTimeout(timeoutMs=DEFAULT_TIMEOUT_MS){return Math.min((timeoutMs??DEFAULT_TIMEOUT_MS)+5000,65000)}
async function pathExists(value){try{await access(value);return true}catch{return false}}
export async function findChromeExecutable({platform=process.platform,env=process.env,home=homedir(),exists=pathExists}={}){
 const local=env.LOCALAPPDATA||join(home,'AppData','Local');
 const candidates=platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:platform==='win32'?[join(local,'Google','Chrome','Application','chrome.exe'),join(env.ProgramFiles||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),join(env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe')]:['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
 for(const candidate of candidates)if(await exists(candidate))return{path:candidate,candidates};
 return{path:null,candidates};
}
function defaultSleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function readServerVersion(){const parsed=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));return typeof parsed.version==='string'?parsed.version:null}
async function defaultProfileScan({platform,home,env}){
 const userDataDir=defaultUserDataDir('chrome',{platform,home,env});
 const extensionId=(await readFile(new URL('./extension-id.txt',import.meta.url),'utf8')).trim();
 return chromeProfiles({userDataDir,extensionId});
}
function validateEnsureOptions({profileDirectory,timeoutMs}){
 if(profileDirectory!==undefined&&(typeof profileDirectory!=='string'||!profileDirectory.trim()||profileDirectory.length>100||/[\u0000-\u001f\u007f]/.test(profileDirectory)))throw Error('Invalid profile directory.');
 if(!Number.isInteger(timeoutMs)||timeoutMs<MIN_TIMEOUT_MS||timeoutMs>MAX_TIMEOUT_MS)throw Error(`Invalid timeoutMs; use ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}.`);
}
function buildResult({launched,chosen,profiles,profileDirectory,serverVersion,identityWarning}){
 const warnings=[];
 if(chosen?.extensionVersion&&serverVersion&&chosen.extensionVersion!==serverVersion)warnings.push(`Connected extension ${chosen.extensionVersion} does not match server ${serverVersion}. Reload the extension in chrome://extensions.`);
 if(identityWarning)warnings.push(identityWarning);
 return{launched,profileId:chosen?.profileId??null,browser:chosen?.browser??null,label:chosen?.label??null,profileDirectory:profileDirectory??chosen?.profileDirectory??null,extensionVersion:chosen?.extensionVersion??null,profiles,warning:warnings.length?warnings.join(' '):null};
}
export async function ensureBrowser({profileDirectory,timeoutMs=DEFAULT_TIMEOUT_MS,platform=process.platform,env=process.env,home=homedir(),listProfilesImpl=listProfiles,spawnImpl=spawn,profileScanImpl=defaultProfileScan,chromeExecutableImpl=findChromeExecutable,serverVersion,sleep=defaultSleep,now=Date.now}={}){
 validateEnsureOptions({profileDirectory,timeoutMs});
 const resolvedServerVersion=serverVersion??await readServerVersion();
 const requested=profileDirectory===undefined?null:profileDirectory.trim();
 const before=await listProfilesImpl();
 const responsiveBefore=(before?.profiles??[]).filter(item=>item.responsive);
 if(requested){
  const match=responsiveBefore.find(item=>item.profileDirectory&&normalizeDirectory(item.profileDirectory,platform)===normalizeDirectory(requested,platform));
  if(match)return buildResult({launched:false,chosen:match,profiles:before.profiles??[],profileDirectory:match.profileDirectory,serverVersion:resolvedServerVersion});
 }else if(responsiveBefore.length){
  const chosen=responsiveBefore.find(item=>item.profileId===before?.default)??[...responsiveBefore].sort((a,b)=>String(a.profileId).localeCompare(String(b.profileId)))[0];
  return buildResult({launched:false,chosen,profiles:before.profiles??[],profileDirectory:chosen.profileDirectory,serverVersion:resolvedServerVersion});
 }
 const scanResult=await profileScanImpl({platform,home,env});
 let chosenScan;
 if(requested){
  chosenScan=scanResult.profiles.find(item=>normalizeDirectory(item.directory,platform)===normalizeDirectory(requested,platform));
  if(!chosenScan)throw Error(`Chrome profile "${requested}" was not found. Profiles: ${scanResult.profiles.map(item=>item.directory).join(', ')||'(none)'}.`);
  if(!chosenScan.extensionEnabled)throw Error(`Chrome profile "${requested}" does not have the Kennect Browser extension enabled. Enable it in chrome://extensions.`);
 }else{
  chosenScan=chooseExtensionProfile(scanResult);
  if(!chosenScan)throw Error(`No Chrome profile has the Kennect Browser extension enabled. Load it in chrome://extensions. This version does not scan a custom --user-data-dir, Chrome Beta, Canary, or SxS install. Checked: ${scanResult.profiles.map(item=>item.directory).join(', ')||'(none)'}.`);
 }
 const executable=await chromeExecutableImpl({platform,env,home});
 if(!executable?.path)throw Error(`Google Chrome was not found. Checked: ${executable?.candidates?.join(', ')||'(no candidates)'}.`);
 const args=buildLaunchArgs({userDataDir:scanResult.userDataDir,profileDirectory:chosenScan.directory});
 let child;
 try{child=spawnImpl(executable.path,args,{detached:true,stdio:'ignore'})}catch(error){throw Error(`Chrome failed to launch: ${error.message}`)}
 child.unref?.();
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
 const deadline=now()+timeoutMs;
 const seen=new Set(responsiveBefore.map(item=>item.profileId));
 let finalListing=before,connected=null;
 while(now()<deadline){
  await sleep(500);
  finalListing=await listProfilesImpl();
  const current=(finalListing?.profiles??[]).filter(item=>item.responsive);
  const targetKey=normalizeDirectory(requested??chosenScan.directory,platform);
  const directoryMatch=current.find(item=>item.profileDirectory&&normalizeDirectory(item.profileDirectory,platform)===targetKey);
  const newMatch=current.find(item=>!seen.has(item.profileId));
  connected=directoryMatch??newMatch??null;
  if(connected)break;
 }
 if(!connected)throw Error(`Chrome was launched, but the Kennect Browser extension did not connect within ${Math.round(timeoutMs/1000)} seconds. Open the extension in that profile and click Connect; check that it is not paused or disabled.`);
 return buildResult({launched:true,chosen:connected,profiles:finalListing.profiles??[],profileDirectory:requested??chosenScan.directory,serverVersion:resolvedServerVersion,identityWarning:connected.profileDirectory?null:'Connection identity was not confirmed; verify with browser_profiles.'});
}
