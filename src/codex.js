import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { stopTree } from './process.js';
import { fileURLToPath } from 'node:url';
import { questionCategory } from './blockers.js';

export class CodexError extends Error {
  constructor(message, details = {}) { super(message); this.name='CodexError'; this.details=details; }
}

export class CodexClient extends EventEmitter {
  constructor(config) { super(); this.config=config; this.pending=new Map(); this.sequence=0; this.child=null; this.closed=false; }
  async start() {
    this.child=spawn(process.execPath,[fileURLToPath(new URL('./process-host.js',import.meta.url)),this.config.root||process.cwd(),this.config.workspaceLock||'',this.config.codexPath,'app-server','--stdio'],{
      stdio:['pipe','pipe','pipe'], windowsHide:true,detached:process.platform!=='win32',
    });
    this.child.stdin.on('error',e=>this.fail(e));
    this.child.once('error',e=>this.fail(e));
    this.child.once('exit',(code)=>this.fail(new CodexError(`Codex app-server exited (${code})`)));
    this.stderr='';
    this.child.stderr.on('data',d=>{this.stderr=(this.stderr+d).slice(-12000);});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=> {
      let message;
      try { message=JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        this.emit('request',message);
      } else if (message.id !== undefined) {
        const pending=this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexError(message.error.message,message.error));
        else pending.resolve(message.result);
      } else if (message.method) this.emit('notification',message);
    });
    // Never leave an unsolicited server request unresolved.
    this.on('request',message=> {
      if (this.listenerCount('request')===1) this.respond(message.id,null,{code:-32601,message:'No active task handles this request'});
    });
    await this.request('initialize',{clientInfo:{name:'dark_fabric',title:'Dark Fabric',version:'0.1.0'},capabilities:{experimentalApi:false}});
    this.send({method:'initialized',params:{}});
    return this;
  }
  send(message) {
    if (this.closed || !this.child?.stdin.writable) throw new CodexError('Codex connection closed');
    this.child.stdin.write(JSON.stringify(message)+'\n');
  }
  request(method,params={}) {
    if (this.closed) return Promise.reject(new CodexError('Codex connection closed'));
    return new Promise((resolve,reject)=> {
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new CodexError(`RPC timeout: ${method}`));},this.config.rpcTimeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try { this.send({id,method,params}); } catch(e) { clearTimeout(timer);this.pending.delete(id);reject(e); }
    });
  }
  respond(id,result,error) {
    try { this.send(error ? {id,error} : {id,result}); } catch { /* closed transport already reported */ }
  }
  fail(error) {
    if (this.closed) return;
    this.closed=true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer);pending.reject(error); }
    this.pending.clear(); this.emit('disconnected',error);
  }
  async close() {
    if (!this.child) return;
    const child=this.child;
    const exited=new Promise(resolve=>{ if (child.exitCode!==null || !child.pid) resolve(); else child.once('close',resolve); });
    this.fail(new CodexError('Codex client closed'));
    this.child.stdin.end();
    const killer=setTimeout(()=>stopTree(child),5000);
    await exited;
    clearTimeout(killer);
    this.lines?.close();
  }
}

export function quotaState(response, now = Date.now(), bucket = 'codex') {
  const buckets=response?.rateLimitsByLimitId;
  const selected=buckets?.[bucket] || response?.rateLimits;
  if (!selected) return {known:false,blocked:false,until:0,observedAt:now};
  const windows=[selected.primary,selected.secondary].filter(Boolean);
  const complete=windows.length>0 && windows.every(w=>Number.isFinite(w.usedPercent));
  const exhausted=windows.filter(w=>Number.isFinite(w.usedPercent) && w.usedPercent>=100 && (!Number.isFinite(w.resetsAt) || w.resetsAt*1000>now));
  if (!exhausted.length && !complete) return {known:false,complete:false,blocked:false,until:0,observedAt:now,primary:selected.primary,secondary:selected.secondary};
  const until=exhausted.reduce((v,w)=>Math.max(v,Number.isFinite(w.resetsAt)?w.resetsAt*1000+5000:now+900_000),0);
  return {known:true,complete,blocked:exhausted.length>0,until,observedAt:now,bucket:selected.limitId||bucket,primary:selected.primary,secondary:selected.secondary};
}

export function classifyError(error) {
  const value=(error.message+' '+JSON.stringify(error.details||{})).toLowerCase();
  if (/usagelimitexceeded|usage_limit|usage limit|rate.?limit|quota|\b429\b/.test(value)) return 'quota';
  if (/unauthorized|not logged in|authentication|\b401\b/.test(value)) return 'auth';
  if (/contextwindowexceeded|context window/.test(value)) return 'context';
  if (/sandboxerror|sandbox.*(unavailable|not supported|setup failed)/.test(value)) return 'sandbox';
  return 'transient';
}

export class CodexRunner {
  constructor(config, createClient = options => new CodexClient({...config,...options})) { this.config=config;this.createClient=createClient; }
  async readQuota() {
    const client=this.createClient();
    try { await client.start(); return quotaState(await client.request('account/rateLimits/read')); }
    finally { await client.close(); }
  }
  async listModels() {
    const client=this.createClient();
    try {
      await client.start();const models=[];let cursor;
      do{const page=await client.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
        if(!Array.isArray(page?.data))throw new CodexError('Invalid model catalog');
        models.push(...page.data);cursor=page.nextCursor;
        if(models.length>1000)throw new CodexError('Model catalog pagination exceeded');
      }while(cursor);
      return models;
    } finally {await client.close();}
  }
  async run({cwd,prompt,schema,readOnly,threadId,onThread,onEvent,signal,model,effort}) {
    const client=this.createClient({workspaceLock:cwd});
    let timer, abort, notification, request, disconnected;
    try {
      await client.start();
      const full=this.config.executionAccess==='full';
      const params={cwd,approvalPolicy:'never',sandbox:full?'danger-full-access':readOnly?'read-only':'workspace-write'};
      if (model||this.config.model) params.model=model||this.config.model;
      const response=await client.request(threadId?'thread/resume':'thread/start',threadId?{...params,threadId}:{...params,serviceName:'dark_fabric'});
      threadId=response.thread.id;
      onThread?.(threadId);
      onEvent?.({method:'factory/modelSelected',params:{model:response.model||params.model||null,effort:effort||null}});
      let turnId=null,finalText='',questions=[],finished=false;
      let resolveTurn,rejectTurn;
      const completed=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});
      // The server can emit completion before returning the turn/start response.
      const finish=(error,result)=>{if(finished)return;finished=true;error?rejectTurn(error):resolveTurn(result);};
      const interrupt=()=>{if(turnId) client.request('turn/interrupt',{threadId,turnId}).catch(()=>{});};
      const emitEvent=message=>{
        try { onEvent?.(message);return true; }
        catch(error) { finish(error);interrupt();return false; }
      };
      notification=message=>{
        const p=message.params||{};
        if(p.threadId && p.threadId!==threadId) return;
        if(message.method==='turn/started') turnId=p.turn.id;
        if(message.method==='item/completed' && p.item?.type==='agentMessage' && p.item.phase!=='commentary') finalText=p.item.text;
        if(['item/completed','turn/started','turn/completed','error','thread/tokenUsage/updated','account/rateLimits/updated','model/rerouted'].includes(message.method)&&!emitEvent(message))return;
        // Completion may precede final telemetry and the turn/start response.
        if(finished)return;
        if(message.method==='turn/completed') {
          if(questions.length) finish(null,{status:'blocked',summary:'Codex requested human input',questions,evidence:[],tasks:[],lessons:[]});
          else if(p.turn.status!=='completed') finish(new CodexError(p.turn.error?.message||`Turn ${p.turn.status}`,p.turn.error||{}));
          else {
            try { finish(null,JSON.parse(finalText)); }
            catch { finish(new CodexError('Codex returned invalid structured output',{finalText:finalText.slice(-5000)})); }
          }
        }
      };
      request=message=>{
        const p=message.params||{};
        if(p.threadId && p.threadId!==threadId) {client.respond(message.id,null,{code:-32601,message:'Unknown thread'});return;}
        if(full&&['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(message.method)){
          // The operator explicitly configured full execution access. No second
          // permission question for ordinary execution/filesystem/network use.
          client.respond(message.id,message.method==='item/permissions/requestApproval'?{permissions:p.permissions||{},scope:'turn'}:{decision:'accept'});
          emitEvent({method:'factory/approvalGranted',params:{method:message.method,scope:'turn'}});
          return;
        }
        if(message.method==='item/tool/requestUserInput') {
          questions.push(...(p.questions||[]).map(q=>{const question={prompt:q.question||q.header||'Codex needs input',context:'Input requested during execution',choices:(q.options||[]).map(o=>o.label)};return {...question,category:questionCategory(question)};}));
          client.respond(message.id,{answers:{}});
        } else {
          questions.push({category:'technical',prompt:`Требуется решение: ${message.method}`,context:JSON.stringify(p),choices:[]});
          if(message.method.includes('requestApproval') && !message.method.includes('permissions')) client.respond(message.id,{decision:'decline'});
          else if(message.method==='item/permissions/requestApproval') client.respond(message.id,{permissions:{},scope:'turn'});
          else if(message.method==='mcpServer/elicitation/request') client.respond(message.id,{action:'decline'});
          else client.respond(message.id,null,{code:-32601,message:'Human input queued; task will resume later'});
        }
        // Preserve work and release the worker. A future turn includes the human answer.
        interrupt();
        finish(null,{status:'blocked',summary:'Human input queued',questions,evidence:[],tasks:[],lessons:[]});
      };
      disconnected=error=>finish(error);
      client.on('notification',notification); client.on('request',request); client.on('disconnected',disconnected);
      abort=()=>{interrupt();finish(new CodexError('Worker interrupted'));};
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{interrupt();finish(new CodexError('Codex turn timed out'));},this.config.turnTimeoutMs);
      if(signal?.aborted) abort();
      // Attach rejection handler before the RPC, so an early disconnect is never unhandled.
      completed.catch(()=>{});
      if(!finished) {
        const started=await client.request('turn/start',{
          threadId,input:[{type:'text',text:prompt}],outputSchema:schema,
          ...(params.model?{model:params.model}:{}),...(effort?{effort}:{}),
          approvalPolicy:'never',cwd,
          sandboxPolicy:full?{type:'dangerFullAccess'}:readOnly?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[cwd],networkAccess:this.config.networkAccess},
        });
        turnId=started.turn.id;
      }
      return await completed;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort',abort);
      if(notification)client.removeListener('notification',notification);
      if(request)client.removeListener('request',request);
      if(disconnected)client.removeListener('disconnected',disconnected);
      await client.close();
    }
  }
}
