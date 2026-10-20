#!/usr/bin/env node
// Independent browser adapter. Accessibility and native input by default; JavaScript is explicit.
// Do not enable Runtime/console collection: BOSS logs objects with side-effecting getters.
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {bridgeCall} from './bridge-client.mjs';
import {browserProfile} from './platform.mjs';
const profile=browserProfile();
const [command='snapshot',...args]=process.argv.slice(2);
function checkUrl(value){
 const url=new URL(value);
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Only HTTP or HTTPS website URLs are allowed.');
 return url.href;
}
let socket;
try{
 const bridge=await bridgeCall(command,args,process.env.KENNECT_BROWSER_TAB_ID);
 if(bridge){let output;if(command==='screenshot'){await writeFile(args[0],Buffer.from(bridge.result.png,'base64'));output=args[0]}else output=typeof bridge.result==='string'?bridge.result:JSON.stringify(bridge.result);await new Promise(r=>process.stdout.write(output+'\n',r));process.exit(0);}
 if(command==='navigate'||command==='open-tab')checkUrl(args[0]);
 const port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid local Chrome port.');
 const endpoint=`http://127.0.0.1:${port}`;
 const pages=await (await fetch(`${endpoint}/json/list`,{signal:AbortSignal.timeout(5000)})).json();
 const websitePages=pages.filter(p=>p.type==='page'&&(()=>{try{checkUrl(p.url);return true}catch{return false}})());
 const page=process.env.KENNECT_BROWSER_TAB_ID?websitePages.find(p=>p.id===process.env.KENNECT_BROWSER_TAB_ID):websitePages[0];
 if(!page)throw new Error('Open a website in the dedicated browser first.');
 checkUrl(page.url);
 const wsUrl=new URL(page.webSocketDebuggerUrl);
 if(wsUrl.hostname!=='127.0.0.1'||Number(wsUrl.port)!==port)throw new Error('Expected the local dedicated Chrome endpoint.');
 socket=new WebSocket(wsUrl);let serial=0;const pending=new Map();
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chrome connection timed out.')),5000);socket.onopen=()=>{clearTimeout(timer);resolve()};socket.onerror=()=>{clearTimeout(timer);reject(new Error('Cannot connect to dedicated Chrome.'))}});
 socket.onmessage=event=>{const msg=JSON.parse(event.data);const task=pending.get(msg.id);if(!task)return;pending.delete(msg.id);clearTimeout(task.timer);msg.error?task.reject(new Error(msg.error.message)):task.resolve(msg.result)};
 socket.onclose=()=>{for(const task of pending.values()){clearTimeout(task.timer);task.reject(new Error('Chrome connection closed.'))}pending.clear()};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out; action was not retried.`))},8000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
 const tree=async()=>(await call('Accessibility.getFullAXTree')).nodes;
 switch(command){
  case 'evaluate':{const r=await call('Runtime.evaluate',{expression:args[0],awaitPromise:true,returnByValue:true,timeout:8000});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);console.log(JSON.stringify(r.result.value??{type:r.result.type,description:r.result.description}));break;}
  case 'record-start':case 'record-stop':case 'record-export':case 'record-clear':case 'console-start':case 'console-logs':case 'console-stop':case 'groups':case 'group':case 'group-update':case 'ungroup':case 'move-tab':case 'resize':case 'file-inputs':case 'upload':case 'mouse':case 'network-start':case 'network-stop':case 'network-requests':case 'network-body':throw new Error('This action requires the Kennect Browser extension. Open the website and click Connect.');
  case 'tabs':console.log(JSON.stringify(websitePages.map(p=>({tabId:p.id,title:p.title,url:p.url}))));break;
  case 'open-tab':console.log(JSON.stringify(await call('Target.createTarget',{url:checkUrl(args[0])})));break;
  case 'close-tab':await call('Target.closeTarget',{targetId:page.id});console.log('Tab closed.');break;
  case 'fill':{
   const id=Number(args[0]);const n=(await tree()).find(n=>!n.ignored&&n.backendDOMNodeId===id);
   if(!n||!['textbox','searchbox','combobox'].includes(n.role?.value))throw new Error('Use a text field ID from a fresh snapshot.');
   await call('DOM.focus',{backendNodeId:id});
   await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:process.platform==='darwin'?4:2,windowsVirtualKeyCode:65});
   await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:process.platform==='darwin'?4:2,windowsVirtualKeyCode:65});
   await call('Input.insertText',{text:args.slice(1).join(' ')});console.log('Field filled.');break;
  }
  case 'status':console.log(JSON.stringify({title:page.title,url:page.url,profile}));break;
  case 'snapshot':{
   console.log(`Page: ${page.title}\nURL: ${page.url}`);
   for(const n of await tree())if(!n.ignored&&n.name?.value&&n.role?.value!=='InlineTextBox')console.log(`[${n.backendDOMNodeId??'-'}] ${n.role?.value}: ${n.name.value}`);
   break;
  }
  case 'click':{
   const id=Number(args[0]);if(!Number.isInteger(id)||id<=0)throw new Error('Use a backend node ID from a fresh snapshot.');
   if(!(await tree()).some(n=>!n.ignored&&n.backendDOMNodeId===id))throw new Error('Element is stale; take a fresh snapshot.');
   await call('DOM.scrollIntoViewIfNeeded',{backendNodeId:id});
   const {model}=await call('DOM.getBoxModel',{backendNodeId:id});const q=model.content;
   const x=(q[0]+q[2]+q[4]+q[6])/4,y=(q[1]+q[3]+q[5]+q[7])/4;
   await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
   await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
   console.log('Clicked. Take a fresh snapshot to verify the result.');break;
  }
  case 'type':await call('Input.insertText',{text:args.join(' ')});console.log('Text entered into the focused field.');break;
  case 'key':{
   const keys={Enter:{key:'Enter',code:'Enter',windowsVirtualKeyCode:13},Tab:{key:'Tab',code:'Tab',windowsVirtualKeyCode:9},Escape:{key:'Escape',code:'Escape',windowsVirtualKeyCode:27},Backspace:{key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8}};
   const key=keys[args[0]];if(!key)throw new Error('Supported keys: Enter, Tab, Escape, Backspace.');
   await call('Input.dispatchKeyEvent',{type:'keyDown',...key});await call('Input.dispatchKeyEvent',{type:'keyUp',...key});console.log('Key pressed.');break;
  }
  case 'scroll':{
   const deltaY=Number(args[0]);if(!Number.isFinite(deltaY)||Math.abs(deltaY)>2000)throw new Error('Scroll must be between -2000 and 2000 pixels.');
   const {cssVisualViewport:v}=await call('Page.getLayoutMetrics');await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:v.clientWidth/2,y:v.clientHeight/2,deltaX:0,deltaY});console.log('Scrolled.');break;
  }
  case 'screenshot':{
   if(!args[0])throw new Error('Provide an output PNG path.');
   let clip;if(args[1]){clip=JSON.parse(args[1]);if(!['x','y','width','height'].every(k=>Number.isFinite(clip[k]))||clip.width<=0||clip.height<=0)throw new Error('Invalid screenshot region');clip.scale=1;}
   const {data}=await call('Page.captureScreenshot',{format:'png',...(clip?{clip}:{})});await writeFile(args[0],Buffer.from(data,'base64'));console.log(args[0]);break;
  }
  case 'navigate':{
   const r=await call('Page.navigate',{url:checkUrl(args[0])});if(r.errorText)throw new Error(r.errorText);console.log('Navigation requested. Take a fresh snapshot.');break;
  }
  default:throw new Error('Commands: status, snapshot, click NODE_ID, type TEXT, key KEY, scroll PIXELS, screenshot PATH, navigate BOSS_URL.');
 }
}catch(error){console.error(error.message);process.exitCode=1}finally{socket?.close()}
