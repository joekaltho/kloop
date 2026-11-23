import { JSDOM } from 'jsdom'; import fs from 'fs';
const html=fs.readFileSync(new URL('../referral.html',import.meta.url),'utf8');
let fail=0; const check=(n,c,x='')=>{console.log(c?'PASS':'FAIL',n,c?'':x);if(!c)fail++};
const TOKEN='A'.repeat(22)+'.'+'B'.repeat(32);
const board={ok:true,total_ranked:2,entries:[{rank:1,handle:'AAAAAA',referrals:5},{rank:2,handle:'3F9A1C',referrals:2}],
 rewards:[{slug:'f',title:'Founding <b>spot</b>',description:'Top of the board',kind:'rank',rank_limit:1,min_referrals:1},{slug:'e',title:'Early access',description:'',kind:'threshold',rank_limit:null,min_referrals:3}]};
const mine={ok:true,verified_now:true,handle:'3F9A1C',referral_code:'klp_abc234',verified:true,verified_referrals:2,pending_referrals:1,rank:2,total_ranked:2,
 rewards:[{slug:'f',title:'Founding spot',description:'Top',kind:'rank',rank_limit:1,min_referrals:1,qualified:false,needed:4},{slug:'e',title:'Early access',description:'',kind:'threshold',rank_limit:null,min_referrals:3,qualified:false,needed:1}]};
async function load(hash,api){
  const calls=[];
  const dom=new JSDOM(html,{url:'https://kloop.test/referral.html'+hash,runScripts:'dangerously',beforeParse(w){
    w.fetch=async(u,o)=>{calls.push({u,o});const r=await api(u,o&&o.body?JSON.parse(o.body):null);return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.json}};
    w.navigator.clipboard={writeText:async(t)=>{w.__copied=t}};
  }});
  await new Promise(r=>setTimeout(r,80));
  return {w:dom.window,d:dom.window.document,calls};
}
const ok200=(j)=>({status:200,json:j});
const normal=async(u,b)=>u.includes('action=leaderboard')?ok200(board):b&&b.action==='me'?ok200(mine):b&&b.action==='request_link'?ok200({ok:true}):{status:404,json:{}};

// 1. dashboard with a valid token
let {d,w,calls}=await load('#t='+TOKEN,normal);
check('dashboard visible, request form hidden',!d.getElementById('dash').hidden&&d.getElementById('getlink').hidden&&d.getElementById('loading').hidden);
check('token sent in POST body (not in any URL)',calls.every(c=>!c.u.includes(TOKEN))&&JSON.parse(calls.find(c=>c.o&&c.o.body).o.body).token===TOKEN);
check('stats shown',d.getElementById('s-ref').textContent==='2'&&d.getElementById('s-pend').textContent==='1'&&d.getElementById('s-rank').textContent==='#2');
check('"email confirmed" banner on first open',!d.getElementById('banner').hidden);
check('referral link built from site origin',d.getElementById('reflink').value==='https://kloop.test/?ref=klp_abc234');
check('whatsapp + x share links',decodeURIComponent(d.getElementById('wa').href).includes('https://kloop.test/?ref=klp_abc234')&&d.getElementById('xs').href.startsWith('https://twitter.com/intent/tweet'));
const prog=[...d.querySelectorAll('#progress .prog')];
check('reward progress cards with remaining counts',prog.length===2&&/4 more referrals to get into the top 1/.test(prog[0].textContent)&&/1 more referral to qualify/.test(prog[1].textContent),prog.map(p=>p.textContent).join('|'));
check('progress bar reflects refs/target',prog[1].querySelector('.bar i').style.width==='67%',prog[1].querySelector('.bar i').style.width);
check('leaderboard rows + own row highlighted',d.querySelectorAll('#lb li').length===3&&d.querySelector('#lb li.me .nm').textContent==='Member 3F9A1C'&&!d.getElementById('lb').hidden);
check('reward definitions rendered as text, not HTML',d.querySelectorAll('#rewards > div').length===2&&!d.querySelector('#rewards b b')&&/Founding <b>spot<\/b>/.test(d.getElementById('rewards').textContent));
d.getElementById('copy').click(); await new Promise(r=>setTimeout(r,20));
check('copy button copies the link',w.__copied==='https://kloop.test/?ref=klp_abc234'&&d.getElementById('copy').textContent==='Copied');

// 2. qualified state + unranked
const q={...mine,verified_now:false,rank:null,total_ranked:0,verified_referrals:0,pending_referrals:0,rewards:[{...mine.rewards[0],qualified:true,needed:0}]};
({d}=await load('#t='+TOKEN,async(u,b)=>u.includes('leaderboard')?ok200(board):ok200(q)));
check('unranked member sees how to enter',d.getElementById('s-rank').textContent==='Not yet'&&/first confirmed referral/.test(d.getElementById('s-hint').textContent)&&d.getElementById('banner').hidden);
({d}=await load('#t='+TOKEN,async(u,b)=>u.includes('leaderboard')?ok200(board):ok200({...q,rank:1,total_ranked:1,verified_referrals:3})));
check('qualified reward shows a green state',d.querySelector('#progress .prog.ok')&&/in position/.test(d.querySelector('#progress .prog.ok').textContent));

// 3. no rewards configured yet
({d}=await load('#t='+TOKEN,async(u,b)=>u.includes('leaderboard')?ok200({...board,rewards:[]}):ok200({...mine,rewards:[]})));
check('empty reward config is communicated, nothing invented',!d.getElementById('rw-empty').hidden&&d.querySelectorAll('#rewards > div').length===0&&/being finalised/.test(d.getElementById('progress').textContent));

// 4. invalid token
({d}=await load('#t=bogus',async(u,b)=>u.includes('leaderboard')?ok200(board):{status:401,json:{error:'invalid_link'}}));
check('invalid link falls back to the email form with a clear message',!d.getElementById('getlink').hidden&&d.getElementById('dash').hidden&&/no longer valid/.test(d.getElementById('gl-title').textContent)&&d.querySelectorAll('#lb li').length===3);

// 5. server down
({d}=await load('#t='+TOKEN,async(u,b)=>u.includes('leaderboard')?ok200(board):{status:500,json:{}}));
check('server error does not say the link is invalid',/could not load/.test(d.getElementById('gl-title').textContent));

// 6. no token: request-link flow
({d,w,calls}=await load('',normal));
check('no token shows the request form + public leaderboard',!d.getElementById('getlink').hidden&&d.getElementById('dash').hidden&&d.querySelectorAll('#lb li').length===3&&!calls.some(c=>c.o&&c.o.body&&JSON.parse(c.o.body).action==='me'));
const ask=async(email,api)=>{const x=await load('',api||normal);x.d.getElementById('gl-email').value=email;x.d.getElementById('gl-btn').click();await new Promise(r=>setTimeout(r,60));return x};
let x=await ask('nope');check('bad email stopped client-side',/valid email/.test(x.d.getElementById('gl-status').textContent)&&!x.calls.some(c=>c.o&&c.o.body&&c.o.body.includes('request_link')));
x=await ask('a@b.co');const rl=x.calls.find(c=>c.o&&c.o.body&&c.o.body.includes('request_link'));
check('request link sends the email and shows a non-revealing message',rl&&JSON.parse(rl.o.body).email==='a@b.co'&&/If that email is on the waitlist/.test(x.d.getElementById('gl-status').textContent)&&!x.d.getElementById('gl-btn').disabled);
x=await ask('a@b.co',async(u,b)=>b&&b.action==='request_link'?{status:429,json:{}}:u.includes('leaderboard')?ok200(board):{status:404,json:{}});
check('rate limit message',/Too many/.test(x.d.getElementById('gl-status').textContent));
x=await ask('a@b.co',async(u,b)=>{if(b&&b.action==='request_link')throw new Error('net');return u.includes('leaderboard')?ok200(board):{status:404,json:{}}});
check('network failure message',/went wrong/.test(x.d.getElementById('gl-status').textContent));

// 7. empty leaderboard + leaderboard down
({d}=await load('',async(u)=>u.includes('leaderboard')?ok200({ok:true,entries:[],total_ranked:0,rewards:[]}):{status:404,json:{}}));
check('empty leaderboard state',!d.getElementById('lb-empty').hidden&&d.getElementById('lb').hidden);
({d}=await load('',async(u)=>{throw new Error('down')}));
check('page survives the API being down',!d.getElementById('getlink').hidden&&d.getElementById('loading').hidden);
process.exit(fail?1:0);
