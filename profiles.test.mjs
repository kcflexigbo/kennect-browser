import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseBrowserCommandLine,browserProfileId,browserIdentityFromProcesses,selectProfile,readProfileConfig,writeDefaultProfile} from './profiles.mjs';

const first={profileId:'chrome:Default:aaaaaa',responsive:true};
const second={profileId:'chrome:Profile 1:bbbbbb',responsive:true};
const offline={profileId:'edge:Default:cccccc',responsive:false};

const windows={platform:'win32',home:'C:\\Users\\Example',env:{LOCALAPPDATA:'C:\\Users\\Example\\AppData\\Local'}};
test('parses a Chrome command line and derives a stable profile ID',()=>{
 const identity=parseBrowserCommandLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default --restart',windows);
 assert.equal(identity.browser,'chrome');
 assert.equal(identity.profileDirectory,'Default');
 assert.equal(identity.userDataDir,'C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\User Data');
 assert.match(browserProfileId(identity),/^chrome:Default:[a-f0-9]{6}$/);
});
test('reads an explicit user-data-dir and a quoted profile directory',()=>{
 const identity=parseBrowserCommandLine('"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir="C:\\Temp\\Edge Data" --profile-directory="Profile 1"');
 assert.equal(identity.browser,'edge');
 assert.equal(identity.userDataDir,'C:\\Temp\\Edge Data');
 assert.equal(identity.profileDirectory,'Profile 1');
});
test('finds the nearest browser process in a parent chain',()=>{
 const identity=browserIdentityFromProcesses([
  {pid:2,name:'cmd.exe',command:'"C:\\Windows\\System32\\cmd.exe" /d /s /c "native-host.cmd"'},
  {pid:3,name:'chrome.exe',command:'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory="Profile 1"'},
  {pid:4,name:'explorer.exe',command:'C:\\Windows\\explorer.exe'}
 ],windows);
 assert.equal(identity.browser,'chrome');
 assert.equal(identity.profileDirectory,'Profile 1');
});
test('ignores a parent chain with no browser process',()=>{
 assert.equal(browserIdentityFromProcesses([{pid:2,name:'node.exe',command:'"C:\\Program Files\\nodejs\\node.exe" server.mjs'}],windows),null);
});
test('profile IDs ignore path case and separator differences',()=>{
 const a=browserProfileId({browser:'chrome',userDataDir:'C:\\Users\\X\\User Data',profileDirectory:'Default'});
 const b=browserProfileId({browser:'chrome',userDataDir:'c:/users/x/user data',profileDirectory:'Default'});
 assert.equal(a,b);
});
test('explicit profile wins over the configured default',()=>{
 assert.equal(selectProfile([first,second],second.profileId,first.profileId),second);
});
test('the configured default is used when the call omits a profile',()=>{
 assert.equal(selectProfile([first,second],undefined,first.profileId),first);
});
test('fails with the profile list when neither an argument nor a default exists',()=>{
 assert.throws(()=>selectProfile([first,second],undefined,null),/No browser profile selected[\s\S]*chrome:Default:aaaaaa[\s\S]*chrome:Profile 1:bbbbbb/);
});
test('a single connected profile is selected automatically',()=>{
 assert.equal(selectProfile([first],undefined,null),first);
});
test('rejects a profile that is not connected',()=>{
 assert.throws(()=>selectProfile([first],'chrome:Nope:000000',null),/Unknown browser profile/);
});
test('rejects a configured profile that is not responding',()=>{
 assert.throws(()=>selectProfile([offline],offline.profileId,null),/not responding/);
});
test('default profile config round-trips and a missing config means no default',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kennect-profile-test-'));
 try{
  assert.equal(await readProfileConfig(directory),null);
  assert.equal(await writeDefaultProfile(directory,first.profileId),first.profileId);
  assert.equal(await readProfileConfig(directory),first.profileId);
  const saved=JSON.parse(await readFile(join(directory,'config.json'),'utf8'));
  assert.equal(saved.defaultProfile,first.profileId);
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('a corrupt default profile config is ignored',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kennect-profile-test-'));
 try{
  await writeFile(join(directory,'config.json'),'not json');
  assert.equal(await readProfileConfig(directory),null);
 }finally{await rm(directory,{recursive:true,force:true})}
});
