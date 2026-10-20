const status=document.getElementById('status');
async function send(type){try{const r=await chrome.runtime.sendMessage({type});if(!r.ok){status.textContent=r.error||'Connection failed.';return}status.textContent=(type==='connect'||r.connected)?'Connected. Ask Codex to open a website.':r.error|| (r.autoConnect?'Connecting automatically…':'Paused. Click Resume to reconnect.');}catch(e){status.textContent=e.message}}
document.getElementById('connect').onclick=()=>send('connect');document.getElementById('disconnect').onclick=()=>send('disconnect');send('status');
