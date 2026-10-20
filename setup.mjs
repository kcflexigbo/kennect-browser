#!/usr/bin/env node
import {readFile,writeFile,mkdir,chmod,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';import {dirname,join,resolve} from 'node:path';import {homedir} from 'node:os';import {execFileSync} from 'node:child_process';
import {nativeHostPlan} from './platform.mjs';
export function configureMcp(existing,nodePath,serverPath){
 const out=[];let skip=false;
 for(const line of existing.split('\n')){const m=line.trim().match(/^\[([^\]]+)\]$/);if(m)skip=m[1]==='mcp_servers.codex_browser'||m[1].startsWith('mcp_servers.codex_browser.');if(!skip)out.push(line)}
 return out.join('\n').trimEnd()+'\n\n[mcp_servers.codex_browser]\ncommand = '+JSON.stringify(nodePath)+'\nargs = '+JSON.stringify([serverPath])+'\n';
}
async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Node.js 24 or newer is required. Windows packages include a compatible runtime.');
 const root=dirname(fileURLToPath(import.meta.url)),home=homedir(),nodePath=process.execPath;
 const plan=nativeHostPlan(process.platform,home,root,nodePath),id=(await readFile(join(root,'extension-id.txt'),'utf8')).trim();
 if(!/^[a-p]{32}$/.test(id))throw Error('Invalid extension ID.');
 plan.manifest.allowed_origins=[`chrome-extension://${id}/`];
 await mkdir(dirname(plan.manifestPath),{recursive:true});await mkdir(join(root,'install'),{recursive:true});
 await mkdir(dirname(plan.wrapperPath),{recursive:true,mode:0o700});
 await writeFile(plan.wrapperPath,plan.wrapper,{mode:0o700});if(process.platform!=='win32')await chmod(plan.wrapperPath,0o700);
 await writeFile(plan.manifestPath,JSON.stringify(plan.manifest,null,2)+'\n',{mode:0o600});
 if(plan.registry)execFileSync('reg.exe',plan.registry,{stdio:'pipe',windowsHide:true});
 await writeFile(join(root,'install','runtime.txt'),nodePath+'\n');
 const codexHome=process.env.CODEX_HOME||join(home,'.codex');await mkdir(codexHome,{recursive:true});const config=join(codexHome,'config.toml');let existing='';
 try{existing=await readFile(config,'utf8');await copyFile(config,config+'.codex-browser-backup-'+Date.now())}catch(e){if(e.code!=='ENOENT')throw e}
 await writeFile(config,configureMcp(existing,nodePath,join(root,'server.mjs')),{mode:0o600});
 console.log('Codex Browser local bridge and MCP configuration installed.');
 console.log('Next: open chrome://extensions, turn on Developer mode, click Load unpacked, and choose:');console.log(join(root,'extension'));
 console.log('The extension connects automatically after loading. Ask Codex to open a website in a new tab.');
 console.log('Restart or refresh Codex MCP tools if codex_browser is not listed. Re-run setup if you move this folder.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('Setup failed: '+e.message);process.exitCode=1});
