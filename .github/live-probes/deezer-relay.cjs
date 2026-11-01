'use strict';
// Temporary egress for end-to-end encrypted Deezer TLS, no credentials or URLs logged.
const net=require('node:net');
const WebSocket=require('../../Whatsapp bot/node_modules/ws');
const hosts=/^(?:[a-z0-9-]+\.)*(?:deezer\.com|dzcdn\.net)$/i;
const sockets=new Map();
const ws=new WebSocket(process.env.RELAY_URL,{headers:{Authorization:`Bearer ${process.env.WORKFLOW_TOKEN}`,'X-Run-Id':process.env.GITHUB_RUN_ID},handshakeTimeout:20000});
function sendBinary(id,data){if(ws.readyState!==WebSocket.OPEN)return;const h=Buffer.alloc(4);h.writeUInt32BE(id);ws.send(Buffer.concat([h,data]));}
ws.on('open',()=>console.log('Encrypted relay active.'));
ws.on('message',(data,binary)=>{
  if(binary){if(data.length<5)return;const sock=sockets.get(data.readUInt32BE(0));if(sock&&!sock.destroyed)sock.write(data.subarray(4));return;}
  let msg;try{msg=JSON.parse(data.toString())}catch{return;}
  if(msg.t==='close'){sockets.get(msg.id)?.destroy();sockets.delete(msg.id);return;}
  if(msg.t!=='open'||!Number.isSafeInteger(msg.id)||!hosts.test(String(msg.host)))return;
  const socket=net.connect({port:443,host:msg.host});sockets.set(msg.id,socket);
  socket.on('connect',()=>ws.send(JSON.stringify({t:'open',id:msg.id})));
  socket.on('data',chunk=>{
    sendBinary(msg.id,chunk);
    if(ws.bufferedAmount>2*1024*1024){socket.pause();const resume=()=>{if(socket.destroyed)return;if(ws.bufferedAmount<1024*1024)socket.resume();else setTimeout(resume,20);};setTimeout(resume,20);}
  });
  socket.on('error',()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({t:'error',id:msg.id}));});
  socket.on('close',()=>{if(sockets.delete(msg.id)&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({t:'close',id:msg.id}));});
});
ws.on('error',(err)=>{const status=String(err.message||'').match(/Unexpected server response: (\d+)/)?.[1];const code=/^[A-Z_]+$/.test(err.code||'')?err.code:'UNKNOWN';console.log(`::error title=Relay failed::${status ? 'HTTP_'+status : code}`);process.exitCode=1;});
ws.on('close',()=>{for(const s of sockets.values())s.destroy();sockets.clear();console.log('Relay stopped.');});
setTimeout(()=>{console.log('Relay time limit reached.');ws.close();},8*60*1000).unref();
