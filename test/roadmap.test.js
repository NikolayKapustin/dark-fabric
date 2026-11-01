import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,symlinkSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fixture} from './helpers.js';
import {parseSections,projectRoadmap} from '../src/roadmap.js';
import {remoteSnapshot} from '../src/remote.js';

test('generic roadmap preserves source lines, hierarchy and live task state independently of plans',t=>{
  const f=fixture(t);
  writeFileSync(path.join(f.root,'ROADMAP.md'),'# Plan\n\n## Milestone A\n\nAcceptance: verified behavior.\n### Input\nTwo routes.');
  writeFileSync(path.join(f.root,'STATUS.md'),'# Status\n## Version 1\nEvidence pending.');
  const task=f.add();f.store.patch(task.id,{status:'running'});
  const r=projectRoadmap(f.mission,f.store.snapshot().tasks,f.project);
  const a=r.nodes['doc:ROADMAP.md:3'];assert.equal(a.source.line,3);assert.equal(a.status,undefined);assert.match(a.body,/Acceptance/);
  assert.equal(r.nodes[a.children[0]].title,'Input');assert.equal(r.nodes[`task:${task.id}`].status,'running');
  writeFileSync(path.join(f.root,'STATUS.md'),'# Status\n## Version 2\nChecked.');
  const updated=projectRoadmap(f.mission,[],f.project);assert.notEqual(updated.sourceRevision,r.sourceRevision);assert.equal(updated.nodes['doc:STATUS.md:2'].title,'Version 2');
  const projected=remoteSnapshot(f.store,f.config);assert.equal(projected.roadmap.available,true);assert.deepEqual(projected.incidents,[]);
});

test('markdown code fences cannot introduce false roadmap headings',()=>{
  const sections=parseSections('# Real\n```\n## Fake\n```\n~~~txt\n## Also fake\n~~~\n## Actual','plan.md');assert.deepEqual(sections.map(s=>s.title),['Real','Actual']);
});

test('roadmap does not read arbitrary documents or follow a directory outside the workspace',t=>{
  const f=fixture(t),outside=mkdtempSync(path.join(os.tmpdir(),'df-roadmap-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  writeFileSync(path.join(outside,'roadmap.md'),'# Private outside');symlinkSync(outside,path.join(f.root,'docs'),'junction');
  writeFileSync(path.join(f.root,'private.md'),'# Do not publish');
  const r=projectRoadmap(f.mission,[],{...f.project,name:'Any product',profile:{milestones:[{title:'First',outcome:'Measured'}]}});
  assert.deepEqual(r.sources,[]);assert.equal(r.title,'Any product');assert.equal(r.nodes['milestone:0'].title,'First');assert.doesNotMatch(JSON.stringify(r),/Private outside|Do not publish/);
});

test('roadmap bounds oversized source files and projection size',t=>{
  const f=fixture(t);writeFileSync(path.join(f.root,'STATUS.md'),'# Big\n'+'x'.repeat(1_000_001));
  writeFileSync(path.join(f.root,'ROADMAP.md'),Array.from({length:80},(_,i)=>'# Section '+i+'\n'+'x'.repeat(8000)).join('\n'));
  const r=projectRoadmap(f.mission,[]);assert.deepEqual(r.sources,['ROADMAP.md']);assert.ok(Buffer.byteLength(JSON.stringify(r))<350000);
  assert.ok(Object.values(r.nodes).some(n=>n.excerpt));
});
