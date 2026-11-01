import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexRunner,CodexError,quotaState,classifyError } from '../src/codex.js';
import { result } from './helpers.js';

test('quota uses seconds, respects all exhausted windows and the configured bucket',()=>{
  const now=1_000_000;
  const response={rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:100,resetsAt:2000},secondary:{usedPercent:100,resetsAt:5000}},other:{primary:{usedPercent:100,resetsAt:999999}}}};
  const q=quotaState(response,now);assert.equal(q.until,5_005_000);assert.equal(q.blocked,true);
  assert.equal(quotaState(response,6_000_000).blocked,false);assert.equal(quotaState({}).known,false);
  assert.equal(quotaState({rateLimits:{primary:{usedPercent:50,resetsAt:2000}}},now).blocked,false);
  assert.equal(classifyError(new CodexError('error',{codexErrorInfo:'UsageLimitExceeded'})),'quota');
});
class FakeClient extends EventEmitter {
  constructor(mode){super();this.mode=mode;this.responses=[];this.closed=false;}
  async start(){return this;}
  async close(){this.closed=true;}
  respond(id,response,error){this.responses.push({id,result:response,error});if(response?.decision==='accept'){
    this.emit('notification',{method:'item/completed',params:{threadId:'t1',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(result())}}});
    this.emit('notification',{method:'turn/completed',params:{threadId:'t1',turn:{status:'completed'}}});
  }}
  async request(method,params){
    if(method==='thread/start'||method==='thread/resume'){this.threadParams=params;return {thread:{id:'t1'}};}
    if(method==='turn/interrupt')return {};
    if(method==='turn/start'){
      this.turnParams=params;
      this.emit('notification',{method:'turn/started',params:{threadId:'t1',turn:{id:'turn1'}}});
      if(this.mode==='input')this.emit('request',{id:50,method:'item/tool/requestUserInput',params:{threadId:'t1',questions:[{question:'Pick A or B',options:[{label:'A'}]}]}});
      else if(this.mode==='crash')this.emit('disconnected',new CodexError('process crashed'));
      else if(this.mode==='approval')this.emit('request',{id:51,method:'item/commandExecution/requestApproval',params:{threadId:'t1',command:'dangerous'}});
      else if(this.mode==='fail')this.emit('notification',{method:'turn/completed',params:{threadId:'t1',turn:{status:'failed',error:{message:'usage limit',codexErrorInfo:'UsageLimitExceeded'}}}});
      else if(this.mode!=='hang'){
        this.emit('notification',{method:'item/completed',params:{threadId:'t1',item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(result())}}});
        this.emit('notification',{method:'turn/completed',params:{threadId:'t1',turn:{status:'completed'}}});
      }
      return {turn:{id:'turn1'}};
    }
  }
}
function setup(mode,options={}){const client=new FakeClient(mode);const runner=new CodexRunner({turnTimeoutMs:100,networkAccess:true,...options},()=>client);return{client,run:(readOnly=false)=>runner.run({cwd:'fixture',prompt:'work',schema:{},readOnly})};}
test('completion before turn/start RPC response is not lost',async()=>{const {client,run}=setup('success');assert.equal((await run()).status,'done');assert.equal(client.closed,true);assert.equal(client.threadParams.sandbox,'workspace-write');assert.equal(client.threadParams.approvalPolicy,'never');});
test('server input becomes a durable-compatible blocked result without waiting for a human',async()=>{const {client,run}=setup('input');const r=await run();assert.equal(r.status,'blocked');assert.equal(r.questions[0].prompt,'Pick A or B');assert.deepEqual(client.responses[0].result,{answers:{}});assert.equal(client.closed,true);});
test('approval is declined and queued, never silently granted',async()=>{const {client,run}=setup('approval');assert.equal((await run()).status,'blocked');assert.equal(client.responses[0].result.decision,'decline');});
test('explicit full access applies to threads and turns, including test-running reviewers',async()=>{for(const readOnly of [true,false]){const {client,run}=setup('approval',{executionAccess:'full'});assert.equal((await run(readOnly)).status,'done');assert.equal(client.threadParams.sandbox,'danger-full-access');assert.equal(client.threadParams.approvalPolicy,'never');assert.deepEqual(client.turnParams.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(client.responses[0].result.decision,'accept');}});
test('a disconnected, failed or hung Codex process releases its worker',async()=>{for(const mode of ['crash','fail','hang']){const {client,run}=setup(mode);await assert.rejects(run());assert.equal(client.closed,true);}});

test('asynchronous notification callback failure rejects only its turn and closes its client',async()=>{
 const client=new FakeClient('hang'),runner=new CodexRunner({turnTimeoutMs:2000},()=>client);
 const failure=Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
 let notify;
 const ready=new Promise(resolve=>{notify=resolve;});
 const pending=runner.run({cwd:'fixture',prompt:'work',schema:{},onEvent:message=>{
  if(message.method==='turn/started')notify();
  if(message.method==='thread/tokenUsage/updated')throw failure;
 }});
 const rejected=assert.rejects(pending,e=>e===failure);
 await ready;
 // Emit outside the turn/start promise: an uncaught EventEmitter exception is
 // the production failure, unlike a synchronous exception in a fake RPC.
 assert.doesNotThrow(()=>client.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'t1'}}));
 await rejected;assert.equal(client.closed,true);assert.equal(client.listenerCount('notification'),0);
 assert.equal((await setup('success').run()).status,'done');
});
test('telemetry arriving after completion but before the start response is retained',async()=>{
 const late=[
  {method:'thread/tokenUsage/updated',params:{threadId:'t1',tokenUsage:{total:{totalTokens:42}}}},
  {method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:100}}}},
  {method:'model/rerouted',params:{threadId:'t1',toModel:'another-model'}},
 ];
 class LateClient extends FakeClient{
  async request(method,params){
   const response=await super.request(method,params);
   if(method==='turn/start')for(const event of late)this.emit('notification',event);
   return response;
  }
 }
 const client=new LateClient('success'),runner=new CodexRunner({turnTimeoutMs:100},()=>client),events=[];
 const result=await runner.run({cwd:'fixture',prompt:'work',schema:{},onEvent:event=>events.push(event)});
 assert.equal(result.status,'done');assert.deepEqual(events.slice(-3),late);assert.equal(client.closed,true);
});
test('selected model and effort reach the official thread and turn calls',async()=>{
 const client=new FakeClient('success'),runner=new CodexRunner({turnTimeoutMs:100},()=>client);
 await runner.run({cwd:'fixture',prompt:'work',schema:{},model:'available-model',effort:'high'});
 assert.equal(client.threadParams.model,'available-model');assert.equal(client.turnParams.model,'available-model');assert.equal(client.turnParams.effort,'high');
});
test('model discovery follows pagination and closes the telemetry connection on failure',async()=>{
 const client=new FakeClient('success');let calls=0;client.request=async(method,params)=>{assert.equal(method,'model/list');calls++;return calls===1?{data:[{model:'a'}],nextCursor:'next'}:{data:[{model:'b'}],nextCursor:null};};
 const runner=new CodexRunner({},()=>client);assert.deepEqual((await runner.listModels()).map(m=>m.model),['a','b']);assert.equal(client.closed,true);
 const fail=new FakeClient();fail.request=async()=>{throw new Error('offline')};await assert.rejects(new CodexRunner({},()=>fail).listModels(),/offline/);assert.equal(fail.closed,true);
});
