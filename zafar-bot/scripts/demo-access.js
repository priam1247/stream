/**
 * scripts/demo-access.js — one-screen proof of WHO the bot answers to.
 *
 * Uses the real gateway, real registry and a fake socket. No network.
 *   node scripts/demo-access.js
 */
const R='/home/user/stream/zafar-bot/';
const fs=require('fs'), path=require('path');
const registry=require(R+'gateway/registry'), router=require(R+'gateway/router');
const fake=require(R+'gateway/fakesock'), store=require(R+'gateway/users/store');
const usage=require(R+'gateway/users/usage'), dedupe=require(R+'gateway/dedupe');
const {paths}=require(R+'lib/paths');
const A='265900000401', B='265900000402', OWNER='265900000409', STUDENT='265900000411', STRANGER='265900000499';
store.writeOwner(OWNER); registry.load({markStatus:false});
fs.rmSync(path.join(paths.numbers,A),{recursive:true,force:true});
fs.rmSync(path.join(paths.numbers,B),{recursive:true,force:true});
store.ensureNumber(A); store.ensureNumber(B);
store.addUser(A, STUDENT, {role:'user'});
const sock=fake.createFakeSocket();
async function go(body, chat, fromMe, label, sockOverride, num=A){
  usage._resetAll(); dedupe._reset(); sock.__sent.length=0;
  const m=fake.buildMessage({body, fromMe, sender: chat.endsWith('@g.us')? (fromMe?num:STUDENT) : chat.split('@')[0], chat});
  const out=await router.handle({number:num, sock: sockOverride||sock, message:m, linked:[A,B]});
  const sent=(sockOverride||sock).__sent.map(x=>String(x.content.text||'').slice(0,40));
  console.log(label.padEnd(46), JSON.stringify(out.reason||out.command||'ok'), sent.length?JSON.stringify(sent):'[no reply]');
}
(async()=>{
  console.log('── direct messages ──');
  await go('.ping', STUDENT+'@s.whatsapp.net', false, 'approved student in DM');
  await go('.ping', STRANGER+'@s.whatsapp.net', false, 'STRANGER in DM');
  await go('.ping', A+'@s.whatsapp.net', true, 'owner from own phone');
  console.log('── groups with two linked numbers ──');
  const g='120363000000000777@g.us';
  store.setGroupEnabled(A, g, true);
  await go('.ping', g, false, 'student in group / socket A', sock, A);
  const sockB=fake.createFakeSocket();
  await go('.ping', g, false, 'same msg / socket B (must stand down)', sockB, B);
  const g2='120363000000000888@g.us';
  await go('.ping', g2, false, 'group not switched on', sock, A);
  console.log('── owner in group from own phone ──');
  store.setGroupEnabled(A, g, true);
  await go('.ping', g, true, 'owner in group / socket A', sock, A);
  await go('.ping', g, true, 'owner in group / socket B (stand down)', sockB, B);
})();
