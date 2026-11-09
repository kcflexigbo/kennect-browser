import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
async function environment(){
 const pages=new Map([[1,{id:1,url:'https://www.zhipin.com/',title:'BOSS',windowId:1}],[2,{id:2,url:'https://example.com/',title:'Example',windowId:1}]]);let popup;const calls=[];const lifecycle={};const saved={};const sessionSaved={};const attachedTabs=new Set();const posted=[];const downloadCalls=[];let nativeConnections=0;
 const event=()=>({addListener(){}});const chrome={tabs:{get:async id=>pages.get(id),query:async options=>options.active?[pages.get(1)]:options.groupId!==undefined?[...pages.values()].filter(t=>t.groupId===options.groupId):[...pages.values()]},debugger:{attach:async({tabId})=>{if(attachedTabs.has(tabId))throw Error('Another debugger is already attached to the tab.');attachedTabs.add(tabId)},detach:async({tabId})=>{attachedTabs.delete(tabId)},onDetach:event(),onEvent:event(),sendCommand:async(target,method)=>{calls.push(method);if(method==='Runtime.enable')throw Error('Continuous console collection must not be enabled');return method==='Accessibility.getFullAXTree'?{nodes:[]}:{};}},runtime:{id:'test',getManifest:()=>({version:'0.3.1'}),onStartup:{addListener(fn){lifecycle.startup=fn}},onInstalled:{addListener(fn){lifecycle.installed=fn}},onMessage:{addListener(fn){popup=fn}},connectNative:()=>{nativeConnections++;return({onMessage:{addListener(fn){queueMicrotask(()=>fn({type:'ready'}))}},onDisconnect:event(),postMessage(message){posted.push(message)},disconnect(){}})}},storage:{local:{get:async()=>saved,set:async value=>Object.assign(saved,value)},session:{get:async keys=>{if(keys==null)return{...sessionSaved};if(Array.isArray(keys))return Object.fromEntries(keys.filter(k=>k in sessionSaved).map(k=>[k,sessionSaved[k]]));if(typeof keys==='string')return keys in sessionSaved?{[keys]:sessionSaved[keys]}:{};return{}},set:async value=>Object.assign(sessionSaved,value),remove:async keys=>{for(const key of [].concat(keys??[]))delete sessionSaved[key]}}},tabGroups:{query:async()=>[],update:async()=>{}},downloads:{download:async options=>{downloadCalls.push(options);return 42},search:async()=>[]}};
 let scope;const load=async()=>{scope=vm.createContext({chrome,URL,Map,Set,Error,Number,JSON,Object,setTimeout,clearTimeout,crypto,navigator:{userAgent:'test-agent'}});vm.runInContext(await readFile(new URL('./extension/worker.js',import.meta.url),'utf8'),scope);await new Promise(resolve=>setImmediate(resolve))};await load();
 const connect=()=>new Promise(resolve=>popup({type:'connect'},{id:'test'},resolve));
 return{pages,calls,lifecycle,saved,sessionSaved,get scope(){return scope},connect,restart:load,posted:()=>posted,downloadCalls,nativeConnections:()=>nativeConnections,disconnect:()=>new Promise(resolve=>popup({type:'disconnect'},{id:'test'},resolve))};
}
test('extension requires a user connection before reading a tab',async()=>{const e=await environment();await assert.rejects(e.scope.action({command:'snapshot',tabId:1}),/click Connect/i);assert.equal((await e.connect()).ok,true);await e.scope.action({command:'snapshot',tabId:1});assert.ok(e.calls.includes('Accessibility.getFullAXTree'));});
test('navigation to another origin requires a fresh user connection',async()=>{const e=await environment();await e.connect();e.pages.get(1).url='https://example.com/';await assert.rejects(e.scope.action({command:'snapshot',tabId:1}),/click Connect/i);});
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
 assert.equal(hello.extensionVersion,'0.3.1');
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
