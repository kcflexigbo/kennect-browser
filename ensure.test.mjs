import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDirectory,buildLaunchArgs,findChromeExecutable,ensureChildTimeout} from './ensure.mjs';
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
