const HOST='com.codex_browser.local';
let nativePort,connectedTab;const attached=new Set(),watching=new Set(),requests=new Map();const recordings=new Map(),consoleTabs=new Set(),consoleEntries=new Map();
const approvedOrigins=new Set();
function allowed(url){try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password}catch{return false}}
function approved(url){return allowed(url)&&approvedOrigins.has(new URL(url).origin)}
const cdp=(tabId,method,params={})=>chrome.debugger.sendCommand({tabId},method,params);
async function tab(id,enable=false){const t=await chrome.tabs.get(id??connectedTab);if(!t.url&&t.pendingUrl)t.url=t.pendingUrl;if(!allowed(t.url))throw Error('Browser internal pages and local files cannot be controlled.');if(!enable&&(!approved(t.url)||!attached.has(t.id)))throw Error('Open this website and click Connect in the Codex Browser extension first.');if(!attached.has(t.id)){await chrome.debugger.attach({tabId:t.id},'1.3');attached.add(t.id)}return t}
let nativeReady=false,nativeConnecting;
let autoConnect=true,retryTimer,retryDelay=1000;
function retryConnection(){
 if(!autoConnect||retryTimer)return;
 retryTimer=setTimeout(()=>{retryTimer=undefined;void startBridge();},retryDelay);
 retryDelay=Math.min(retryDelay*2,15000);
}
async function startBridge(){
 try{
  autoConnect=(await chrome.storage.local.get('autoConnect')).autoConnect!==false;
  if(!autoConnect)return;
  await connect();retryDelay=1000;await chrome.storage.session.set({connectionError:null});
 }catch(e){await chrome.storage.session.set({connectionError:e.message});retryConnection();}
}
function connect(){
 if(nativePort)return nativeReady?Promise.resolve():nativeConnecting;
 nativeConnecting=new Promise((resolve,reject)=>{
  nativePort=chrome.runtime.connectNative(HOST);const timer=setTimeout(()=>{nativePort?.disconnect();nativePort=null;nativeReady=false;reject(Error('Local bridge did not start. Run setup for this computer, then reconnect.'));retryConnection();},6000);
  nativePort.onMessage.addListener(async msg=>{
   if(msg.type==='ready'){nativeReady=true;clearTimeout(timer);resolve();return}
   if(msg.type!=='request')return;
   try{nativePort?.postMessage({type:'response',id:msg.id,result:await action(msg)})}catch(e){nativePort?.postMessage({type:'response',id:msg.id,error:e.message})}
  });
  nativePort.onDisconnect.addListener(()=>{clearTimeout(timer);nativeReady=false;nativePort=null;const error=chrome.runtime.lastError?.message??'Disconnected';chrome.storage.session.set({connectionError:error});reject(Error(error));retryConnection()});
 });return nativeConnecting;
}

chrome.debugger.onDetach.addListener(({tabId})=>{attached.delete(tabId);watching.delete(tabId);requests.delete(tabId);consoleTabs.delete(tabId);consoleEntries.delete(tabId);const r=recordings.get(tabId);if(r){r.stopped=true;clearInterval(r.timer);}recordings.delete(tabId)});
chrome.debugger.onEvent.addListener(({tabId},method,p)=>{
 if(consoleTabs.has(tabId)){
  let entry;if(method==='Runtime.consoleAPICalled')entry={type:p.type,text:p.args.map(a=>Object.hasOwn(a,'value')?String(a.value):a.description??a.type).join(' '),timestamp:p.timestamp};
  if(method==='Runtime.exceptionThrown')entry={type:'error',text:p.exceptionDetails.exception?.description??p.exceptionDetails.text,timestamp:p.timestamp};
  if(entry){const list=consoleEntries.get(tabId);list.push(entry);if(list.length>200)list.shift();}
 }
 if(!watching.has(tabId))return;const map=requests.get(tabId);if(!map)return;
 if(method==='Network.requestWillBeSent'){
  let u;try{u=new URL(p.request.url)}catch{return}if(!['http:','https:'].includes(u.protocol))return;
  const queryKeys=[...u.searchParams.keys()];u.search='';u.username='';u.password='';u.hash='';
  map.set(p.requestId,{requestId:p.requestId,url:u.href,queryKeys,method:p.request.method,type:p.type});
  if(map.size>500)map.delete(map.keys().next().value);
 }else if(method==='Network.responseReceived'){
  const r=map.get(p.requestId);if(r)Object.assign(r,{status:p.response.status,mimeType:p.response.mimeType});
 }else if(method==='Network.loadingFailed'){
  const r=map.get(p.requestId);if(r)r.error=p.errorText;
 }
});
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
 if(sender.id!==chrome.runtime.id)return;
 (async()=>{
  if(m.type==='connect'){
   autoConnect=true;await chrome.storage.local.set({autoConnect:true});clearTimeout(retryTimer);retryTimer=undefined;
   await connect();
   const current=await chrome.tabs.query({active:true,currentWindow:true});const t=current[0];
   if(t&&allowed(t.url)){approvedOrigins.add(new URL(t.url).origin);await tab(t.id,true);connectedTab=t.id;}
   await chrome.storage.session.set({connectedTab:connectedTab??null,connectionError:null});return{ok:true,tabId:connectedTab};
  }
  if(m.type==='disconnect'){autoConnect=false;await chrome.storage.local.set({autoConnect:false});clearTimeout(retryTimer);retryTimer=undefined;for(const id of [...attached])await chrome.debugger.detach({tabId:id}).catch(()=>{});nativePort?.disconnect();nativePort=null;nativeReady=false;connectedTab=undefined;approvedOrigins.clear();await chrome.storage.session.remove('connectedTab');return{ok:true}}
  if(m.type==='status')return{ok:true,tabId:connectedTab,connected:!!nativePort&&nativeReady,autoConnect,error:(await chrome.storage.session.get('connectionError')).connectionError};
  throw Error('Unknown popup action');
 })().then(respond,e=>respond({ok:false,error:e.message}));return true;
});
chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(startBridge);
void startBridge();
async function action({command,args=[],tabId}){
 if(!nativeReady)throw Error('Click Connect browser in the Codex Browser extension first.');
 if(command==='status'&&!connectedTab&&!tabId)return JSON.stringify({transport:'extension',connected:true,tabId:null});
 if(command==='open-tab'){
  if(!allowed(args[0]))throw Error('Only HTTP and HTTPS websites can be opened.');
  const n=await chrome.tabs.create({url:args[0]});approvedOrigins.add(new URL(args[0]).origin);await tab(n.id,true);connectedTab=n.id;return JSON.stringify({targetId:String(n.id)});
 }
 if(command==='tabs'){const all=await chrome.tabs.query({});return JSON.stringify(all.filter(t=>allowed(t.url)).map(t=>({tabId:String(t.id),title:t.title,url:t.url,windowId:t.windowId,active:!!t.active,connected:approved(t.url)&&attached.has(t.id)})))}
 if(command==='select-tab'){
  const target=await tab(tabId?Number(tabId):connectedTab,true);
  approvedOrigins.add(new URL(target.url).origin);connectedTab=target.id;
  await chrome.tabs.update(target.id,{active:true});await chrome.windows.update(target.windowId,{focused:true});return 'Tab connected and selected.';
 }
 const t=await tab(tabId?Number(tabId):connectedTab),id=t.id;
 switch(command){
  case 'groups':{const groups=await chrome.tabGroups.query({});const tabs=await chrome.tabs.query({});const visible=new Set(tabs.filter(t=>attached.has(t.id)&&approved(t.url)).map(t=>t.groupId));return JSON.stringify(groups.filter(g=>visible.has(g.id)));}
  case 'group':{const ids=JSON.parse(args[0]);for(const target of ids)await tab(Number(target));const groupId=await chrome.tabs.group({tabIds:ids.map(Number)});await chrome.tabGroups.update(groupId,{title:args[1]||'Codex',color:args[2]||'cyan'});return JSON.stringify({groupId});}
  case 'group-update':{const groupId=Number(args[0]),changes=JSON.parse(args[1]);const all=await chrome.tabs.query({groupId});if(!all.length||!all.every(t=>attached.has(t.id)&&approved(t.url)))throw Error('Connect every tab in this group before managing it.');await chrome.tabGroups.update(groupId,changes);return 'Group updated.';}
  case 'ungroup':{const ids=JSON.parse(args[0]);for(const target of ids)await tab(Number(target));await chrome.tabs.ungroup(ids.map(Number));return 'Tabs ungrouped.';}
  case 'move-tab':await chrome.tabs.move(id,{index:Number(args[0])});return 'Tab moved.';
  case 'resize':{const width=Number(args[0]),height=Number(args[1]);if(width<320||height<240||width>4000||height>4000)throw Error('Invalid window size');await chrome.windows.update(t.windowId,{width,height});return 'Window resized.';}
  case 'file-inputs':{const {root}=await cdp(id,'DOM.getDocument',{depth:-1,pierce:true});const {nodeIds}=await cdp(id,'DOM.querySelectorAll',{nodeId:root.nodeId,selector:'input[type=file]'});const result=[];for(const nodeId of nodeIds){const {node}=await cdp(id,'DOM.describeNode',{nodeId});result.push({nodeId:node.backendNodeId,attributes:node.attributes})}return JSON.stringify(result);}
  case 'upload':{const paths=JSON.parse(args[1]);if(!Array.isArray(paths)||!paths.length||!paths.every(p=>typeof p==='string'&&p.startsWith('/')))throw Error('Use absolute local file paths.');await cdp(id,'DOM.setFileInputFiles',{backendNodeId:Number(args[0]),files:paths});return 'Files attached. Verify before submitting.';}
  case 'console-start':if((new URL(t.url).hostname==='zhipin.com'||new URL(t.url).hostname.endsWith('.zhipin.com')))throw Error('Console collection is disabled on BOSS because it triggers page reloads. Use explicit JavaScript or network tools instead.');consoleEntries.set(id,[]);consoleTabs.add(id);await cdp(id,'Runtime.enable');return 'Console capture started. Object handles are not evaluated or expanded.';
  case 'console-logs':return JSON.stringify(consoleEntries.get(id)??[]);
  case 'console-stop':consoleTabs.delete(id);await cdp(id,'Runtime.disable');return 'Console capture stopped.';
  case 'record-start':{
   const opts=JSON.parse(args[0]||'{}'),interval=opts.intervalMs??700,maxFrames=opts.maxFrames??30;if(interval<250||interval>5000||maxFrames<1||maxFrames>60)throw Error('Invalid recording settings');
   const old=recordings.get(id);if(old)clearInterval(old.timer);const recording={frames:[],busy:false,stopped:false,bytes:0,timer:null,error:null};recordings.set(id,recording);
   const capture=async()=>{if(recording.busy||recording.stopped||recording.frames.length>=maxFrames)return;recording.busy=true;try{
    const {cssVisualViewport:v}=await cdp(id,'Page.getLayoutMetrics');const scale=Math.min(1,800/v.clientWidth);const {data}=await cdp(id,'Page.captureScreenshot',{format:'png',clip:{x:v.pageX,y:v.pageY,width:v.clientWidth,height:v.clientHeight,scale}});
    if(recording.stopped)return;recording.bytes+=data.length;if(recording.bytes>12*1024*1024){clearInterval(recording.timer);return;}recording.frames.push({png:data,duration:interval});if(recording.frames.length>=maxFrames)clearInterval(recording.timer);
   }catch(e){recording.error=e.message;clearInterval(recording.timer)}finally{recording.busy=false}};
   await capture();if(recording.error)throw Error(recording.error);if(recording.frames.length<maxFrames)recording.timer=setInterval(capture,interval);return 'Recording started. Capture stops automatically at the frame or memory limit.';
  }
  case 'record-stop':{const r=recordings.get(id);if(!r)throw Error('No recording exists');r.stopped=true;clearInterval(r.timer);return JSON.stringify({frames:r.frames.length,error:r.error});}
  case 'record-export':{const r=recordings.get(id);if(!r||!r.frames.length)throw Error('No recording frames exist');r.stopped=true;clearInterval(r.timer);return {frames:r.frames};}
  case 'record-clear':{const r=recordings.get(id);if(r){r.stopped=true;clearInterval(r.timer);}recordings.delete(id);return 'Recording cleared.';}
  case 'status':return JSON.stringify({title:t.title,url:t.url,transport:'extension',tabId:id});
  case 'snapshot':{const {nodes}=await cdp(id,'Accessibility.getFullAXTree');return [`Page: ${t.title}`,`URL: ${t.url}`,...nodes.filter(n=>!n.ignored&&n.name?.value&&n.role?.value!=='InlineTextBox').map(n=>`[${n.backendDOMNodeId??'-'}] ${n.role?.value}: ${n.name.value}`)].join('\n')}
  case 'navigate':if(!approved(args[0]))throw Error('Connect this website in the extension before navigating to it.');await chrome.tabs.update(id,{url:args[0]});return 'Navigation requested.';
  case 'close-tab':await chrome.tabs.remove(id);return 'Tab closed.';
  case 'click':{
   const node=Number(args[0]);const {nodes}=await cdp(id,'Accessibility.getFullAXTree');if(!nodes.some(n=>!n.ignored&&n.backendDOMNodeId===node))throw Error('Element is stale; take a new snapshot.');
   await cdp(id,'DOM.scrollIntoViewIfNeeded',{backendNodeId:node});const {model}=await cdp(id,'DOM.getBoxModel',{backendNodeId:node});const q=model.content,x=(q[0]+q[2]+q[4]+q[6])/4,y=(q[1]+q[3]+q[5]+q[7])/4;
   await cdp(id,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await cdp(id,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});return 'Clicked. Verify with a fresh snapshot.';
  }
  case 'fill':{
   const node=Number(args[0]);const {nodes}=await cdp(id,'Accessibility.getFullAXTree');if(!nodes.some(n=>!n.ignored&&n.backendDOMNodeId===node&&['textbox','searchbox','combobox'].includes(n.role?.value)))throw Error('Use a current text field ID.');
   const modifiers=(await chrome.runtime.getPlatformInfo()).os==='mac'?4:2;await cdp(id,'DOM.focus',{backendNodeId:node});await cdp(id,'Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers,windowsVirtualKeyCode:65});await cdp(id,'Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers,windowsVirtualKeyCode:65});await cdp(id,'Input.insertText',{text:args.slice(1).join(' ')});return 'Field filled.';
  }
  case 'type':await cdp(id,'Input.insertText',{text:args.join(' ')});return 'Text entered.';
  case 'key':{const parts=args[0].split('+'),key=parts.pop(),codes={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,Space:32};if(!Object.hasOwn(codes,key)&&!/^[a-zA-Z0-9]$/.test(key))throw Error('Unsupported key');let modifiers=0;for(const p of parts){const bit={Alt:1,Ctrl:2,Meta:4,Shift:8}[p];if(!bit)throw Error('Unsupported modifier');modifiers|=bit}const code=key.length===1?(/[a-z]/i.test(key)?'Key'+key.toUpperCase():'Digit'+key):key;const data={key:key==='Space'?' ':key,code,modifiers,windowsVirtualKeyCode:codes[key]??key.toUpperCase().charCodeAt(0)};await cdp(id,'Input.dispatchKeyEvent',{type:'keyDown',...data});await cdp(id,'Input.dispatchKeyEvent',{type:'keyUp',...data});return 'Key pressed.';}
  case 'scroll':{const deltaY=Number(args[0]);if(!Number.isFinite(deltaY)||Math.abs(deltaY)>2000)throw Error('Invalid scroll distance');const {cssVisualViewport:v}=await cdp(id,'Page.getLayoutMetrics');await cdp(id,'Input.dispatchMouseEvent',{type:'mouseWheel',x:v.clientWidth/2,y:v.clientHeight/2,deltaX:0,deltaY});return 'Scrolled.'}
  case 'mouse':{const a=JSON.parse(args[0]);if(!Number.isFinite(a.x)||!Number.isFinite(a.y)||a.x<0||a.y<0)throw Error('Invalid screenshot coordinates');
   if(a.action==='hover'){await cdp(id,'Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x,y:a.y});return 'Pointer moved.';}
   const button=a.action==='right_click'?'right':'left',clickCount=a.action==='double_click'?2:a.action==='triple_click'?3:1;
   if(a.action==='drag'){if(!Number.isFinite(a.endX)||!Number.isFinite(a.endY))throw Error('Missing drag destination');await cdp(id,'Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x,y:a.y});await cdp(id,'Input.dispatchMouseEvent',{type:'mousePressed',x:a.x,y:a.y,button:'left',clickCount:1});for(let i=1;i<=10;i++)await cdp(id,'Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x+(a.endX-a.x)*i/10,y:a.y+(a.endY-a.y)*i/10,button:'left',buttons:1});await cdp(id,'Input.dispatchMouseEvent',{type:'mouseReleased',x:a.endX,y:a.endY,button:'left',clickCount:1});return 'Dragged.';}
   for(let i=1;i<=clickCount;i++){await cdp(id,'Input.dispatchMouseEvent',{type:'mousePressed',x:a.x,y:a.y,button,clickCount:i});await cdp(id,'Input.dispatchMouseEvent',{type:'mouseReleased',x:a.x,y:a.y,button,clickCount:i});}return 'Clicked.';}
  case 'screenshot':{let clip;if(args[1]){clip=JSON.parse(args[1]);if(!['x','y','width','height'].every(k=>Number.isFinite(clip[k]))||clip.width<=0||clip.height<=0)throw Error('Invalid screenshot region');clip.scale=1}return{png:(await cdp(id,'Page.captureScreenshot',{format:'png',...(clip?{clip}:{})})).data};}
  case 'evaluate':{const r=await cdp(id,'Runtime.evaluate',{expression:args[0],awaitPromise:true,returnByValue:true,timeout:8000});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return JSON.stringify(r.result.value??{type:r.result.type,description:r.result.description})}
  case 'network-start':requests.set(id,new Map());watching.add(id);await cdp(id,'Network.enable');return 'Request capture started. Headers, cookies, query values and request bodies are excluded.';
  case 'network-requests':return JSON.stringify([...(requests.get(id)?.values()??[])]);
  case 'network-stop':watching.delete(id);await cdp(id,'Network.disable');return 'Request capture stopped.';
  case 'network-body':if(!requests.get(id)?.has(args[0]))throw Error('Unknown request ID in this capture');return JSON.stringify(await cdp(id,'Network.getResponseBody',{requestId:args[0]}));
  default:throw Error('Unsupported browser command');
 }
}
