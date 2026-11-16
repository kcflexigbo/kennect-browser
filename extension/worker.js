const HOST='com.kennect_browser.local';
let nativePort,connectedTab,instanceId;const attached=new Set(),watching=new Set(),requests=new Map();const recordings=new Map(),consoleTabs=new Set(),consoleEntries=new Map(),trackedDownloads=new Map();
const downloadsReady=chrome.storage.session.get('toolDownloads').then(saved=>{for(const entry of saved.toolDownloads??[])if(Array.isArray(entry)&&Number.isInteger(entry[0]))trackedDownloads.set(entry[0],entry[1])}).catch(()=>{});
const WINDOW_REGISTRY_KEY='windowRegistry';
let windowRegistry={};
const windowsReady=chrome.storage.session.get(WINDOW_REGISTRY_KEY).then(saved=>{windowRegistry=Object.assign({},saved?.[WINDOW_REGISTRY_KEY]??{})}).catch(()=>{});
let windowQueue=Promise.resolve();
function withWindowRegistry(fn){const run=windowQueue.then(async()=>{await windowsReady;return fn()});windowQueue=run.catch(()=>{});return run}
async function saveWindowRegistry(){await chrome.storage.session.set({[WINDOW_REGISTRY_KEY]:windowRegistry})}
function activeClaim(entry,now=Date.now()){return entry&&entry.ownerSession&&Number(entry.leaseUntil)>now?entry:null}
function ownerLabel(sessionId){return String(sessionId??'').slice(0,8)}
function pruneWindowRegistry(liveIds){for(const key of Object.keys(windowRegistry))if(!liveIds.has(Number(key)))delete windowRegistry[key]}
function windowSummary(win,entry,sessionId,tabs){
 const claim=activeClaim(entry);
 return{windowId:win.id,name:entry?.name??null,purpose:entry?.purpose??null,createdByTool:entry?.createdByTool??false,owner:claim?ownerLabel(claim.ownerSession):null,claimedByYou:!!claim&&claim.ownerSession===sessionId,claimedByOther:!!claim&&claim.ownerSession!==sessionId,leaseUntil:claim?new Date(claim.leaseUntil).toISOString():null,focused:!!win.focused,state:win.state??'normal',bounds:{left:win.left??0,top:win.top??0,width:win.width??0,height:win.height??0},tabCount:tabs.length,connectedTabCount:tabs.filter(t=>approved(t.url)&&attached.has(t.id)).length};
}
const EMULATION_KEY='emulations';
let emulations={};
const emulationApplied=new Set();
const emulationsReady=chrome.storage.session.get(EMULATION_KEY).then(saved=>{emulations=Object.assign({},saved?.[EMULATION_KEY]??{})}).catch(()=>{});
let emulationQueue=Promise.resolve();
function withEmulationState(fn){const run=emulationQueue.then(async()=>{await emulationsReady;return fn()});emulationQueue=run.catch(()=>{});return run}
async function saveEmulations(){await chrome.storage.session.set({[EMULATION_KEY]:emulations})}
const originalUserAgent=globalThis.navigator?.userAgent??'';
const orientationAngles={portraitPrimary:0,landscapePrimary:90,portraitSecondary:180,landscapeSecondary:270};
function validateEmulation(options){
 if(!Number.isInteger(options.width)||options.width<100||options.width>4000)throw Error('Invalid emulation width.');
 if(!Number.isInteger(options.height)||options.height<100||options.height>4000)throw Error('Invalid emulation height.');
 const deviceScaleFactor=options.deviceScaleFactor??1;
 if(typeof deviceScaleFactor!=='number'||!Number.isFinite(deviceScaleFactor)||deviceScaleFactor<1||deviceScaleFactor>4)throw Error('Invalid device scale factor.');
 if(options.mobile!==undefined&&typeof options.mobile!=='boolean')throw Error('Invalid mobile flag.');
 if(options.touch!==undefined&&typeof options.touch!=='boolean')throw Error('Invalid touch flag.');
 let userAgent=null;
 if(options.userAgent!==undefined){
  if(typeof options.userAgent!=='string')throw Error('Invalid user agent.');
  userAgent=options.userAgent.trim();
  if(!userAgent||userAgent.length>500||/[\u0000-\u001f\u007f]/.test(userAgent))throw Error('Invalid user agent.');
 }
 const orientation=options.orientation??null;
 if(orientation!==null&&!Object.hasOwn(orientationAngles,orientation))throw Error('Invalid orientation.');
 return{width:options.width,height:options.height,deviceScaleFactor,mobile:options.mobile===true,touch:options.touch===true,userAgent,orientation};
}
function publicEmulation(state){return{width:state.width,height:state.height,deviceScaleFactor:state.deviceScaleFactor,mobile:state.mobile,touch:state.touch,userAgent:state.userAgent??null,orientation:state.orientation??null}}
async function applyEmulation(id,state){
 await cdp(id,'Emulation.setDeviceMetricsOverride',{width:state.width,height:state.height,deviceScaleFactor:state.deviceScaleFactor,mobile:state.mobile,...(state.orientation?{screenOrientation:{type:state.orientation,angle:orientationAngles[state.orientation]}}:{})});
 await cdp(id,'Emulation.setTouchEmulationEnabled',{enabled:state.touch,...(state.touch?{maxTouchPoints:5}:{})});
 await cdp(id,'Emulation.setEmitTouchEventsForMouse',{enabled:state.touch,...(state.touch?{configuration:'mobile'}:{})});
 if(state.userAgent)await cdp(id,'Emulation.setUserAgentOverride',{userAgent:state.userAgent});
}
async function clearEmulation(id,state){
 await cdp(id,'Emulation.clearDeviceMetricsOverride');
 await cdp(id,'Emulation.setTouchEmulationEnabled',{enabled:false});
 await cdp(id,'Emulation.setEmitTouchEventsForMouse',{enabled:false});
 if(state?.userAgent&&state?.originalUserAgent)await cdp(id,'Emulation.setUserAgentOverride',{userAgent:state.originalUserAgent});
}
async function tabForEmulation(id){
 const targetId=id??connectedTab;if(!Number.isInteger(targetId))throw Error('Select a website tab first.');
 const t=await chrome.tabs.get(targetId);if(!t)throw Error('Tab not found. Take a fresh tabs list.');
 if(!t.url&&t.pendingUrl)t.url=t.pendingUrl;
 if(!allowed(t.url))throw Error('Browser internal pages and local files cannot be controlled.');
 if(!approved(t.url))throw Error('Open this website and click Connect in the Kennect Browser extension first.');
 await ensureAttached(t);
 return t;
}
async function emulateDevice(options,sessionId,tabId){
 const next=validateEmulation(options);
 return withEmulationState(async()=>{
  const t=await tabForEmulation(tabId?Number(tabId):undefined);
  assertWindowAccess(t.windowId,sessionId);
  const previous=emulations[t.id]??null;
  const state={...next,originalUserAgent:previous?.originalUserAgent??originalUserAgent};
  try{
   if(previous?.userAgent&&!state.userAgent)await cdp(t.id,'Emulation.setUserAgentOverride',{userAgent:state.originalUserAgent});
   await applyEmulation(t.id,state);
  }catch(error){
   await clearEmulation(t.id,{...state,userAgent:previous?.userAgent??state.userAgent}).catch(()=>{});
   delete emulations[t.id];emulationApplied.delete(t.id);await saveEmulations();
   throw Error(`Could not apply device emulation: ${error.message}`);
  }
  emulations[t.id]=state;emulationApplied.add(t.id);await saveEmulations();
  return JSON.stringify({tabId:String(t.id),...publicEmulation(state),applied:true});
 });
}
async function clearDeviceEmulation(sessionId,tabId){
 return withEmulationState(async()=>{
  const t=await tabForEmulation(tabId?Number(tabId):undefined);
  assertWindowAccess(t.windowId,sessionId);
  const state=emulations[t.id]??{originalUserAgent};
  try{await clearEmulation(t.id,state)}catch(error){
   delete emulations[t.id];emulationApplied.delete(t.id);await saveEmulations();
   throw Error(`Could not clear device emulation: ${error.message}`);
  }
  delete emulations[t.id];emulationApplied.delete(t.id);await saveEmulations();
  return JSON.stringify({tabId:String(t.id),cleared:true});
 });
}
async function applyStoredEmulation(id){
 return withEmulationState(async()=>{
  const state=emulations[id];if(!state||emulationApplied.has(id))return;
  try{await applyEmulation(id,state);emulationApplied.add(id)}
  catch(error){throw Error(`Could not reapply device emulation: ${error.message}`)}
 });
}
async function identity(){if(instanceId)return instanceId;const saved=await chrome.storage.local.get('instanceId');instanceId=typeof saved.instanceId==='string'&&saved.instanceId?saved.instanceId:crypto.randomUUID();if(saved.instanceId!==instanceId)await chrome.storage.local.set({instanceId});return instanceId}
async function accountEmail(){try{const info=await chrome.identity?.getProfileUserInfo?.({accountStatus:'ANY'});return typeof info?.email==='string'&&info.email?info.email.slice(0,40):''}catch{return ''}}
async function announce(){const id=await identity();const saved=await chrome.storage.local.get('profileLabel');const manual=typeof saved.profileLabel==='string'?saved.profileLabel.trim().slice(0,40):'';const label=manual||await accountEmail();nativePort?.postMessage({type:'hello',instanceId:id,label,extensionVersion:chrome.runtime.getManifest().version,userAgent:globalThis.navigator?.userAgent??''})}
chrome.storage.onChanged?.addListener?.((changes,area)=>{if(area==='local'&&changes.profileLabel)void announce().catch(()=>{})});
const approvedOrigins=new Set();
function allowed(url){try{const u=new URL(url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password}catch{return false}}
function approved(url){return allowed(url)&&approvedOrigins.has(new URL(url).origin)}
const cdp=(tabId,method,params={})=>chrome.debugger.sendCommand({tabId},method,params);
async function ensureAttached(t){if(attached.has(t.id))return;try{await chrome.debugger.attach({tabId:t.id},'1.3')}catch(e){if(!/Another debugger is already attached/i.test(e?.message??''))throw e}attached.add(t.id)}
async function persistState(){await chrome.storage.session.set({approvedOrigins:[...approvedOrigins],connectedTab:connectedTab??null})}
async function restoreState(){const s=await chrome.storage.session.get(['approvedOrigins','connectedTab']);for(const origin of s.approvedOrigins??[])approvedOrigins.add(origin);if(Number.isInteger(s.connectedTab))connectedTab=s.connectedTab}
const stateReady=restoreState().catch(()=>{});
async function tab(id,enable=false){const targetId=id??connectedTab;if(!Number.isInteger(targetId))throw Error('Select a website tab first.');const t=await chrome.tabs.get(targetId);if(!t)throw Error('Tab not found. Take a fresh tabs list.');if(!t.url&&t.pendingUrl)t.url=t.pendingUrl;if(!allowed(t.url))throw Error('Browser internal pages and local files cannot be controlled.');if(!enable&&!approved(t.url))throw Error('Open this website and click Connect in the Kennect Browser extension first.');await ensureAttached(t);await applyStoredEmulation(t.id);return t}
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
   if(msg.type==='ready'){nativeReady=true;clearTimeout(timer);try{await announce()}catch{}resolve();return}
   if(msg.type!=='request')return;
   try{nativePort?.postMessage({type:'response',id:msg.id,result:await action(msg)})}catch(e){nativePort?.postMessage({type:'response',id:msg.id,error:e.message})}
  });
  nativePort.onDisconnect.addListener(()=>{clearTimeout(timer);nativeReady=false;nativePort=null;const error=chrome.runtime.lastError?.message??'Disconnected';chrome.storage.session.set({connectionError:error});reject(Error(error));retryConnection()});
 });return nativeConnecting;
}

chrome.debugger.onDetach.addListener(({tabId})=>{attached.delete(tabId);emulationApplied.delete(tabId);watching.delete(tabId);requests.delete(tabId);consoleTabs.delete(tabId);consoleEntries.delete(tabId);const r=recordings.get(tabId);if(r){r.stopped=true;clearInterval(r.timer);}recordings.delete(tabId)});
chrome.tabs.onRemoved.addListener(tabId=>{emulationApplied.delete(tabId);void withEmulationState(async()=>{if(!emulations[tabId])return;delete emulations[tabId];await saveEmulations()}).catch(()=>{})});
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
   await chrome.storage.session.set({connectionError:null});await persistState();return{ok:true,tabId:connectedTab};
  }
  if(m.type==='disconnect'){autoConnect=false;await chrome.storage.local.set({autoConnect:false});clearTimeout(retryTimer);retryTimer=undefined;for(const id of [...attached])await chrome.debugger.detach({tabId:id}).catch(()=>{});nativePort?.disconnect();nativePort=null;nativeReady=false;connectedTab=undefined;approvedOrigins.clear();await emulationsReady;emulations={};emulationApplied.clear();await chrome.storage.session.remove(['approvedOrigins','connectedTab',EMULATION_KEY]);return{ok:true}}
  if(m.type==='status')return{ok:true,tabId:connectedTab,connected:!!nativePort&&nativeReady,autoConnect,error:(await chrome.storage.session.get('connectionError')).connectionError};
  throw Error('Unknown popup action');
 })().then(respond,e=>respond({ok:false,error:e.message}));return true;
});
chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(startBridge);
void startBridge();
function validateWindowName(value){const name=String(value??'').trim();if(!name||name.length>40||/[\u0000-\u001f\u007f]/.test(name))throw Error('Window name must be 1-40 characters without control characters.');return name}
function validateWindowPurpose(value){const purpose=String(value??'').trim();if(purpose.length>200)throw Error('Window purpose must be 200 characters or fewer.');return purpose}
function validateWindowBounds(options){const hasWidth=options.width!==undefined,hasHeight=options.height!==undefined;if(hasWidth!==hasHeight)throw Error('Pass width and height together.');if(hasWidth&&(!Number.isInteger(options.width)||options.width<320||options.width>4000))throw Error('Invalid window width.');if(hasHeight&&(!Number.isInteger(options.height)||options.height<240||options.height>4000))throw Error('Invalid window height.');for(const key of ['left','top'])if(options[key]!==undefined&&(!Number.isInteger(options[key])||options[key]<-20000||options[key]>20000))throw Error(`Invalid window ${key}.`)}
async function openWindow(options,sessionId){
 if(!allowed(options.url))throw Error('Only HTTP and HTTPS websites can be opened.');
 const url=new URL(options.url).href;
 validateWindowBounds(options);
 const name=options.name===undefined?null:validateWindowName(options.name);
 const purpose=options.purpose===undefined?null:validateWindowPurpose(options.purpose);
 if(options.claim===true&&!name)throw Error('A window claim requires a name.');
 const leaseMs=options.leaseMs??1800000;
 if(!Number.isInteger(leaseMs)||leaseMs<60000||leaseMs>86400000)throw Error('Invalid lease duration.');
 return withWindowRegistry(async()=>{
  const all=await chrome.windows.getAll({populate:true,windowTypes:['normal']});
  pruneWindowRegistry(new Set(all.map(w=>w.id)));
  if(name){
   const existing=all.find(w=>String(windowRegistry[w.id]?.name??'').trim().toLowerCase()===name.toLowerCase());
   if(existing){
    if(!options.reuseExisting)throw Error(`Window name "${name}" is already used by window ${existing.id}.`);
    const entry=windowRegistry[existing.id];
    const claim=activeClaim(entry);
    if(claim&&claim.ownerSession!==sessionId)throw Error(`Window ${existing.id} "${entry.name}" is claimed by another agent.`);
    if(options.claim===true){entry.ownerSession=sessionId;entry.claimedAt=Date.now();entry.leaseMs=leaseMs;entry.leaseUntil=Date.now()+leaseMs;}
    await saveWindowRegistry();
    const current=activeClaim(entry);
    return JSON.stringify({windowId:existing.id,tabId:null,name:entry.name,reused:true,owner:current?ownerLabel(current.ownerSession):null,claimedByYou:!!current&&current.ownerSession===sessionId,leaseUntil:current?new Date(current.leaseUntil).toISOString():null});
   }
  }
  const win=await chrome.windows.create({url,type:'normal',focused:options.focused??false,...(options.width!==undefined?{width:options.width,height:options.height}:{}),...(options.left!==undefined?{left:options.left}:{}),...(options.top!==undefined?{top:options.top}:{})});
  const created=win.tabs?.[0]??(await chrome.tabs.query({windowId:win.id}))[0];
  if(!created)throw Error('Chrome did not create a tab in the new window.');
  approvedOrigins.add(new URL(url).origin);
  await tab(created.id,true);
  connectedTab=created.id;
  await persistState();
  const entry={windowId:win.id,name,purpose,ownerSession:null,claimedAt:null,leaseUntil:null,leaseMs,createdByTool:true,createdAt:Date.now()};
  if(options.claim===true){entry.ownerSession=sessionId;entry.claimedAt=Date.now();entry.leaseUntil=Date.now()+leaseMs;}
  windowRegistry[win.id]=entry;
  await saveWindowRegistry();
  const current=activeClaim(entry);
  return JSON.stringify({windowId:win.id,tabId:String(created.id),name,reused:false,owner:current?ownerLabel(current.ownerSession):null,claimedByYou:!!current&&current.ownerSession===sessionId,leaseUntil:current?new Date(current.leaseUntil).toISOString():null});
 });
}
async function updateWindow(windowId,changes,sessionId){
 if(!Number.isInteger(windowId)||windowId<0)throw Error('Invalid window ID.');
 const keys=['width','height','left','top','focused','state','name','purpose','claim'];
 if(!keys.some(key=>changes[key]!==undefined))throw Error('Provide at least one window change.');
 validateWindowBounds(changes);
 const states=['normal','minimized','maximized','fullscreen'];
 if(changes.state!==undefined&&!states.includes(changes.state))throw Error('Invalid window state.');
 return withWindowRegistry(async()=>{
  const all=await chrome.windows.getAll({populate:true,windowTypes:['normal']});
  const live=new Set(all.map(w=>w.id));
  pruneWindowRegistry(live);
  const entry=windowRegistry[windowId];
  if(!live.has(windowId)||!entry)throw Error('Unknown window ID. Refresh with browser_windows.');
  assertWindowAccess(windowId,sessionId,{force:changes.force===true});
  const name=changes.name===undefined?undefined:validateWindowName(changes.name);
  if(name){
   const conflict=all.find(w=>w.id!==windowId&&String(windowRegistry[w.id]?.name??'').trim().toLowerCase()===name.toLowerCase());
   if(conflict)throw Error(`Window name "${name}" is already used by window ${conflict.id}.`);
  }
  const purpose=changes.purpose===undefined?undefined:(changes.purpose?validateWindowPurpose(changes.purpose):null);
  if(changes.claim===true){
   if(!(name??entry.name))throw Error('A window claim requires a name.');
   const lease=changes.leaseMs??entry.leaseMs??1800000;
   if(!Number.isInteger(lease)||lease<60000||lease>86400000)throw Error('Invalid lease duration.');
  }
  const update={};
  for(const key of ['width','height','left','top','focused','state'])if(changes[key]!==undefined)update[key]=changes[key];
  if(changes.width!==undefined)update.state='normal';
  if(Object.keys(update).length)await chrome.windows.update(windowId,update);
  if(changes.state!==undefined&&changes.width!==undefined&&changes.state!=='normal')await chrome.windows.update(windowId,{state:changes.state});
  if(purpose!==undefined)entry.purpose=purpose;
  if(name!==undefined)entry.name=name;
  if(changes.claim===true){claimWindow(entry,sessionId,changes.leaseMs);}
  else if(changes.claim===false){if(activeClaim(entry)&&entry.ownerSession!==sessionId&&!changes.force)throw Error(`Window ${windowId} is claimed by another agent.`);releaseWindow(entry);}
  if(changes.claim===undefined)renewWindowClaim(entry,sessionId);
  await saveWindowRegistry();
  const win=await chrome.windows.get(windowId);
  const tabs=await chrome.tabs.query({windowId});
  return JSON.stringify(windowSummary(win,entry,sessionId,tabs));
 });
}
async function closeWindow(windowId,sessionId,force){
 if(!Number.isInteger(windowId)||windowId<0)throw Error('Invalid window ID.');
 return withWindowRegistry(async()=>{
  const all=await chrome.windows.getAll({windowTypes:['normal']});
  pruneWindowRegistry(new Set(all.map(w=>w.id)));
  const entry=windowRegistry[windowId];
  if(!entry?.createdByTool)throw Error('Only windows created by browser_open_window in this browser session can be closed. Close user windows manually.');
  if(all.length<=1)throw Error('Refusing to close the only Chrome window.');
  const claim=activeClaim(entry);
  if(claim&&claim.ownerSession!==sessionId&&!force)throw Error(`Window ${windowId} is claimed by another agent until ${new Date(claim.leaseUntil).toISOString()}. Use another window or ask the user to release the claim.`);
  await chrome.windows.remove(windowId);
  delete windowRegistry[windowId];
  await saveWindowRegistry();
  return JSON.stringify({closed:true,windowId});
 });
}
function assertWindowAccess(windowId,sessionId,{force=false}={}){
 const entry=windowRegistry[windowId];
 const claim=activeClaim(entry);
 if(claim&&claim.ownerSession!==sessionId&&!force)throw Error(`Window ${windowId}${entry?.name?` "${entry.name}"`:''} is claimed by another agent until ${new Date(claim.leaseUntil).toISOString()}. Use another window or ask the user to release the claim.`);
}
function renewWindowClaim(entry,sessionId){if(entry?.ownerSession===sessionId&&activeClaim(entry))entry.leaseUntil=Date.now()+(entry.leaseMs??1800000)}
function claimWindow(entry,sessionId,leaseMs){
 if(!entry.name)throw Error('A window claim requires a name.');
 const lease=leaseMs??entry.leaseMs??1800000;
 if(!Number.isInteger(lease)||lease<60000||lease>86400000)throw Error('Invalid lease duration.');
 entry.ownerSession=sessionId;entry.claimedAt=Date.now();entry.leaseMs=lease;entry.leaseUntil=Date.now()+lease;
}
function releaseWindow(entry){entry.ownerSession=null;entry.claimedAt=null;entry.leaseUntil=null}
async function action({command,args=[],tabId,sessionId='local'}){
 if(!nativeReady)throw Error('Click Connect browser in the Kennect Browser extension first.');
 if(command==='ping')return 'pong';
 sessionId=sessionId||'local';
 await Promise.all([stateReady,windowsReady,emulationsReady]);
 if(command==='download-status'){
  await downloadsReady;
  const downloadId=Number(args[0]);if(!Number.isInteger(downloadId)||!trackedDownloads.has(downloadId))throw Error('Unknown download ID for this session.');
  const [item]=await chrome.downloads.search({id:downloadId});if(!item)throw Error('Download record not found.');
  const status={downloadId,state:item.state,paused:!!item.paused,bytesReceived:item.bytesReceived??0,totalBytes:item.totalBytes??0,filename:item.filename||null,mime:item.mime||null,error:item.error||null};
  if(item.state==='complete'&&/^text\/html/i.test(item.mime||''))status.warning='HTML response; verify this is the requested PDF.';
  return JSON.stringify(status);
 }
 if(command==='status'&&!connectedTab&&!tabId)return JSON.stringify({transport:'extension',connected:true,tabId:null});
 if(command==='open-tab')return withWindowRegistry(async()=>{
  if(!allowed(args[0]))throw Error('Only HTTP and HTTPS websites can be opened.');
  let targetWindowId;
  if(args[3]!==undefined&&args[3]!=='')targetWindowId=Number(args[3]);
  else if(Number.isInteger(connectedTab)){const current=await chrome.tabs.get(connectedTab).catch(()=>null);if(current)targetWindowId=current.windowId;}
  if(targetWindowId===undefined)targetWindowId=(await chrome.windows.getLastFocused({windowTypes:['normal']})).id;
  if(!Number.isInteger(targetWindowId)||targetWindowId<0)throw Error('Invalid window ID.');
  assertWindowAccess(targetWindowId,sessionId);
  const n=await chrome.tabs.create({url:args[0],windowId:targetWindowId});approvedOrigins.add(new URL(args[0]).origin);await tab(n.id,true);connectedTab=n.id;
  renewWindowClaim(windowRegistry[targetWindowId],sessionId);await saveWindowRegistry();await persistState();
  let groupId=null;const title=args[1],color=args[2];
  if(title){const [existing]=await chrome.tabGroups.query({title,windowId:n.windowId});if(existing){groupId=existing.id;await chrome.tabs.group({tabIds:[n.id],groupId})}else{groupId=await chrome.tabs.group({tabIds:[n.id]});await chrome.tabGroups.update(groupId,{title,color:color||'cyan'})}}
  return JSON.stringify({targetId:String(n.id),windowId:targetWindowId,...(groupId===null?{}:{groupId})});
 });
 if(command==='close-window')return closeWindow(Number(args[0]),sessionId,args[1]==='1');
 if(command==='update-window')return updateWindow(Number(args[0]),JSON.parse(args[1]||'{}'),sessionId);
 if(command==='emulate-device')return emulateDevice(JSON.parse(args[0]||'{}'),sessionId,tabId);
 if(command==='clear-emulation')return clearDeviceEmulation(sessionId,tabId);
 if(command==='open-window')return openWindow(JSON.parse(args[0]||'{}'),sessionId);
 if(command==='windows'){
  return withWindowRegistry(async()=>{
   const all=await chrome.windows.getAll({populate:true,windowTypes:['normal']});
   const live=new Set(all.map(w=>w.id));
   pruneWindowRegistry(live);
   const allTabs=await chrome.tabs.query({});
   const name=String(args[0]??'').trim().toLowerCase();
   const list=all.filter(w=>!name||String(windowRegistry[w.id]?.name??'').toLowerCase()===name).map(w=>windowSummary(w,windowRegistry[w.id],sessionId,allTabs.filter(t=>t.windowId===w.id)));
   await saveWindowRegistry();
   return JSON.stringify({windows:list});
  });
 }
 if(command==='tabs'){const filter=args[0]!==undefined&&args[0]!==''?Number(args[0]):null;if(filter!==null&&(!Number.isInteger(filter)||filter<0))throw Error('Invalid window ID.');const all=await chrome.tabs.query({}),groups=await chrome.tabGroups.query({}),titles=new Map(groups.map(g=>[g.id,g.title]));return JSON.stringify(all.filter(t=>allowed(t.url)&&(filter===null||t.windowId===filter)).map(t=>({tabId:String(t.id),title:t.title,url:t.url,windowId:t.windowId,active:!!t.active,connected:approved(t.url),groupId:t.groupId??-1,groupTitle:t.groupId>=0?titles.get(t.groupId)??null:null,emulation:emulations[t.id]?publicEmulation(emulations[t.id]):null,emulationActive:emulationApplied.has(t.id)})))}
 if(command==='select-tab'){
  const target=await tab(tabId?Number(tabId):connectedTab,true);
  approvedOrigins.add(new URL(target.url).origin);connectedTab=target.id;
  await chrome.tabs.update(target.id,{active:true});await chrome.windows.update(target.windowId,{focused:true});await persistState();return 'Tab connected and selected.';
 }
 const t=await tab(tabId?Number(tabId):connectedTab),id=t.id;
 switch(command){
  case 'groups':{const groups=await chrome.tabGroups.query({});const tabs=await chrome.tabs.query({});const visible=new Set(tabs.filter(t=>attached.has(t.id)&&approved(t.url)).map(t=>t.groupId));return JSON.stringify(groups.filter(g=>visible.has(g.id)));}
  case 'group':{const ids=JSON.parse(args[0]).map(Number);for(const target of ids)await tab(target);const groupId=await chrome.tabs.group({tabIds:ids});await chrome.tabGroups.update(groupId,{title:args[1]||'Codex',color:args[2]||'cyan'});const grouped=(await chrome.tabs.query({groupId})).filter(t=>ids.includes(t.id));return JSON.stringify({groupId,tabIds:grouped.map(t=>t.id)});}
  case 'group-update':{const groupId=Number(args[0]),changes=JSON.parse(args[1]);const all=await chrome.tabs.query({groupId});if(!all.length||!all.every(t=>attached.has(t.id)&&approved(t.url)))throw Error('Connect every tab in this group before managing it.');await chrome.tabGroups.update(groupId,changes);return 'Group updated.';}
  case 'ungroup':{const ids=JSON.parse(args[0]);for(const target of ids)await tab(Number(target));await chrome.tabs.ungroup(ids.map(Number));return 'Tabs ungrouped.';}
  case 'move-tab':{const sourceWindowId=t.windowId;const destinationWindowId=args[1]!==undefined&&args[1]!==''?Number(args[1]):sourceWindowId;if(!Number.isInteger(destinationWindowId)||destinationWindowId<0)throw Error('Invalid window ID.');return withWindowRegistry(async()=>{assertWindowAccess(sourceWindowId,sessionId);if(destinationWindowId!==sourceWindowId)assertWindowAccess(destinationWindowId,sessionId);await chrome.tabs.move(id,{index:Number(args[0]),...(destinationWindowId!==sourceWindowId?{windowId:destinationWindowId}:{})});renewWindowClaim(windowRegistry[sourceWindowId],sessionId);if(destinationWindowId!==sourceWindowId)renewWindowClaim(windowRegistry[destinationWindowId],sessionId);await saveWindowRegistry();return 'Tab moved.';});}
  case 'resize':{const width=Number(args[0]),height=Number(args[1]);if(width<320||height<240||width>4000||height>4000)throw Error('Invalid window size');const targetWindowId=args[2]!==undefined&&args[2]!==''?Number(args[2]):t.windowId;if(!Number.isInteger(targetWindowId)||targetWindowId<0)throw Error('Invalid window ID.');return withWindowRegistry(async()=>{assertWindowAccess(targetWindowId,sessionId);await chrome.windows.update(targetWindowId,{width,height});renewWindowClaim(windowRegistry[targetWindowId],sessionId);await saveWindowRegistry();return 'Window resized.';});}
  case 'file-inputs':{const {root}=await cdp(id,'DOM.getDocument',{depth:-1,pierce:true});const {nodeIds}=await cdp(id,'DOM.querySelectorAll',{nodeId:root.nodeId,selector:'input[type=file]'});const result=[];for(const nodeId of nodeIds){const {node}=await cdp(id,'DOM.describeNode',{nodeId});result.push({nodeId:node.backendNodeId,attributes:node.attributes})}return JSON.stringify(result);}
  case 'upload':{const paths=JSON.parse(args[1]);if(!Array.isArray(paths)||!paths.length||!paths.every(p=>typeof p==='string'&&(p.startsWith('/')||/^[A-Za-z]:[\\/]/.test(p))))throw Error('Use absolute local file paths.');await cdp(id,'DOM.setFileInputFiles',{backendNodeId:Number(args[0]),files:paths});return 'Files attached. Verify before submitting.';}
  case 'download':{
   const url=args[0];if(!allowed(url))throw Error('Only HTTP and HTTPS downloads are allowed.');
   const filename=args[1]||undefined;
   if(filename!==undefined&&(typeof filename!=='string'||!filename.trim()||filename.length>260||/^[\\/]/.test(filename)||/^[A-Za-z]:/.test(filename)||filename.split(/[\\/]/).includes('..')))throw Error('Filename must be relative to the download directory and must not use ..');
   const downloadId=await chrome.downloads.download({url,...(filename?{filename}:{}),conflictAction:'uniquify',saveAs:false});
   trackedDownloads.set(downloadId,{tabId:id,at:Date.now()});await chrome.storage.session.set({toolDownloads:[...trackedDownloads]});
   return JSON.stringify({downloadId});
  }
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
