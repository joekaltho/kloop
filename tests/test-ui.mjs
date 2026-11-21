import { JSDOM } from 'jsdom'; import fs from 'fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
let fail=0;
async function run(name,endpoint,fetchImpl,emailVal,expect,keyboard=false){
  const dom=new JSDOM(html.replace(/var ENDPOINT="[^"]*";/,'var ENDPOINT="'+endpoint+'";'),{runScripts:'dangerously',beforeParse(w){w.fetch=fetchImpl}});
  const d=dom.window.document,e=d.getElementById('email');e.value=emailVal;
  if(keyboard)e.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter'}));else d.getElementById('join').click();
  await new Promise(r=>setTimeout(r,50));
  const msg=d.getElementById('status').textContent,btn=d.getElementById('join').disabled;
  const ok=expect.test(msg)&&!btn;console.log(ok?'PASS':'FAIL',name,'->',msg);if(!ok)fail++;
}
const res=(s)=>async()=>({ok:s>=200&&s<300,status:s,json:async()=>({})});
await run('success','https://x/f',res(200),'a@b.co',/on the list/);
await run('success via Enter key','https://x/f',res(200),'a@b.co',/on the list/,true);
await run('invalid client-side, no request','https://x/f',async()=>{throw new Error('should not call')},'nope',/valid email/);
await run('server 400','https://x/f',res(400),'a@b.co',/does not look valid/);
await run('server 429','https://x/f',res(429),'a@b.co',/Too many/);
await run('server 500 no false success','https://x/f',res(500),'a@b.co',/not saved/);
await run('network error no false success','https://x/f',async()=>{throw new Error('net')},'a@b.co',/not saved/);
await run('endpoint unset no false success','',res(200),'a@b.co',/not saved/);
process.exit(fail?1:0);
