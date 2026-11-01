import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResult } from '../src/contracts.js';
import { result,planTask } from './helpers.js';
import {qualityDigest} from '../src/integrity.js';
test('agent output enforces DAG, acceptance criteria, bounded plans and phase capabilities',()=>{
  assert.throws(()=>validateResult(result({tasks:[planTask('a',['b']),planTask('b',['a'])]}),'plan'),/cycle/);
  assert.throws(()=>validateResult(result({tasks:[planTask('a'),planTask('a')]}),'plan'),/unique/);
  assert.throws(()=>validateResult(result({tasks:[planTask('a')]}),'implement'),/Only a planner/);
  assert.throws(()=>validateResult(result({evidence:[]}),'research'),/primary-source/);
  assert.throws(()=>validateResult(result({tasks:[planTask('a'),planTask('b')]}),'plan',1),/exceeds/);
  assert.throws(()=>validateResult(result({status:'blocked'}),'implement'),/concrete question/);
  assert.throws(()=>validateResult(result({extra:'malicious'}),'review'),/Invalid agent result/);
});
test('pinned text survives Git line-ending conversion without accepting changed assertions',()=>{
  assert.equal(qualityDigest(Buffer.from('assert(true);\n')),qualityDigest(Buffer.from('assert(true);\r\n')));
  assert.notEqual(qualityDigest(Buffer.from('assert(true);\n')),qualityDigest(Buffer.from('assert(false);\n')));
  assert.notEqual(qualityDigest(Buffer.from([0,13,10])),qualityDigest(Buffer.from([0,10])));
});
