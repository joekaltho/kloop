import { JSDOM } from 'jsdom'; import fs from 'fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
let fail=0;
// Only POSTs to the signup endpoint count as "requests"; the page also GETs reward cards on load.
async function run(name,endpoint,fetchImpl,emailVal,expect,keyboard=false,opts={}){
  const posts=[];
  const f=(u,o)=>{if(o&&o.method==='POST')posts.push({u,body:JSON.parse(o.body)});return fetchImpl(u,o)};
  const dom=new JSDOM(html.replace(/var ENDPOINT="[^"]*";/,'var ENDPOINT="'+endpoint+'";'),{url:opts.url||'https://kloop.test/',runScripts:'dangerously',beforeParse(w){w.fetch=f;if(opts.before)opts.before(w)}});
  const d=dom.window.document,e=d.getElementById('email');e.value=emailVal;
  if(keyboard)e.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter'}));else d.getElementById('join').click();
  await new Promise(r=>setTimeout(r,60));
  const msg=d.getElementById('status').textContent,btn=d.getElementById('join').disabled;
  const ok=expect.test(msg)&&!btn&&(!opts.check||opts.check(d,posts,dom.window));console.log(ok?'PASS':'FAIL',name,'->',msg);if(!ok)fail++;
}
const res=(s,body={})=>async(u,o)=>({ok:s>=200&&s<300,status:s,json:async()=>(o&&o.method==='POST'?body:{rewards:[]})});
await run('success','https://x/f',res(200),'a@b.co',/on the list/);
await run('success via Enter key','https://x/f',res(200),'a@b.co',/on the list/,true);
await run('invalid client-side, no request','https://x/f',async()=>{throw new Error('should not call')},'nope',/valid email/,false,{check:(d,posts)=>posts.length===0});
await run('server 400','https://x/f',res(400),'a@b.co',/does not look valid/);
await run('server 429','https://x/f',res(429),'a@b.co',/Too many/);
await run('server 500 no false success','https://x/f',res(500),'a@b.co',/not saved/);
await run('network error no false success','https://x/f',async(u,o)=>{if(o&&o.method==='POST')throw new Error('net');return {ok:true,json:async()=>({})}},'a@b.co',/not saved/);
await run('endpoint unset no false success','',res(200),'a@b.co',/not saved/);
// referral additions
await run('new signup shows the share panel with the right link','https://x/f',res(200,{ok:true,referral_code:'klp_abc234'}),'a@b.co',/on the list/,false,{check:(d)=>!d.getElementById('share').hidden&&d.getElementById('reflink').value==='https://kloop.test/?ref=klp_abc234'&&d.getElementById('wa').href.includes(encodeURIComponent('https://kloop.test/?ref=klp_abc234'))&&d.querySelector('.wl').style.display==='none'});
await run('duplicate shows no panel and keeps the form','https://x/f',res(200,{ok:true}),'a@b.co',/on the list/,false,{check:(d)=>d.getElementById('share').hidden&&d.querySelector('.wl').style.display!=='none'});
await run('?ref= is captured and sent with the signup','https://x/f',res(200,{ok:true}),'a@b.co',/on the list/,false,{url:'https://kloop.test/?ref=KLP_abc234',check:(d,posts)=>posts.length===1&&posts[0].body.ref==='klp_abc234'});
await run('malformed ?ref= is dropped','https://x/f',res(200,{ok:true}),'a@b.co',/on the list/,false,{url:'https://kloop.test/?ref=<script>',check:(d,posts)=>posts[0].body.ref===''});
await run('no ref -> empty ref','https://x/f',res(200,{ok:true}),'a@b.co',/on the list/,false,{check:(d,posts)=>posts[0].body.ref===''});
await run('stored ref survives a later visit without ?ref=','https://x/f',res(200,{ok:true}),'a@b.co',/on the list/,false,{before:(w)=>w.localStorage.setItem('kloop_ref',JSON.stringify({c:'klp_zzz234',t:Date.now()})),check:(d,posts)=>posts[0].body.ref==='klp_zzz234'});
await run('expired stored ref is ignored','https://x/f',res(200,{ok:true}),'a@b.co',/on the list/,false,{before:(w)=>w.localStorage.setItem('kloop_ref',JSON.stringify({c:'klp_zzz234',t:Date.now()-31*864e5})),check:(d,posts)=>posts[0].body.ref===''});
await run('ref is cleared after a successful new signup','https://x/f',res(200,{ok:true,referral_code:'klp_abc234'}),'a@b.co',/on the list/,false,{url:'https://kloop.test/?ref=klp_abc234',check:(d,posts,w)=>w.localStorage.getItem('kloop_ref')===null});
// reward cards come from the API (textContent, no HTML injection)
{
  const rewards=[{slug:'a',title:'<img src=x onerror=alert(1)>Founding',description:'d',kind:'rank',rank_limit:7,min_referrals:1},{slug:'b',title:'Early',description:'',kind:'threshold',rank_limit:null,min_referrals:3}];
  const dom=new JSDOM(html.replace(/var ENDPOINT="[^"]*";/,'var ENDPOINT="https://x/functions/v1/waitlist-signup";'),{url:'https://kloop.test/',runScripts:'dangerously',beforeParse(w){w.fetch=async(u)=>({ok:true,status:200,json:async()=>({rewards})});}});
  await new Promise(r=>setTimeout(r,60));
  const box=dom.window.document.getElementById('rewards');
  const ok=box.children.length===2&&/Top 7 of the leaderboard/.test(box.textContent)&&/3 successful referrals/.test(box.textContent)&&!box.querySelector('img');
  console.log(ok?'PASS':'FAIL','reward cards rendered safely from API');if(!ok)fail++;
}
{
  const dom=new JSDOM(html,{url:'https://kloop.test/',runScripts:'dangerously',beforeParse(w){w.fetch=async()=>{throw new Error('down')}}});
  await new Promise(r=>setTimeout(r,60));
  const ok=dom.window.document.getElementById('rewards').children.length===0&&dom.window.document.getElementById('competition').textContent.includes('Bring people in');
  console.log(ok?'PASS':'FAIL','reward fetch failure leaves the page intact');if(!ok)fail++;
}
process.exit(fail?1:0);
