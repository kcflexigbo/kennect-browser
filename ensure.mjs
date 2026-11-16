import {access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
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
