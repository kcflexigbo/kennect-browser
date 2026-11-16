import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
async function environment(options={}){
 const pages=new Map([[1,{id:1,url:'https://www.zhipin.com/',title:'BOSS',windowId:1}],[2,{id:2,url:'https://example.com/',title:'Example',windowId:1}]]);const windows=new Map([[1,{id:1,focused:true,state:'normal',left:0,top:0,width:1200,height:800,type:'normal'}]]);let nextWindowId=10,nextTabId=10;let popup;const calls=[];const lifecycle={};const saved={};const sessionSaved={};const attachedTabs=new Set();const posted=[];const downloadCalls=[];let nativeConnections=0;
 const event=()=>({addListener(){}});const chrome={tabs:{get:async id=>pages.get(id),query:async options=>options.active?[pages.get(1)]:options.windowId!==undefined?[...pages.values()].filter(t=>t.windowId===options.windowId):options.groupId!==undefined?[...pages.values()].filter(t=>t.groupId===options.groupId):[...pages.values()],create:async({url,windowId})=>{const t={id:nextTabId++,url,title:'New tab',windowId:windowId??1};pages.set(t.id,t);return t},move:async(tabIds,{windowId}={})=>{for(const id of [].concat(tabIds)){const t=pages.get(Number(id));if(t&&windowId!==undefined)t.windowId=windowId}},onRemoved:{addListener(fn){lifecycle.tabRemoved=fn}}},windows:{create:async options=>{const id=nextWindowId++;const win={id,focused:options.focused??false,state:'normal',left:options.left??0,top:options.top??0,width:options.width??1200,height:options.height??800,type:'normal'};windows.set(id,win);const tab={id:nextTabId++,url:options.url,title:'New window',windowId:id};pages.set(tab.id,tab);return{...win,tabs:[tab]}},get:async id=>windows.get(id),getAll:async()=>[...windows.values()].map(w=>({...w,tabs:[...pages.values()].filter(t=>t.windowId===w.id)})),remove:async id=>{windows.delete(id);for(const[tabId,tab]of pages)if(tab.windowId===id)pages.delete(tabId)},update:async(id,changes)=>Object.assign(windows.get(id),changes),getLastFocused:async()=>[...windows.values()].find(w=>w.focused)??[...windows.values()][0]},debugger:{attach:async({tabId})=>{if(attachedTabs.has(tabId))throw Error('Another debugger is already attached to the tab.');attachedTabs.add(tabId)},detach:async({tabId})=>{attachedTabs.delete(tabId)},onDetach:event(),onEvent:event(),sendCommand:async(target,method)=>{calls.push(method);if(method==='Runtime.enable')throw Error('Continuous console collection must not be enabled');return method==='Accessibility.getFullAXTree'?{nodes:[]}:{};}},runtime:{id:'test',getManifest:()=>({version:'0.6.0'}),onStartup:{addListener(fn){lifecycle.startup=fn}},onInstalled:{addListener(fn){lifecycle.installed=fn}},onMessage:{addListener(fn){popup=fn}},connectNative:()=>{nativeConnections++;return({onMessage:{addListener(fn){queueMicrotask(()=>fn({type:'ready'}))}},onDisconnect:event(),postMessage(message){posted.push(message)},disconnect(){}})}},storage:{local:{get:async()=>saved,set:async value=>Object.assign(saved,value)},session:{get:async keys=>{if(keys==null)return{...sessionSaved};if(Array.isArray(keys))return Object.fromEntries(keys.filter(k=>k in sessionSaved).map(k=>[k,sessionSaved[k]]));if(typeof keys==='string')return keys in sessionSaved?{[keys]:sessionSaved[keys]}:{};return{}},set:async value=>Object.assign(sessionSaved,value),remove:async keys=>{for(const key of [].concat(keys??[]))delete sessionSaved[key]}}},tabGroups:{query:async()=>[],update:async()=>{}},downloads:{download:async options=>{downloadCalls.push(options);return 42},search:async()=>[]}};
 if(options.delayRegistryGet){const get=chrome.storage.session.get;chrome.storage.session.get=async keys=>{const result=await get(keys);if(keys==='windowRegistry'||(Array.isArray(keys)&&keys.includes('windowRegistry')))await new Promise(r=>setTimeout(r,50));return result}}
 if(options.delayEmulationsGet){const get=chrome.storage.session.get;chrome.storage.session.get=async keys=>{const result=await get(keys);if(keys==='emulations'||(Array.isArray(keys)&&keys.includes('emulations')))await new Promise(r=>setTimeout(r,50));return result}}
 let scope;const load=async()=>{scope=vm.createContext({chrome,URL,Map,Set,Error,Number,JSON,Object,setTimeout,clearTimeout,crypto,navigator:{userAgent:'test-agent'}});vm.runInContext(await readFile(new URL('./extension/worker.js',import.meta.url),'utf8'),scope);await new Promise(resolve=>setImmediate(resolve))};await load();
 const connect=()=>new Promise(resolve=>popup({type:'connect'},{id:'test'},resolve));
 return{pages,windows,calls,lifecycle,saved,sessionSaved,seedRegistry:async value=>{sessionSaved.windowRegistry=value;await load()},get scope(){return scope},connect,restart:load,posted:()=>posted,downloadCalls,nativeConnections:()=>nativeConnections,disconnect:()=>new Promise(resolve=>popup({type:'disconnect'},{id:'test'},resolve))};
}
test('extension requires a user connection before reading a tab',async()=>{const e=await environment();await assert.rejects(e.scope.action({command:'snapshot',tabId:1}),/click Connect/i);assert.equal((await e.connect()).ok,true);await e.scope.action({command:'snapshot',tabId:1});assert.ok(e.calls.includes('Accessibility.getFullAXTree'));});
test('navigation to another origin names the new origin and the reselect recovery',async()=>{
 const e=await environment();
 await e.connect();
 e.pages.get(1).url='https://example.com/sign-in';
 await assert.rejects(e.scope.action({command:'snapshot',tabId:1}),error=>{
  assert.match(error.message,/https:\/\/example\.com/);
  assert.match(error.message,/browser_select_tab/);
  assert.match(error.message,/tabId 1/);
  assert.match(error.message,/unrelated|unexpected/i);
  assert.match(error.message,/decide/i);
  assert.match(error.message,/check with the user/i);
  return true;
 });
 e.scope.chrome.tabs.update=async()=>{};
 e.scope.chrome.windows={update:async()=>{}};
 await e.scope.action({command:'select-tab',tabId:1});
 await e.scope.action({command:'snapshot',tabId:1});
 assert.ok(e.calls.includes('Accessibility.getFullAXTree'));
});
test('grouping refuses tabs the user has not connected',async()=>{const e=await environment();await e.connect();await assert.rejects(e.scope.action({command:'group',args:['[1,2]','Test','cyan']}),/click Connect/i);});
test('browser can connect from an internal page and create a website tab',async()=>{const e=await environment();e.pages.get(1).url='chrome://extensions/';e.scope.chrome.tabs.create=async({url})=>{const t={id:3,url,title:'New tab',windowId:1};e.pages.set(3,t);return t};assert.equal((await e.connect()).ok,true);assert.equal(JSON.parse(await e.scope.action({command:'status'})).transport,'extension');await e.scope.action({command:'open-tab',args:['https://example.com/']});await e.scope.action({command:'snapshot',tabId:3});await assert.rejects(e.scope.action({command:'open-tab',args:['file:///tmp/test']}),/HTTP/);});
test('opening a new tab requires a connected bridge',async()=>{const e=await environment();await e.disconnect();await assert.rejects(e.scope.action({command:'open-tab',args:['https://example.com/']}),/Connect/);});

test('connects automatically without attaching existing tabs',async()=>{const e=await environment();assert.equal(e.nativeConnections(),1);assert.equal(JSON.parse(await e.scope.action({command:'status'})).transport,'extension');await assert.rejects(e.scope.action({command:'snapshot',tabId:1}),/click Connect/i);});
test('startup preserves an explicit disconnect until resumed',async()=>{const e=await environment();await e.disconnect();assert.equal(e.saved.autoConnect,false);await e.lifecycle.startup();assert.equal(e.nativeConnections(),1);await e.connect();assert.equal(e.saved.autoConnect,true);assert.equal(e.nativeConnections(),2);});

test('automatic connection can open a new website without a popup click',async()=>{const e=await environment();e.scope.chrome.tabs.create=async({url})=>{const t={id:3,url,title:'New tab',windowId:1};e.pages.set(3,t);return t};assert.equal(JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/']})).targetId,'3');await e.scope.action({command:'snapshot',tabId:3});});

test('lists existing website tabs without attaching them',async()=>{const e=await environment();e.pages.set(3,{id:3,url:'chrome://extensions/',title:'Extensions'});const tabs=JSON.parse(await e.scope.action({command:'tabs'}));assert.deepEqual(tabs.map(t=>t.tabId),['1','2']);assert.equal(tabs[1].connected,false);await assert.rejects(e.scope.action({command:'snapshot',tabId:2}),/click Connect/i);});
test('selects and connects an existing website tab',async()=>{const e=await environment();e.scope.chrome.tabs.update=async()=>{};e.scope.chrome.windows={update:async()=>{}};await e.scope.action({command:'select-tab',tabId:2});await e.scope.action({command:'snapshot',tabId:2});assert.equal(JSON.parse(await e.scope.action({command:'status'})).tabId,2);});
test('selecting an internal page is refused',async()=>{const e=await environment();e.pages.set(3,{id:3,url:'chrome://settings/'});await assert.rejects(e.scope.action({command:'select-tab',tabId:3}),/internal pages/);});

test('open-tab joins the named task group and returns its ID',async()=>{
 const e=await environment();
 let next=10;const groups=[];const members=new Map();
 e.scope.chrome.tabs.create=async({url})=>{const t={id:100+members.size+groups.length,url,title:'New tab',windowId:1};e.pages.set(t.id,t);return t};
 e.scope.chrome.tabGroups={query:async({title,windowId})=>groups.filter(g=>g.title===title&&g.windowId===windowId),update:async(id,changes)=>{Object.assign(groups.find(g=>g.id===id),changes)}};
 e.scope.chrome.tabs.group=async({tabIds,groupId})=>{if(groupId===undefined){groupId=next++;groups.push({id:groupId,title:'',windowId:1})}if(!members.has(groupId))members.set(groupId,new Set());for(const id of tabIds){members.get(groupId).add(id);e.pages.get(id).groupId=groupId}return groupId};
 const first=JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/a','Tricycle sellers','cyan']}));
 const second=JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/b','Tricycle sellers','cyan']}));
 assert.equal(first.groupId,second.groupId);
 assert.equal(groups.find(g=>g.id===first.groupId).title,'Tricycle sellers');
 assert.deepEqual([...members.get(first.groupId)],[Number(first.targetId),Number(second.targetId)]);
});
test('tab listing reports group membership',async()=>{
 const e=await environment();
 e.pages.get(1).groupId=7;e.pages.get(2).groupId=-1;
 e.scope.chrome.tabGroups={query:async()=>[{id:7,title:'Task',color:'cyan'}]};
 const tabs=JSON.parse(await e.scope.action({command:'tabs'}));
 assert.equal(tabs.find(t=>t.tabId==='1').groupId,7);
 assert.equal(tabs.find(t=>t.tabId==='1').groupTitle,'Task');
 assert.equal(tabs.find(t=>t.tabId==='2').groupId,-1);
 assert.equal(tabs.find(t=>t.tabId==='2').groupTitle,null);
});
test('grouping reports the tabs that joined the group',async()=>{
 const e=await environment();
 await e.connect();
 e.scope.chrome.tabs.update=async()=>{};e.scope.chrome.windows={update:async()=>{}};
 await e.scope.action({command:'select-tab',tabId:2});
 e.scope.chrome.tabs.group=async({tabIds})=>{for(const id of tabIds)e.pages.get(id).groupId=9;return 9};
 e.scope.chrome.tabGroups={update:async()=>{}};
 const result=JSON.parse(await e.scope.action({command:'group',args:['[1,2]','Task','cyan']}));
 assert.equal(result.groupId,9);
 assert.deepEqual(result.tabIds,[1,2]);
});
test('download starts an HTTP(S) download with a non-overwriting filename',async()=>{
 const e=await environment();
 await e.connect();
 const result=JSON.parse(await e.scope.action({command:'download',args:['https://example.com/paper.pdf','paper.pdf']}));
 assert.equal(result.downloadId,42);
 assert.equal(e.downloadCalls[0].url,'https://example.com/paper.pdf');
 assert.equal(e.downloadCalls[0].filename,'paper.pdf');
 assert.equal(e.downloadCalls[0].conflictAction,'uniquify');
 assert.equal(e.downloadCalls[0].saveAs,false);
});
test('download rejects non-HTTP URLs and parent-directory filenames',async()=>{
 const e=await environment();
 await e.connect();
 await assert.rejects(e.scope.action({command:'download',args:['file:///tmp/paper.pdf']}),/HTTP/);
 await assert.rejects(e.scope.action({command:'download',args:['https://example.com/paper.pdf','../paper.pdf']}),/relative/);
 await assert.rejects(e.scope.action({command:'download',args:['https://example.com/paper.pdf','C:\\paper.pdf']}),/relative/);
});
test('download-status reports completion without exposing the URL',async()=>{
 const e=await environment();
 e.scope.chrome.downloads.download=async()=>7;
 e.scope.chrome.downloads.search=async({id})=>id===7?[{state:'complete',paused:false,bytesReceived:42,totalBytes:42,filename:'C:\\Downloads\\paper.pdf',mime:'application/pdf',url:'https://example.com/paper.pdf?token=secret',finalUrl:'https://example.com/paper.pdf?token=secret'}]:[];
 await e.connect();
 await e.scope.action({command:'download',args:['https://example.com/paper.pdf']});
 const status=JSON.parse(await e.scope.action({command:'download-status',args:['7']}));
 assert.equal(status.state,'complete');
 assert.equal(status.filename,'C:\\Downloads\\paper.pdf');
 assert.equal(status.mime,'application/pdf');
 assert.equal(Object.hasOwn(status,'url'),false);
 assert.equal(JSON.stringify(status).includes('secret'),false);
});
test('download-status refuses an untracked ID and flags HTML responses',async()=>{
 const e=await environment();
 await assert.rejects(e.scope.action({command:'download-status',args:['99']}),/Unknown download ID/);
 e.scope.chrome.downloads.download=async()=>8;
 e.scope.chrome.downloads.search=async({id})=>id===8?[{state:'complete',paused:false,bytesReceived:1,totalBytes:1,filename:'C:\\Downloads\\challenge.html',mime:'text/html',url:'https://example.com/x'}]:[];
 await e.connect();
 await e.scope.action({command:'download',args:['https://example.com/paper.pdf']});
 const status=JSON.parse(await e.scope.action({command:'download-status',args:['8']}));
 assert.match(status.warning,/HTML/);
});
test('download-status reports interrupted downloads',async()=>{
 const e=await environment();
 e.scope.chrome.downloads.download=async()=>9;
 e.scope.chrome.downloads.search=async({id})=>id===9?[{state:'interrupted',paused:false,bytesReceived:5,totalBytes:100,filename:'',mime:'',error:'NETWORK_FAILED'}]:[];
 await e.connect();
 await e.scope.action({command:'download',args:['https://example.com/paper.pdf']});
 const status=JSON.parse(await e.scope.action({command:'download-status',args:['9']}));
 assert.equal(status.state,'interrupted');
 assert.equal(status.error,'NETWORK_FAILED');
});
test('ping answers without a connected tab',async()=>{
 const e=await environment();
 assert.equal(await e.scope.action({command:'ping'}),'pong');
});
test('announces its identity after the bridge connects',async()=>{
 const e=await environment();
 await new Promise(resolve=>setImmediate(resolve));
 const hello=e.posted().find(m=>m.type==='hello');
 assert.ok(hello,'hello was not sent');
 assert.equal(hello.extensionVersion,'0.6.0');
 assert.equal(hello.userAgent,'test-agent');
 assert.equal(hello.instanceId,e.saved.instanceId);
});
test('reuses the stored identity after reconnecting',async()=>{
 const e=await environment();
 await new Promise(resolve=>setImmediate(resolve));
 const first=e.posted().find(m=>m.type==='hello').instanceId;
 await e.disconnect();
 await e.connect();
 const hellos=e.posted().filter(m=>m.type==='hello');
 assert.equal(hellos.at(-1).instanceId,first);
});

test('service worker restart preserves a connected tab',async()=>{
 const e=await environment();
 assert.equal((await e.connect()).ok,true);
 await e.scope.action({command:'snapshot',tabId:1});
 await e.restart();
 await e.scope.action({command:'snapshot',tabId:1});
 assert.equal(JSON.parse(await e.scope.action({command:'status'})).tabId,1);
 await assert.rejects(e.scope.action({command:'snapshot',tabId:2}),/click Connect/i);
});
test('window listing reports names, bounds, and claims',async()=>{
 const e=await environment();
 e.sessionSaved.windowRegistry={1:{windowId:1,name:'desktop',purpose:'desktop testing',ownerSession:'agent-aaaa',claimedAt:Date.now(),leaseUntil:Date.now()+60000,leaseMs:60000,createdByTool:true,createdAt:Date.now()}};
 await e.restart();
 const result=JSON.parse(await e.scope.action({command:'windows',args:[],sessionId:'agent-aaaa'}));
 assert.equal(result.windows.length,1);
 const w=result.windows[0];
 assert.equal(w.windowId,1);
 assert.equal(w.name,'desktop');
 assert.deepEqual(w.bounds,{left:0,top:0,width:1200,height:800});
 assert.equal(w.claimedByYou,true);
 assert.equal(w.claimedByOther,false);
 assert.equal(w.tabCount,2);
 assert.equal(w.connectedTabCount,0);
});
test('opening a window creates it with bounds, a name, and a claim',async()=>{
 const e=await environment();
 await e.connect();
 const result=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/mobile',width:390,height:844,name:'mobile-390',purpose:'mobile viewport',claim:true})],sessionId:'agent-a'}));
 assert.equal(result.reused,false);
 assert.equal(result.name,'mobile-390');
 const win=e.windows.get(result.windowId);
 assert.equal(win.width,390);
 assert.equal(win.height,844);
 assert.equal(win.focused,false);
 assert.equal(e.pages.get(Number(result.tabId)).windowId,result.windowId);
 const entry=e.sessionSaved.windowRegistry[result.windowId];
 assert.equal(entry.name,'mobile-390');
 assert.equal(entry.ownerSession,'agent-a');
});
test('window creation refuses duplicate and conflicting names',async()=>{
 const e=await environment();
 await e.connect();
 const first=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'Mobile-390',claim:true})],sessionId:'agent-a'}));
 await assert.rejects(e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/b',name:' mobile-390 '})],sessionId:'agent-a'}),/already/i);
 const reused=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/c',name:'mobile-390',reuseExisting:true})],sessionId:'agent-a'}));
 assert.equal(reused.reused,true);
 assert.equal(reused.windowId,first.windowId);
 await assert.rejects(e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/d',name:'mobile-390',reuseExisting:true})],sessionId:'agent-b'}),/claimed/i);
});
test('concurrent window creation keeps both registry entries',async()=>{
 const e=await environment();
 await e.connect();
 await Promise.all([
  e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/1',name:'one'})],sessionId:'agent-a'}),
  e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/2',name:'two'})],sessionId:'agent-b'})
 ]);
 const names=Object.values(e.sessionSaved.windowRegistry).map(x=>x.name).sort();
 assert.deepEqual(names,['one','two']);
});
test('updating a window resizes and renames only the target',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'desktop'})],sessionId:'agent-a'}));
 const other=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/b',name:'other'})],sessionId:'agent-a'}));
 await e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:800,height:600,name:'desktop-main'})],sessionId:'agent-a'});
 assert.equal(e.windows.get(opened.windowId).width,800);
 assert.equal(e.windows.get(other.windowId).width,1200);
 assert.equal(e.sessionSaved.windowRegistry[opened.windowId].name,'desktop-main');
});
test('window updates reject duplicates, empty changes, and unknown windows',async()=>{
 const e=await environment();
 await e.connect();
 const a=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'a'})],sessionId:'agent-a'}));
 await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/b',name:'b'})],sessionId:'agent-a'});
 await assert.rejects(e.scope.action({command:'update-window',args:[String(a.windowId),JSON.stringify({name:'b'})],sessionId:'agent-a'}),/already/i);
 await assert.rejects(e.scope.action({command:'update-window',args:[String(a.windowId),'{}'],sessionId:'agent-a'}),/change/i);
 await assert.rejects(e.scope.action({command:'update-window',args:['999',JSON.stringify({width:800,height:600})],sessionId:'agent-a'}),/Unknown window/i);
});
test('closing windows refuses untracked and last windows',async()=>{
 const e=await environment();
 await e.connect();
 await assert.rejects(e.scope.action({command:'close-window',args:['1',''],sessionId:'agent-a'}),/created by browser_open_window/i);
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a'})],sessionId:'agent-a'}));
 e.windows.delete(1);
 await assert.rejects(e.scope.action({command:'close-window',args:[String(opened.windowId),''],sessionId:'agent-a'}),/only Chrome window/i);
});
test('closing a tracked window removes it and its registry entry',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'task'})],sessionId:'agent-a'}));
 const result=JSON.parse(await e.scope.action({command:'close-window',args:[String(opened.windowId),''],sessionId:'agent-a'}));
 assert.equal(result.closed,true);
 assert.equal(e.windows.has(opened.windowId),false);
 assert.equal(e.sessionSaved.windowRegistry[opened.windowId],undefined);
});
test('a claim blocks window-scoped updates from another session',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'mobile',claim:true})],sessionId:'agent-a'}));
 await assert.rejects(e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:500,height:800})],sessionId:'agent-b'}),/claimed by another agent/i);
 await e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:500,height:800,force:true})],sessionId:'agent-b'});
 assert.equal(e.windows.get(opened.windowId).width,500);
});
test('page reads still work in a claimed window',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'mobile',claim:true})],sessionId:'agent-a'}));
 await e.scope.action({command:'snapshot',tabId:Number(opened.tabId),sessionId:'agent-b'});
 assert.ok(e.calls.includes('Accessibility.getFullAXTree'));
});
test('an expired lease no longer blocks another session',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'mobile',claim:true})],sessionId:'agent-a'}));
 e.sessionSaved.windowRegistry[opened.windowId].leaseUntil=Date.now()-1;
 await e.restart();
 await e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:500,height:800})],sessionId:'agent-b'});
 assert.equal(e.windows.get(opened.windowId).width,500);
});
test('releasing a claim allows another session to update',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'mobile',claim:true})],sessionId:'agent-a'}));
 await e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({claim:false})],sessionId:'agent-a'});
 await e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:500,height:800})],sessionId:'agent-b'});
 assert.equal(e.windows.get(opened.windowId).width,500);
});
test('an owner mutation renews the lease',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'mobile',claim:true})],sessionId:'agent-a'}));
 const before=Date.now();
 e.sessionSaved.windowRegistry[opened.windowId].leaseUntil=before+5000;
 await e.restart();
 await e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:500,height:800})],sessionId:'agent-a'});
 assert.ok(e.sessionSaved.windowRegistry[opened.windowId].leaseUntil>before+10000);
});
test('open-tab targets an explicit window and resolves the connected tab window',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/window',name:'target'})],sessionId:'agent-a'}));
 const explicit=JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/explicit','','',String(opened.windowId)],sessionId:'agent-a'}));
 assert.equal(e.pages.get(Number(explicit.targetId)).windowId,opened.windowId);
 e.scope.chrome.tabs.update=async()=>{};
 await e.scope.action({command:'select-tab',tabId:2,sessionId:'agent-a'});
 const implicit=JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/implicit','',''],sessionId:'agent-a'}));
 assert.equal(e.pages.get(Number(implicit.targetId)).windowId,1);
});
test('resize by windowId changes only that window',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a'})],sessionId:'agent-a'}));
 await e.scope.action({command:'resize',args:['500','800',String(opened.windowId)],sessionId:'agent-a'});
 assert.equal(e.windows.get(opened.windowId).width,500);
 assert.equal(e.windows.get(1).width,1200);
});
test('move-tab moves to a destination window and tabs filter by window',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a'})],sessionId:'agent-a'}));
 await e.scope.action({command:'move-tab',args:['0',String(opened.windowId)],sessionId:'agent-a',tabId:2});
 assert.equal(e.pages.get(2).windowId,opened.windowId);
 const filtered=JSON.parse(await e.scope.action({command:'tabs',args:[String(opened.windowId)],sessionId:'agent-a'}));
 assert.ok(filtered.every(t=>t.windowId===opened.windowId));
});
test('implicit window targets are blocked by another session claim',async()=>{
 const e=await environment();
 await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'locked',claim:true})],sessionId:'agent-a'}));
 e.scope.chrome.tabs.update=async()=>{};
 await e.scope.action({command:'select-tab',tabId:Number(opened.tabId),sessionId:'agent-b'});
 await assert.rejects(e.scope.action({command:'open-tab',args:['https://example.com/b','',''],sessionId:'agent-b'}),/claimed by another agent/i);
 await assert.rejects(e.scope.action({command:'resize',args:['500','800'],sessionId:'agent-b'}),/claimed by another agent/i);
});
test('device emulation applies exact CDP metrics',async()=>{
 const recorded=(calls,method)=>JSON.parse(JSON.stringify(calls.find(item=>item.method===method)?.params??null));
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 const result=JSON.parse(await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,deviceScaleFactor:3,mobile:true,touch:true,userAgent:'MobileUA',orientation:'portraitPrimary'})],tabId:1,sessionId:'agent-a'}));
 assert.equal(result.applied,true);assert.equal(result.width,390);assert.equal(result.height,844);
 assert.deepEqual(recorded(calls,'Emulation.setDeviceMetricsOverride'),{width:390,height:844,deviceScaleFactor:3,mobile:true,screenOrientation:{type:'portraitPrimary',angle:0}});
 assert.deepEqual(recorded(calls,'Emulation.setTouchEmulationEnabled'),{enabled:true,maxTouchPoints:5});
 assert.deepEqual(recorded(calls,'Emulation.setEmitTouchEventsForMouse'),{enabled:true,configuration:'mobile'});
 assert.deepEqual(recorded(calls,'Emulation.setUserAgentOverride'),{userAgent:'MobileUA'});
});
test('device emulation defaults to desktop without touch',async()=>{
 const recorded=(calls,method)=>JSON.parse(JSON.stringify(calls.find(item=>item.method===method)?.params??null));
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:1440,height:1000})],tabId:1,sessionId:'agent-a'});
 assert.deepEqual(recorded(calls,'Emulation.setDeviceMetricsOverride'),{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 assert.deepEqual(recorded(calls,'Emulation.setTouchEmulationEnabled'),{enabled:false});
 assert.deepEqual(recorded(calls,'Emulation.setEmitTouchEventsForMouse'),{enabled:false});
});
test('device emulation clears and restores the original UA',async()=>{
 const recorded=(calls,method)=>JSON.parse(JSON.stringify(calls.find(item=>item.method===method)?.params??null));
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,userAgent:'MobileUA'})],tabId:1,sessionId:'agent-a'});
 calls.length=0;
 const result=JSON.parse(await e.scope.action({command:'clear-emulation',args:[],tabId:1,sessionId:'agent-a'}));
 assert.equal(result.cleared,true);
 assert.ok(calls.some(c=>c.method==='Emulation.clearDeviceMetricsOverride'));
 assert.deepEqual(recorded(calls,'Emulation.setUserAgentOverride'),{userAgent:'test-agent'});
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('re-emulation without a userAgent removes the override',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,userAgent:'MobileUA'})],tabId:1,sessionId:'agent-a'});
 calls.length=0;
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:1440,height:1000})],tabId:1,sessionId:'agent-a'});
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].params)),{userAgent:'test-agent'});
 assert.equal(calls.some(c=>c.method==='Emulation.setUserAgentOverride'&&c.params.userAgent==='MobileUA'),false);
 assert.equal(e.sessionSaved.emulations[1].userAgent,null);
});
test('device emulation rejects invalid metrics before CDP',async()=>{
 const e=await environment();await e.connect();
 const calls=[];e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return{}};
 for(const options of [{},{width:99,height:844},{width:390,height:844,deviceScaleFactor:5},{width:390,height:844,orientation:'sideways'},{width:390,height:844,userAgent:'bad\u0001ua'}]){
  await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify(options)],tabId:1,sessionId:'agent-a'}),/Invalid/);
 }
 assert.equal(calls.length,0);
});
test('a window claim blocks emulation from another session',async()=>{
 const e=await environment();await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'locked',claim:true})],sessionId:'agent-a'}));
 const tabId=Number(opened.tabId);
 await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId,sessionId:'agent-b'}),/claimed by another agent/i);
 await assert.rejects(e.scope.action({command:'clear-emulation',args:[],tabId,sessionId:'agent-b'}),/claimed by another agent/i);
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId,sessionId:'agent-a'});
 await e.scope.action({command:'clear-emulation',args:[],tabId,sessionId:'agent-a'});
});
test('tab listing reports requested and active emulation',async()=>{
 const e=await environment();await e.connect();
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,deviceScaleFactor:3,mobile:true,touch:true,orientation:'portraitPrimary'})],tabId:1,sessionId:'agent-a'});
 const tabs=JSON.parse(await e.scope.action({command:'tabs'}));
 const tab=tabs.find(t=>t.tabId==='1');
 assert.deepEqual(tab.emulation,{width:390,height:844,deviceScaleFactor:3,mobile:true,touch:true,userAgent:null,orientation:'portraitPrimary'});
 assert.equal(tab.emulationActive,true);
 const other=tabs.find(t=>t.tabId==='2');
 assert.equal(other.emulation,null);assert.equal(other.emulationActive,false);
});
test('a CDP apply failure leaves no emulation state',async()=>{
 const e=await environment();await e.connect();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')throw Error('CDP failed');return{}};
 await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'}),/Could not apply device emulation/i);
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('service worker restart reapplies stored emulation',async()=>{
 const e=await environment();await e.connect();
 const calls=[];
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{calls.push({target,method,params});return method==='Accessibility.getFullAXTree'?{nodes:[]}:{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,deviceScaleFactor:2,mobile:true})],tabId:1,sessionId:'agent-a'});
 calls.length=0;
 await e.restart();
 const before=JSON.parse(await e.scope.action({command:'tabs'}));
 const beforeTab=before.find(t=>t.tabId==='1');
 assert.equal(beforeTab.emulation.width,390);
 assert.equal(beforeTab.emulationActive,false);
 calls.length=0;
 await e.scope.action({command:'snapshot',tabId:1,sessionId:'agent-a'});
 assert.ok(calls.some(c=>c.method==='Emulation.setDeviceMetricsOverride'&&c.params.width===390));
 const tabs=JSON.parse(await e.scope.action({command:'tabs'}));
 assert.equal(tabs.find(t=>t.tabId==='1').emulationActive,true);
});
test('a failed reapply fails the page action and keeps the state',async()=>{
 const e=await environment();await e.connect();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')return{};return method==='Accessibility.getFullAXTree'?{nodes:[]}:{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 await e.restart();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')throw Error('reapply failed');return{}};
 await assert.rejects(e.scope.action({command:'snapshot',tabId:1,sessionId:'agent-a'}),/Could not reapply device emulation/i);
 assert.ok(e.sessionSaved.emulations[1]);
});
test('clear still works after a failed reapply',async()=>{
 const e=await environment();await e.connect();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')return{};return method==='Accessibility.getFullAXTree'?{nodes:[]}:{}};
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 await e.restart();
 e.scope.chrome.debugger.sendCommand=async(target,method)=>{if(method==='Emulation.setDeviceMetricsOverride')throw Error('reapply failed');return{}};
 await assert.rejects(e.scope.action({command:'snapshot',tabId:1,sessionId:'agent-a'}),/Could not reapply device emulation/i);
 e.scope.chrome.debugger.sendCommand=async()=>({});
 const result=JSON.parse(await e.scope.action({command:'clear-emulation',args:[],tabId:1,sessionId:'agent-a'}));
 assert.equal(result.cleared,true);
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('closing a tab clears its stored emulation',async()=>{
 const e=await environment();await e.connect();
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 assert.ok(e.sessionSaved.emulations[1]);
 e.lifecycle.tabRemoved(1);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('disconnect clears stored emulation',async()=>{
 const e=await environment();await e.connect();
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844})],tabId:1,sessionId:'agent-a'});
 await e.disconnect();
 assert.equal(e.sessionSaved.emulations,undefined);
});
test('a tab closed during startup does not leave stored emulation',async()=>{
 const e=await environment({delayEmulationsGet:true});
 e.sessionSaved.emulations={1:{width:390,height:844,deviceScaleFactor:1,mobile:false,touch:false,userAgent:null,orientation:null,originalUserAgent:'test-agent'}};
 await e.restart();
 e.lifecycle.tabRemoved(1);
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('disconnect during startup does not resurrect emulation',async()=>{
 const e=await environment({delayEmulationsGet:true});
 e.sessionSaved.emulations={1:{width:390,height:844,deviceScaleFactor:1,mobile:false,touch:false,userAgent:null,orientation:null,originalUserAgent:'test-agent'}};
 await e.restart();
 await e.disconnect();
 await new Promise(resolve=>setTimeout(resolve,80));
 await e.connect();
 const tabs=JSON.parse(await e.scope.action({command:'tabs'}));
 assert.equal(tabs.find(t=>t.tabId==='1').emulation,null);
});
test('a failed UA restore still clears the previous override',async()=>{
 const e=await environment();await e.connect();
 const successful=[];let uaCalls=0;
 e.scope.chrome.debugger.sendCommand=async(target,method,params)=>{
  if(method==='Emulation.setUserAgentOverride'){uaCalls++;if(uaCalls===2)throw Error('restore failed');successful.push(params.userAgent)}
  return {};
 };
 await e.scope.action({command:'emulate-device',args:[JSON.stringify({width:390,height:844,userAgent:'MobileUA'})],tabId:1,sessionId:'agent-a'});
 await assert.rejects(e.scope.action({command:'emulate-device',args:[JSON.stringify({width:1440,height:1000})],tabId:1,sessionId:'agent-a'}),/Could not apply device emulation/i);
 assert.ok(successful.includes('test-agent'));
 assert.equal(e.sessionSaved.emulations[1],undefined);
});
test('a delayed registry load cannot bypass a claim',async()=>{
 const e=await environment({delayRegistryGet:true});
 e.sessionSaved.windowRegistry={1:{windowId:1,name:'locked',purpose:null,ownerSession:'agent-a',claimedAt:Date.now(),leaseUntil:Date.now()+60000,leaseMs:60000,createdByTool:true,createdAt:Date.now()}};
 await e.restart();
 await assert.rejects(e.scope.action({command:'open-tab',args:['https://example.com/x','','','1'],sessionId:'agent-b'}),/claimed by another agent/i);
});
test('open-tab falls back when the connected tab is gone',async()=>{
 const e=await environment();await e.connect();
 const first=JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/a','',''],sessionId:'agent-a'}));
 e.pages.delete(Number(first.targetId));
 const second=JSON.parse(await e.scope.action({command:'open-tab',args:['https://example.com/b','',''],sessionId:'agent-a'}));
 assert.equal(e.pages.get(Number(second.targetId)).windowId,1);
});
test('an empty session id is treated as local',async()=>{
 const e=await environment();await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a',name:'local-window',claim:true})],sessionId:''}));
 assert.equal(e.sessionSaved.windowRegistry[opened.windowId].ownerSession,'local');
 await assert.rejects(e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:500,height:800})],sessionId:'agent-b'}),/claimed by another agent/i);
});
test('a rejected claim leaves the window unchanged',async()=>{
 const e=await environment();await e.connect();
 const opened=JSON.parse(await e.scope.action({command:'open-window',args:[JSON.stringify({url:'https://example.com/a'})],sessionId:'agent-a'}));
 await assert.rejects(e.scope.action({command:'update-window',args:[String(opened.windowId),JSON.stringify({width:640,height:480,claim:true})],sessionId:'agent-a'}),/requires a name/i);
 assert.equal(e.windows.get(opened.windowId).width,1200);
 assert.equal(e.sessionSaved.windowRegistry[opened.windowId].ownerSession,null);
});
