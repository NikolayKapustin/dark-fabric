import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const fields=['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'];
const empty=()=>Object.fromEntries(fields.map(k=>[k,0]));
const add=(a,b)=>Object.fromEntries(fields.map(k=>[k,(a?.[k]||0)+(b?.[k]||0)]));
export function initTelemetry(db){
  const legacy=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_days'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS run_usage(run_id TEXT PRIMARY KEY,usage_json TEXT NOT NULL,updated_at INTEGER NOT NULL,historical INTEGER NOT NULL DEFAULT 0,partial INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS usage_baselines(thread_id TEXT PRIMARY KEY,usage_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_days(day TEXT PRIMARY KEY,usage_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_agents(run_id TEXT PRIMARY KEY,assignment_json TEXT NOT NULL);`);
  // Preserve historical day boundaries when upgrading existing databases.
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('usage:timeZone',?)").run(JSON.stringify(legacy?'Europe/Moscow':'UTC'));
}

// Notifications contain cumulative THREAD totals. Sum only increases, never the
// whole total again when a turn resumes, a notification repeats, or logs replay.
export function recordUsage(store,runId,event,{historical=false,at=Date.now()}={}){
  if(event.method!=='thread/tokenUsage/updated')return;
  const p=event.params||{},total=p.tokenUsage?.total;
  if(typeof p.threadId!=='string'||!Number.isSafeInteger(total?.totalTokens)||total.totalTokens<0)return;
  const sample=Object.fromEntries(fields.map(k=>[k,Number.isSafeInteger(total[k])&&total[k]>=0?total[k]:0]));
  const timestamp=Number.isFinite(event.emittedAtMs)?event.emittedAtMs:at;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:store.get('usage:timeZone')||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(timestamp);
  store.tx(()=>{
    const old=store.row('SELECT * FROM usage_baselines WHERE thread_id=?',p.threadId)?.usage||empty();
    const prior=store.row('SELECT * FROM run_usage WHERE run_id=?',runId);
    const decreased=sample.totalTokens<old.totalTokens;
    const delta=Object.fromEntries(fields.map(k=>[k,Math.max(0,sample[k]-old[k])]));
    const high=Object.fromEntries(fields.map(k=>[k,Math.max(sample[k],old[k])]));
    store.db.prepare('INSERT INTO usage_baselines VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET usage_json=excluded.usage_json').run(p.threadId,JSON.stringify(high));
    store.db.prepare(`INSERT INTO run_usage VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET usage_json=excluded.usage_json,updated_at=excluded.updated_at,historical=MAX(historical,excluded.historical),partial=MAX(partial,excluded.partial)`)
      .run(runId,JSON.stringify(add(prior?.usage,delta)),Math.max(timestamp,prior?.updated_at||0),Number(historical),Number(decreased||fields.some(k=>!Number.isSafeInteger(total[k]))));
    const daily=store.row('SELECT * FROM usage_days WHERE day=?',day)?.usage;
    store.db.prepare('INSERT INTO usage_days VALUES (?,?) ON CONFLICT(day) DO UPDATE SET usage_json=excluded.usage_json').run(day,JSON.stringify(add(daily,delta)));
  });
}

export function backfillUsage(store,root){
  if(store.get('usage:imported:v1'))return;
  // Run before the worker starts. The transaction makes a crash replay safe.
  store.tx(()=>{
    for(const run of store.rows("SELECT * FROM runs WHERE phase NOT IN ('verify','integrate') ORDER BY started_at,id")){
      const file=path.join(root,'logs',run.id+'.jsonl');
      if(!existsSync(file))continue;
      let partial=statSync(file).size>=10_000_000;
      for(const line of readFileSync(file,'utf8').split('\n')){
        if(!line.trim())continue;
        let event;try{event=JSON.parse(line);}catch{partial=true;continue;}
        recordUsage(store,run.id,event,{historical:true,at:run.started_at});
      }
      // Historical logs were size capped; their final totals may be absent.
      if(partial)store.db.prepare('UPDATE run_usage SET partial=1 WHERE run_id=?').run(run.id);
    }
    store.set('usage:imported:v1',{at:Date.now()});
  });
}

export function usageSnapshot(store,now=Date.now()){
  const rows=store.rows('SELECT u.*,r.task_id,r.phase,r.status FROM run_usage u JOIN runs r ON r.id=u.run_id ORDER BY r.started_at DESC');
  const total=rows.reduce((a,r)=>add(a,r.usage),empty());
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:store.get('usage:timeZone')||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const today=store.row('SELECT * FROM usage_days WHERE day=?',day)?.usage||empty();
  const assignments=store.rows('SELECT a.*,r.task_id,r.phase,r.status,r.started_at FROM run_agents a JOIN runs r ON r.id=a.run_id ORDER BY r.started_at DESC');
  const modelRuns=store.row("SELECT COUNT(*) n FROM runs WHERE phase NOT IN ('verify','integrate') AND status!='deferred'").n;
  const byModel=new Map();
  for(const row of rows){const a=assignments.find(x=>x.run_id===row.run_id)?.assignment;const model=a?.mixedModels?'Несколько моделей (без разделения)':a?.actualModel||a?.model||'Не определена';byModel.set(model,add(byModel.get(model),row.usage));}
  return {known:rows.length>0,total,today,day,timeZone:store.get('usage:timeZone')||'UTC',updatedAt:rows.length?Math.max(...rows.map(r=>r.updated_at)):null,
    coverage:{trackedRuns:rows.length,modelRuns,historicalRuns:rows.filter(r=>r.historical).length,partialRuns:rows.filter(r=>r.partial).length},
    byModel:[...byModel].map(([model,usage])=>({model,...usage})),
    tasks:[...new Set(rows.map(r=>r.task_id))].slice(0,150).map(taskId=>({taskId,...rows.filter(r=>r.task_id===taskId).reduce((a,r)=>add(a,r.usage),empty())})),
    runs:rows.slice(0,30).map(r=>({runId:r.run_id,taskId:r.task_id,phase:r.phase,...r.usage,updatedAt:r.updated_at,partial:!!r.partial})),
    assignments:assignments.slice(0,30).map(r=>({runId:r.run_id,taskId:r.task_id,phase:r.phase,status:r.status,...assignmentSummary(r.assignment)})),
  };
}

// Do not export task prompts/criteria or unbounded source text to the portal.
function assignmentSummary(a){
  const text=(value,max)=>typeof value==='string'?value.slice(0,max):null;
  return {agent:text(a.agent,300),profileId:text(a.profileId,80),model:text(a.model,120),actualModel:text(a.actualModel,120),
    effort:text(a.effort,30),reason:text(a.reason,500),independent:!!a.independent,mixedModels:!!a.mixedModels,profile:{custom:!!a.profile?.custom}};
}
