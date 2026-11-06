const status=document.getElementById('status'),label=document.getElementById('label');
async function send(type){try{const r=await chrome.runtime.sendMessage({type});if(!r.ok){status.textContent=r.error||'Connection failed.';return}status.textContent=(type==='connect'||r.connected)?'Connected. Ask Codex to open a website.':r.error|| (r.autoConnect?'Connecting automatically…':'Paused. Click Resume to reconnect.');}catch(e){status.textContent=e.message}}
document.getElementById('connect').onclick=()=>send('connect');document.getElementById('disconnect').onclick=()=>send('disconnect');
chrome.storage.local.get('profileLabel').then(saved=>{label.value=typeof saved.profileLabel==='string'?saved.profileLabel:''}).catch(()=>{});
try{chrome.identity?.getProfileUserInfo?.({accountStatus:'ANY'}).then(info=>{if(info?.email)document.getElementById('autoHint').textContent='Leave empty to use '+info.email;},()=>{});}catch{}
document.getElementById('saveLabel').onclick=async()=>{const value=label.value.trim().slice(0,40);await chrome.storage.local.set({profileLabel:value});status.textContent=value?`Label saved: ${value}`:'Label cleared.';};
send('status');
