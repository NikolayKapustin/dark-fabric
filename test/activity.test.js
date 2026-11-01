import test from 'node:test';
import assert from 'node:assert/strict';
import {factoryActivity} from '../src/activity.js';
const task=(id,extra={})=>({id,title:id,phase:'implement',status:'pending',kind:'work',mission_id:'mission',depends:[],available_at:0,updated_at:1,...extra});
const snapshot=tasks=>({tasks,missions:[{id:'mission',status:'active'}],runs:[],paused:false});
test('cooldown is reported as stalled work with a retry time, not ready or running',()=>{
 const tasks=[task('accepted',{status:'done'}),task('report',{depends:['accepted'],available_at:10000}),task('review',{depends:['report']})];
 const status=factoryActivity(snapshot(tasks),{dailyTurnLimit:100},[{taskId:'report',status:'retrying',attempts:12}],5000);
 assert.equal(status.state,'retrying');assert.equal(status.current.id,'report');assert.equal(status.retryAt,10000);assert.equal(status.next.id,'review');assert.equal(status.lastDelivered.id,'accepted');assert.deepEqual(status.work,{done:1,total:3});
});
test('live work, blocked dependencies and exhausted budget are distinguishable',()=>{
 const tasks=[task('report',{status:'running'}),task('review',{depends:['report']})];
 assert.equal(factoryActivity(snapshot(tasks),{},[],5000).state,'running');
 tasks[0].status='blocked';assert.equal(factoryActivity(snapshot(tasks),{},[],5000).state,'dependencies');
 const s=snapshot([task('ready')]);s.budget={day:'1970-01-01',used:100};assert.equal(factoryActivity(s,{dailyTurnLimit:100},[],5000).state,'budget');
});
