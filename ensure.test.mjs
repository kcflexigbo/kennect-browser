import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {normalizeDirectory,buildLaunchArgs,findChromeExecutable,ensureChildTimeout,ensureBrowser} from './ensure.mjs';
test('normalizes profile directories per platform',()=>{
 assert.equal(normalizeDirectory(' Profile 1 ','win32'),'profile 1');
 assert.equal(normalizeDirectory('C:\\Data\\Profile 1','win32'),'c:/data/profile 1');
 assert.equal(normalizeDirectory('Profile 1','linux'),'Profile 1');
});
test('builds the launch arguments',()=>{
 assert.deepEqual(buildLaunchArgs({userDataDir:'C:\\UD',profileDirectory:'Default'}),['--user-data-dir=C:\\UD','--profile-directory=Default','--new-window','--no-first-run','--no-default-browser-check','about:blank']);
});
test('finds Chrome in the platform candidates',async()=>{
 const win=await findChromeExecutable({platform:'win32',home:'C:\\Users\\X',env:{LOCALAPPDATA:'C:\\Local',ProgramFiles:'C:\\PF'},exists:async p=>p==='C:\\PF\\Google\\Chrome\\Application\\chrome.exe'});
 assert.equal(win.path,'C:\\PF\\Google\\Chrome\\Application\\chrome.exe');
 assert.ok(win.candidates.includes('C:\\Local\\Google\\Chrome\\Application\\chrome.exe'));
 const mac=await findChromeExecutable({platform:'darwin',home:'/Users/x',env:{},exists:async p=>p==='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 assert.equal(mac.path,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 const none=await findChromeExecutable({platform:'linux',home:'/home/x',env:{},exists:async()=>false});
 assert.equal(none.path,null);
 assert.ok(none.candidates.includes('/usr/bin/google-chrome'));
});
test('computes a child timeout above the ensure wait',()=>{
 assert.equal(ensureChildTimeout(30000),35000);
 assert.equal(ensureChildTimeout(60000),65000);
 assert.equal(ensureChildTimeout(),35000);
});
const profile=(over={})=>({profileId:'chrome:Default:aaaaaa',label:'Test',responsive:true,browser:'chrome',profileDirectory:'Default',extensionVersion:'0.5.0',instanceId:'x',startedAt:0,connectedTab:null,...over});
const listing=(profiles,def=null)=>({default:def,profiles});
const scan=(over={})=>({userDataDir:'C:\\UD',lastUsed:'Default',lastActive:[],profiles:[{directory:'Default',name:'Test',activeTime:3,extensionEnabled:true,extensionPath:'C:\\ext'}],...over});
function child(){const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('spawn'));return c}
function clock(){let t=0;return{now:()=>t,sleep:async ms=>{t+=ms}}}
test('ensure reuses a responsive profile without launching',async()=>{
 let spawned=0;
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([profile()],'chrome:Default:aaaaaa'),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.launched,false);assert.equal(result.profileId,'chrome:Default:aaaaaa');assert.equal(spawned,0);
});
test('ensure reuses a requested profile when it is already responsive',async()=>{
 let spawned=0;
 const target=profile({profileId:'chrome:Profile 7:cccccc',profileDirectory:'Profile 7',label:'Work'});
 const result=await ensureBrowser({profileDirectory:'Profile 7',listProfilesImpl:async()=>listing([target]),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.launched,false);assert.equal(result.profileId,'chrome:Profile 7:cccccc');assert.equal(spawned,0);
});
test('ensure launches the selected profile and waits for a new connection',async()=>{
 const calls=[],options=[];let n=0;const list=async opts=>{n++;options.push(opts);return n===1?listing([]):listing([profile()])};
 const result=await ensureBrowser({listProfilesImpl:list,profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:(path,args)=>{calls.push({path,args});return child()},serverVersion:'0.5.0',...clock()});
 assert.equal(result.launched,true);assert.equal(result.profileId,'chrome:Default:aaaaaa');
 assert.equal(calls.length,1);assert.equal(calls[0].path,'C:/chrome.exe');assert.deepEqual(calls[0].args,buildLaunchArgs({userDataDir:'C:\\UD',profileDirectory:'Default'}));
 assert.ok(options.length>=2);assert.ok(options.every(item=>item?.probeTimeoutMs===1000));
});
test('ensure fails before launching when no profile has the extension',async()=>{
 let spawned=0;
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[{directory:'Default',extensionEnabled:false}]}),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0'}),/No Chrome profile|extension enabled/i);
 assert.equal(spawned,0);
});
test('ensure rejects a requested profile without the extension',async()=>{
 await assert.rejects(ensureBrowser({profileDirectory:'Default',listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[{directory:'Default',extensionEnabled:false}]}),serverVersion:'0.5.0'}),/does not have the Kennect Browser extension enabled[\s\S]*Checked profiles: Default[\s\S]*chrome:\/\/extensions[\s\S]*user-data-dir/i);
});
test('a missing requested profile reports checked profiles and extension guidance',async()=>{
 await assert.rejects(ensureBrowser({profileDirectory:'Missing',listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[{directory:'Default',extensionEnabled:true}]}),serverVersion:'0.5.0'}),/was not found[\s\S]*Checked profiles: Default[\s\S]*chrome:\/\/extensions[\s\S]*user-data-dir/i);
});
test('ensure reports a missing Chrome executable with the attempted paths',async()=>{
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:null,candidates:['C:/a/chrome.exe','C:/b/chrome.exe']}),serverVersion:'0.5.0'}),/Checked: C:\/a\/chrome\.exe, C:\/b\/chrome\.exe/);
});
test('the no-extension error names the unsupported custom store',async()=>{
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan({profiles:[]}),serverVersion:'0.5.0'}),/user-data-dir|Beta|Canary|SxS/i);
});
test('ensure times out with a clear connection message',async()=>{
 let spawned=0;
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:()=>{spawned++;return child()},serverVersion:'0.5.0',...clock()}),/did not connect within 30 seconds/i);
 assert.equal(spawned,1);
});
test('ensure surfaces a spawn error',async()=>{
 const bad=()=>{const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('error',new Error('ENOENT: chrome')));return c};
 await assert.rejects(ensureBrowser({listProfilesImpl:async()=>listing([]),profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:bad,serverVersion:'0.5.0'}),/ENOENT/);
});
test('ensure warns on a version mismatch',async()=>{
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([profile({extensionVersion:'0.4.0'})]),serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.match(result.warning,/0\.4\.0.*0\.5\.0|does not match/);
});
test('a pre-existing unrelated responsive profile never satisfies the launch poll',async()=>{
 const other=profile({profileId:'chrome:Other:bbbbbb',profileDirectory:'Other'});
 const target=profile({profileId:'chrome:Profile 7:cccccc',profileDirectory:'Profile 7',label:'Work'});
 let n=0;const list=async()=>{n++;return n===1?listing([other]):listing([other,target])};
 const result=await ensureBrowser({profileDirectory:'Profile 7',listProfilesImpl:list,profileScanImpl:async()=>scan({profiles:[{directory:'Profile 7',name:'Work',extensionEnabled:true}]}),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:()=>child(),serverVersion:'0.5.0',...clock()});
 assert.equal(result.profileId,'chrome:Profile 7:cccccc');
});
test('a new profile id without a directory is accepted with an identity warning',async()=>{
 const target=profile({profileId:'chrome:unknown:dddddd',profileDirectory:null,label:null});
 let n=0;const list=async()=>{n++;return n===1?listing([]):listing([target])};
 const result=await ensureBrowser({listProfilesImpl:list,profileScanImpl:async()=>scan(),chromeExecutableImpl:async()=>({path:'C:/chrome.exe',candidates:['C:/chrome.exe']}),spawnImpl:()=>child(),serverVersion:'0.5.0',...clock()});
 assert.equal(result.profileId,'chrome:unknown:dddddd');assert.match(result.warning,/identity/i);
});
test('reuse chooses the persisted default when several profiles are responsive',async()=>{
 const a=profile({profileId:'chrome:A:aaaaaa'}),b=profile({profileId:'chrome:B:bbbbbb',profileDirectory:'B'});
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([a,b],'chrome:B:bbbbbb'),serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.profileId,'chrome:B:bbbbbb');
});
test('reuse returns a responsive Edge profile without launching Chrome',async()=>{
 const edge=profile({profileId:'edge:Default:eeeeee',browser:'edge',label:'Edge'});
 const result=await ensureBrowser({listProfilesImpl:async()=>listing([edge]),serverVersion:'0.5.0',sleep:async()=>{},now:()=>0});
 assert.equal(result.browser,'edge');assert.equal(result.launched,false);
});
