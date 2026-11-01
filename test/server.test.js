import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture } from './helpers.js';
import { createServer } from '../src/server.js';
test('operator API rejects unauthenticated writes, cross-origin requests and DNS rebinding',async t=>{
  const f=fixture(t),token='test-token',server=createServer(f.store,f.config,token);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/api/state')).status,401);
    assert.equal((await fetch(base+'/api/state',{headers:{'X-Dark-Fabric-Token':token}})).status,200);
    assert.equal((await fetch(base+'/api/pause',{method:'POST',headers:{'X-Dark-Fabric-Token':token,'Content-Type':'application/json',Origin:'https://evil.example'},body:'{"paused":true}'})).status,403);
    const rebound=await new Promise((resolve,reject)=>{http.get(base+'/health',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(rebound,403);
    assert.equal(f.store.get('paused',false),false);
    const html=await (await fetch(base)).text();assert.match(html,/Dark Fabric/);assert.ok(html.includes(token));
  }finally{await new Promise(r=>server.close(r));}
});
