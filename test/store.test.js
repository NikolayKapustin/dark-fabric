import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import path from 'node:path';
import { fixture } from './helpers.js';

test('a blocked task does not stop unrelated work; dependencies wait for completion',t=>{
  const {store,add}=fixture(t);
  const a=add({priority:10}),b=add({depends:[a.id]}),c=add();
  const claimed=store.claim();assert.equal(claimed.id,a.id);
  store.block(claimed,[{prompt:'Choose a direction'},{prompt:'Provide required credential location'}]);
  assert.equal(store.claim().id,c.id);
  const qs=store.rows('SELECT * FROM questions');
  store.answer(qs[0].id,'A');assert.equal(store.task(a.id).status,'blocked');
  store.answer(qs[1].id,'Use local login');assert.equal(store.task(a.id).status,'pending');
  assert.equal(store.task(b.id).status,'pending');
  assert.throws(()=>store.answer(qs[0].id,'B'),/already answered/);
});
test('one writer per project and transactional claim across database connections',t=>{
  const f=fixture(t);f.add();f.add();
  const other=new Store(path.join(f.root,'test.sqlite'));
  try {
    const task=f.store.claim();assert.ok(task);assert.equal(other.claim(),null);
    assert.throws(()=>other.patch(task.id,{status:'done'},'wrong-lease'),/lease lost/);
  } finally {other.close();}
});
test('crash recovery preserves workspace, phase, thread and checkpoint',t=>{
  const {store,add}=fixture(t);
  const original=add({phase:'review'});const claimed=store.claim();
  store.patch(claimed.id,{workspace:'saved',thread_id:'thread',checkpoint_sha:'sha'},claimed.lease);
  store.startRun(claimed);assert.equal(store.recover(),1);
  const recovered=store.task(original.id);
  assert.equal(recovered.status,'pending');assert.equal(recovered.phase,'review');assert.equal(recovered.thread_id,'thread');assert.equal(recovered.checkpoint_sha,'sha');assert.equal(recovered.workspace,'saved');
  assert.equal(store.row('SELECT * FROM runs').status,'interrupted');
  assert.equal(store.recover(),0);
});
test('daily budget persists and renews at UTC day boundary',t=>{
  const {store}=fixture(t);const day=Date.UTC(2026,9,24);
  assert.equal(store.consumeTurn(day,2),true);assert.equal(store.consumeTurn(day+1,2),true);assert.equal(store.consumeTurn(day+2,2),false);assert.equal(store.consumeTurn(day+86400000,2),true);
});
test('questions and task blocking roll back as one transaction on lost ownership',t=>{
  const {store,add}=fixture(t);add();const claimed=store.claim();
  assert.throws(()=>store.block({...claimed,lease:'lost'},[{prompt:'Should not persist'}]));
  assert.equal(store.rows('SELECT * FROM questions').length,0);
});
