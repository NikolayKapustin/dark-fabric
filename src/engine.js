import { appendFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { uid } from './store.js';
import { CodexRunner, classifyError, quotaState } from './codex.js';
import { Workspaces, IntegrationError } from './git.js';
import { runCommand } from './process.js';
import { stageSchema, validateStageResult } from './contracts.js';
import { makePrompt } from './prompts.js';
import { questionCategory } from './blockers.js';
import { inspectQualityPins } from './quality.js';
import { recordUsage, backfillUsage } from './telemetry.js';
import { assignAgent } from './agents.js';
import { inputContext,markInputsProvided } from './inputs.js';
import {processProjectIntake,recordProjectMetrics,metricHash} from './projects.js';

export class Engine {
  constructor(store,config,{runner,workspaces,command=runCommand,now=Date.now,onHeartbeat=()=>{}}={}) {
    this.store=store;this.config=config;this.runner=runner||new CodexRunner(config);
    this.workspaces=workspaces||new Workspaces(config.root);this.command=command;this.now=now;this.onHeartbeat=onHeartbeat;
    this.active=new Map();this.stopped=false;this.ticking=false;this.controller=new AbortController();
    mkdirSync(path.join(config.root,'logs'),{recursive:true});
    mkdirSync(path.join(config.root,'reports'),{recursive:true});
    backfillUsage(store,config.root);
  }
  modelAllowed() {
    const now=this.now(),quota=this.store.get('quota');
    if(quota?.blocked && quota.until>now)return false;
    const day=new Date(now).toISOString().slice(0,10),budget=this.store.get('budget');
    return !(budget?.day===day && budget.used>=this.config.dailyTurnLimit);
  }
  async refreshQuota(force=false) {
    const now=this.now(),last=this.store.get('quota');
    const cooling=last?.blocked && last.until>now;
    // A reset or plan change can restore quota before the advertised deadline.
    // Poll telemetry during cooldown, but never treat a failed read as recovery.
    if(!force && last && (!last.blocked || cooling) && now-(last.checkedAt??last.observedAt??0)<this.config.quotaPollMs)return;
    try {
      const quota=await this.runner.readQuota();
      // After the durable cooldown expires, missing telemetry allows one controlled probe.
      // If it still hits a hard limit, execute() persists another cooldown.
      const uncertain=!quota.known || quota.complete===false;
      if(uncertain && cooling) {
        this.store.set('quota',{...last,known:false,checkedAt:now,error:undefined,
          until:Math.max(last.until,quota.blocked?quota.until:0)});
      } else if(uncertain && last?.blocked && !quota.blocked) {
        this.store.set('quota',{...last,known:false,blocked:false,until:0,observedAt:now,checkedAt:now});
      } else this.store.set('quota',{...quota,checkedAt:now});
    } catch(error) {
      this.store.set('quota',cooling
        ? {...last,known:false,checkedAt:now,error:error.message}
        : {known:false,blocked:false,until:0,observedAt:now,checkedAt:now,error:error.message});
    }
  }
  async tick() {
    if(this.ticking||this.stopped)return;
    this.ticking=true;
    try {
      this.store.set('heartbeat',{at:this.now(),pid:process.pid,active:[...this.active.keys()]});
      if(this.store.get('paused',false))return;
      if(!this.provisioning)this.provisioning=processProjectIntake(this.store,this.config,{signal:this.controller.signal}).catch(e=>this.store.event('project.retry',null,{message:e.message})).finally(()=>{this.provisioning=null;});
      if(this.active.size||this.store.row("SELECT id FROM tasks WHERE status='pending' AND phase NOT IN ('verify','integrate') AND available_at<=?",this.now())) await this.refreshQuota();
      while(this.active.size<this.config.workers) {
        const task=this.store.claim({now:this.now(),modelAllowed:this.modelAllowed()});
        if(!task)break;
        const promise=this.execute(task).catch(error=>{
          this.store.event('worker.unhandled',task.id,{message:error.message});
          const current=this.store.task(task.id);
          if(current.status==='running'&&current.lease===task.lease)this.store.patch(task.id,{status:'pending',lease:null,available_at:this.now()+this.config.retryBaseMs},task.lease);
        }).finally(()=>this.active.delete(task.id));
        this.active.set(task.id,promise);
      }
      this.settleMissions();
    } finally { this.ticking=false;this.onHeartbeat(); }
  }
  start() { this.timer=setInterval(()=>this.tick().catch(e=>this.store.event('scheduler.error',null,{message:e.message})),this.config.pollMs);return this.tick(); }
  async stop() {
    this.stopped=true;clearInterval(this.timer);this.controller.abort();
    await Promise.allSettled([...this.active.values(),this.provisioning]);
    this.store.set('heartbeat',{at:this.now(),pid:null,active:[],stopped:true});
  }
  release(task,fields) { this.store.patch(task.id,{...fields,lease:null},task.lease); }
  async execute(initial) {
    let task=initial;
    const mission=this.store.mission(task.mission_id),project=this.store.project(mission.project_id);
    const runId=this.store.startRun(task);
    try {
      if(task.kind==='work'&&!task.workspace) {
        const workspace=await this.workspaces.task(project,mission,task);
        task=this.store.patch(task.id,workspace,task.lease);
      }
      if(task.kind==='discovery'&&this.workspaces.discovery)task=await this.workspaces.discovery(project,mission,task,fields=>{
        if(fields.workspace&&task.workspace&&fields.workspace!==task.workspace)this.store.event('discovery.preserved',task.id,{workspace:task.workspace,checkpoint:task.checkpoint_sha});
        task=this.store.patch(task.id,fields,task.lease);return task;
      });
      this.workspaces.assertIdle?.(task.workspace||mission.workspace);
      if(task.phase==='verify') {
        await this.verify(task,project,runId); return;
      }
      if(task.phase==='integrate') {
        if(!this.config.autoIntegrate && !this.store.answers(task.id).some(q=>q.context===`integrate:${task.checkpoint_sha}`&&q.answer.trim().toLowerCase()==='integrate')) {
          this.store.block(task,[{prompt:'Интегрировать проверенный результат в ветку миссии?',context:`integrate:${task.checkpoint_sha}`,choices:['integrate']}]);
          this.store.finishRun(runId,'blocked');return;
        }
        const result=await this.workspaces.integrate(mission,task);
        if(result.stale) {
          this.repair(task,'The mission branch advanced. Merge it into this task, preserve both changes, then re-run verification and review.');
          this.store.finishRun(runId,'stale',result);return;
        }
        this.store.tx(()=>{
          this.release(task,{status:'done',attempts:0});
          this.resolveIncident(task.id);
          this.store.saveLessons(task,task.result.lessons||[]);
          recordProjectMetrics(this.store,project,task,task.result,this.now());
          this.store.finishRun(runId,'done',result);
          this.store.event('task.integrated',task.id,{sha:task.checkpoint_sha,branch:mission.branch});
        });
        return;
      }
      if(!this.modelAllowed()||!this.store.consumeTurn(this.now(),this.config.dailyTurnLimit)) {
        this.release(task,{status:'pending'});this.store.finishRun(runId,'deferred');return;
      }
      if(task.phase==='implement') {
        const sync=await this.workspaces.sync(task,mission);
        if(sync)task=this.store.patch(task.id,{feedback:task.feedback+'\n'+sync},task.lease);
      }
      const dependencies=task.depends.map(id=>this.store.task(id));
      const lessons=this.store.rows('SELECT * FROM lessons WHERE mission_id=? ORDER BY created_at DESC LIMIT 12',mission.id);
      const checkResults=this.store.row("SELECT * FROM runs WHERE task_id=? AND phase='verify' AND status='done' ORDER BY started_at DESC LIMIT 1",task.id)?.result;
      if(['retrospective','assess'].includes(task.phase)) {
        dependencies.push(...this.store.rows("SELECT * FROM tasks WHERE mission_id=? AND kind='work' ORDER BY updated_at DESC LIMIT 20",mission.id));
        task={...task,feedback:task.feedback+'\nRecent failure evidence: '+JSON.stringify(this.store.rows("SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.mission_id=? AND e.type IN ('task.retry','task.repair','task.recovered') ORDER BY e.id DESC LIMIT 20",mission.id))};
      }
      const queue=task.kind==='input'?this.store.rows("SELECT * FROM tasks WHERE mission_id=? AND status!='done' AND id!=?",mission.id,task.id):[];
      const pinResults=inspectQualityPins(project.checks,task.workspace||mission.workspace);
      const recovery=this.store.get(`recovery:${task.id}`);
      const assignment=await assignAgent(this.store,this.runner,this.config,task,project,runId,recovery,this.now());
      const inputs=inputContext(this.store,this.config.root,mission.id);
      const discoveryHead=['discover','discovery_review'].includes(task.phase)?task.checkpoint_sha:null;
      const prompt=makePrompt({task,mission,project,dependencies,answers:this.store.answers(task.id),lessons,checkResults,pinResults,recovery,config:this.config,assignment,inputs,queue});
      const logfile=path.join(this.config.root,'logs',`${runId}.jsonl`);
      const log=event=>{
        // Preserve the original event before any database callback can fail.
        if(!existsSync(logfile)||statSync(logfile).size<10_000_000)appendFileSync(logfile,JSON.stringify(event)+'\n');
        if(event.method==='turn/started')markInputsProvided(this.store,inputs,runId,this.now());
        recordUsage(this.store,runId,event,{at:this.now()});
        if(event.method==='factory/modelSelected'||event.method==='model/rerouted'){
          const actualModel=event.params?.toModel||event.params?.model;
          if(typeof actualModel==='string'){
            assignment.mixedModels ||= event.method==='model/rerouted';
            assignment.actualModel=actualModel;
            this.store.db.prepare('UPDATE run_agents SET assignment_json=? WHERE run_id=?').run(JSON.stringify(assignment),runId);
          }
        }
        if(event.method==='account/rateLimits/updated'){
          const now=this.now(),quota=quotaState(event.params,now),last=this.store.get('quota');
          if(quota.known&&quota.complete)this.store.set('quota',{...quota,checkedAt:now});
          else if(quota.blocked)this.store.set('quota',{...quota,known:false,checkedAt:now,
            until:Math.max(quota.until,last?.blocked?last.until:0)});
        }
      };
      const result=validateStageResult(await this.runner.run({
        cwd:task.workspace||mission.workspace,prompt,schema:stageSchema(task,project),readOnly:task.phase!=='implement',threadId:task.thread_id,
        model:assignment.model,effort:assignment.effort,
        signal:this.controller.signal,
        onThread:threadId=>{this.store.patch(task.id,{thread_id:threadId},task.lease);this.store.db.prepare('UPDATE runs SET thread_id=? WHERE id=?').run(threadId,runId);},
        onEvent:log,
      }),task,project,task.phase==='retrospective'?this.config.maxImprovementTasks:task.phase==='assess'?5:this.config.maxPlanTasks);
      writeFileSync(path.join(this.config.root,'reports',`${runId}.json`),JSON.stringify(result,null,2));
      if(discoveryHead&&!await this.workspaces.cleanAt(task))throw Error('Read-only discovery changed its isolated checkpoint; preserve this checkout and retry from the original source');
      if(result.status==='blocked') {
        const product=result.questions.filter(q=>questionCategory(q)==='product');
        if(this.config.technicalRecovery&&product.length===0){
          this.recoverTechnical(task,result.summary+'\n'+JSON.stringify(result.questions));
          this.store.finishRun(runId,'recovering',result);return;
        }
        this.store.block(task,this.config.technicalRecovery?product:result.questions,result.summary);this.store.finishRun(runId,'blocked',result);return;
      }
      if(result.status==='changes_requested') {
        if(task.phase==='discovery_review')this.release(task,{status:'pending',phase:'discover',thread_id:null,feedback:result.summary,available_at:this.now()+this.config.retryBaseMs});
        else if(['review','implement'].includes(task.phase))this.repair(task,result.summary+'\n'+JSON.stringify(result.evidence));
        else this.retry(task,new Error(result.summary));
        this.store.finishRun(runId,'changes_requested',result);return;
      }
      if(task.phase==='discover'){
        this.store.tx(()=>{
          this.store.db.prepare('UPDATE projects SET discovery_json=? WHERE id=?').run(JSON.stringify({profile:result.profile,summary:result.summary,evidence:result.evidence,at:this.now(),taskId:task.id}),project.id);
          this.release(task,{status:'pending',phase:'discovery_review',thread_id:null,result,attempts:0});
          this.store.finishRun(runId,'done',result);
        });return;
      }
      if(task.phase==='discovery_review'){
        this.store.tx(()=>{
          const draft=this.store.project(project.id).discovery;
          if(!draft.profile||draft.taskId!==task.id)throw Error('Discovery draft identity mismatch');
          this.store.db.prepare('UPDATE projects SET profile_json=?,discovery_required=0 WHERE id=?').run(JSON.stringify({...draft.profile,reviewedAt:this.now(),evidence:draft.evidence,summary:draft.summary}),project.id);
          this.release(task,{status:'done',thread_id:null,result,attempts:0});
          this.store.finishRun(runId,'done',result);this.store.event('project.discovered',task.id,{projectId:project.id,message:'Discovery и независимое ревью завершены.'});
        });return;
      }
      if(task.phase==='implement') {
        const sha=await this.workspaces.checkpoint(task);
        this.store.tx(()=>{
          this.release(task,{status:'pending',phase:'verify',checkpoint_sha:sha,thread_id:null,result,attempts:0});
          this.store.finishRun(runId,'done',result);
        });return;
      }
      if(task.phase==='review') {
        if(!await this.workspaces.cleanAt(task)) {
          this.repair(task,'Files changed during review; produce a clean snapshot and repeat verification.');
          this.store.finishRun(runId,'changes_requested',result);return;
        }
        result.metricDefinitions=Object.fromEntries((project.profile?.metrics||[]).map(m=>[m.id,metricHash(m)]));
        this.store.tx(()=>{
          this.release(task,{status:'pending',phase:'integrate',thread_id:null,result,attempts:0});
          this.store.finishRun(runId,'done',result);
        });return;
      }
      this.store.tx(()=>{
        this.resolveIncident(task.id);
        if(['plan','assess','retrospective'].includes(task.phase)) {
          const ids=new Map(result.tasks.map(t=>[t.key,uid()]));
          for(const t of result.tasks)this.store.addTask({id:ids.get(t.key),missionId:mission.id,title:t.title,instructions:t.instructions,criteria:t.acceptanceCriteria,depends:[task.id,...t.dependsOn.map(k=>ids.get(k))],priority:t.priority,improvement:task.phase==='retrospective'});
        }
        this.release(task,{status:'done',result,thread_id:null,attempts:0});
        this.store.finishRun(runId,'done',result);this.store.event('stage.completed',task.id,{phase:task.phase,summary:result.summary});
      });
    } catch(error) {
      this.store.finishRun(runId,'failed',{message:error.message,details:error.details||null});
      if(this.stopped) {this.release(task,{status:'pending'});return;}
      const kind=classifyError(error);
      if(kind==='quota') {
        await this.refreshQuota(true);
        const quota=this.store.get('quota');
        const until=quota?.blocked&&quota.until>this.now()?quota.until:this.now()+this.config.unknownQuotaBackoffMs;
        this.store.set('quota',{...quota,blocked:true,until,observedAt:this.now(),reason:error.message});
        this.release(task,{status:'pending'});
        this.store.event('quota.wait',task.id,{until});
      } else if(['auth','sandbox'].includes(kind)) {
        if(this.config.technicalRecovery){this.recoverTechnical(task,error.message,kind);return;}
        this.store.block(task,[{prompt:kind==='auth'?'Восстановите вход через codex login и подтвердите готовность.':'Codex не смог запустить sandbox. Исправьте среду и подтвердите готовность.',context:error.message,choices:['Готово']}],error.message);
      } else if(kind==='context') {
        this.retry(task,error,{thread_id:null,feedback:task.feedback+'\nPrior context exhausted. Reconstruct from the workspace, durable task record and prior feedback.'});
      } else this.retry(task,error);
    }
  }
  async verify(task,project,runId) {
    if(!project.checks.length) {
      if(this.config.technicalRecovery){
        this.recoverTechnical(task,'No trusted quality commands are configured. Restore the project quality configuration; never integrate without an executable gate.','quality');
        this.store.finishRun(runId,'recovering');return;
      }
      this.store.block(task,[{prompt:'Задайте проверку качества для проекта через project checks, затем подтвердите.',context:'No trusted quality commands are configured. Work cannot be integrated without an executable gate.',choices:['Проверка настроена']}]);
      this.store.finishRun(runId,'blocked');return;
    }
    if(!await this.workspaces.cleanAt(task)) {
      this.repair(task,'Checkpoint changed before verification. Inspect changes and produce a new checkpoint.');
      this.store.finishRun(runId,'changes_requested');return;
    }
    const results=[];
    for(const check of project.checks) {
      for(const pin of inspectQualityPins([check],task.workspace)) {
        if(!pin.matched) {
          this.repair(task,`Trusted regression file changed: ${pin.path}. Restore it; add new tests separately. Only the operator can update the trusted baseline.`);
          this.store.finishRun(runId,'failed',{protectedFile:pin.path});return;
        }
      }
      const result=await this.command(check.command,{cwd:task.workspace,timeoutMs:check.timeoutMs||300_000,signal:this.controller.signal,stateRoot:this.config.root,workspaceLock:task.workspace});
      results.push({name:check.name,command:check.command,...result});
      if(result.code!==0||result.timedOut||result.aborted)break;
    }
    const passed=results.length===project.checks.length && results.every(r=>r.code===0&&!r.timedOut&&!r.aborted);
    const unchanged=await this.workspaces.cleanAt(task);
    if(!passed||!unchanged) {
      this.repair(task,'Host verification failed or modified tracked files:\n'+JSON.stringify(results).slice(-50000));
      this.store.finishRun(runId,'failed',results);return;
    }
    this.store.tx(()=>{
      this.resolveIncident(task.id);
      this.release(task,{status:'pending',phase:'review',thread_id:null,attempts:0});
      this.store.finishRun(runId,'done',results);this.store.event('verification.passed',task.id,{sha:task.checkpoint_sha});
    });
  }
  retry(task,error,extra={}) {
    const attempts=task.attempts+1;
    if(attempts>=this.config.maxAttempts) {
      if(this.config.technicalRecovery){this.recoverTechnical(task,error.message,error instanceof IntegrationError?'integration':'execution');return;}
      this.store.block(task,[{prompt:'Повторяющаяся ошибка требует решения',context:error.message,choices:['Исправлено, повторить']}],error.message);return;
    }
    const available_at=this.now()+Math.min(3_600_000,this.config.retryBaseMs*2**(attempts-1));
    this.release(task,{status:'pending',attempts,available_at,feedback:task.feedback+'\nLast attempt: '+error.message,...extra});
    this.store.event('task.retry',task.id,{attempts,available_at,message:error.message});
  }
  repair(task,feedback) {
    const repairs=task.repairs+1;
    if(repairs>=this.config.maxRepairCycles) {
      if(this.config.technicalRecovery){this.recoverTechnical(task,feedback,'quality');return;}
      this.store.tx(()=>{
        this.recordRecovery(task,feedback,'quality');
        this.store.patch(task.id,{phase:'implement',thread_id:null},task.lease);
        this.store.block(task,[{prompt:'Цикл исправлений не прошёл контроль качества; нужен выбор дальнейшего решения.',context:feedback,choices:['Исправить с учётом моего ответа']}],feedback);
      });return;
    }
    this.store.tx(()=>{
      this.recordRecovery(task,feedback,'quality');
      this.release(task,{status:'pending',phase:'implement',repairs,attempts:0,thread_id:null,feedback,available_at:0});
      this.store.event('task.repair',task.id,{repairs,feedback:feedback.slice(-5000)});
    });
  }
  settleMissions() {
    for(const mission of this.store.rows("SELECT * FROM missions WHERE status='active'")) {
      const tasks=this.store.rows('SELECT * FROM tasks WHERE mission_id=?',mission.id);
      const work=tasks.filter(t=>t.kind==='work'&&!t.improvement);
      const finished=work.filter(t=>t.status==='done').length;
      if(this.config.autoImprove && work.length && !tasks.some(t=>t.kind==='retrospective') && (finished>=this.config.retrospectiveEvery||work.every(t=>t.status==='done'))) {
        this.store.addTask({missionId:mission.id,kind:'retrospective',title:'Улучшить процесс по результатам работы',instructions:mission.goal,phase:'retrospective',priority:-1});
        this.store.event('retrospective.created',null,{missionId:mission.id});continue;
      }
      if(tasks.length && tasks.every(t=>t.status==='done')) {
        if(mission.continuous) {
          const previous=this.store.rows("SELECT * FROM tasks WHERE mission_id=? AND kind='assess' ORDER BY created_at DESC,rowid DESC LIMIT 1",mission.id)[0];
          if(!previous || previous.result.tasks?.length) {
            this.store.addTask({missionId:mission.id,kind:'assess',phase:'assess',title:'Проверить прогресс и выбрать следующую порцию работы',instructions:mission.goal,priority:50});
            this.store.event('mission.next_cycle',null,{missionId:mission.id});continue;
          }
        }
        // A remote input can enqueue work after the snapshot above was read.
        this.store.tx(()=>{
          const changed=this.store.db.prepare("UPDATE missions SET status='completed' WHERE id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM tasks WHERE mission_id=? AND status!='done')").run(mission.id,mission.id);
          if(changed.changes)this.store.event('mission.completed',null,{id:mission.id,workspace:mission.workspace,branch:mission.branch});
        });
      }
    }
  }
  recoverTechnical(task,details,kind='execution') {
    const key=`incident:${task.id}`,previous=this.store.get(key),attempts=(previous?.attempts||0)+1;
    const delay=Math.min(3600000,this.config.retryBaseMs*2**Math.min(attempts-1,7));
    const nextAt=this.now()+delay;
    const incident={taskId:task.id,title:task.title,kind,status:'retrying',attempts,nextAt,updatedAt:this.now(),details:details.slice(-12000)};
    this.store.tx(()=>{
      this.recordRecovery(task,details,kind);
      this.store.set(key,incident);
      this.release(task,{status:'pending',phase:task.kind==='work'&&kind!=='integration'?'implement':task.phase,thread_id:null,attempts:0,repairs:0,available_at:nextAt,
        feedback:`AUTOMATIC TECHNICAL RECOVERY #${attempts}. The operator has already authorized project execution. Inspect the actual tool failure and current environment, try a different concrete remedy, then continue the original task. Do not ask the operator to run commands or supply local artifacts. Preserve all quality gates.\n${details.slice(-14000)}`});
      this.store.event('task.recovering',task.id,{kind,attempts,nextAt,message:details.slice(0,300)});
    });
  }
  recordRecovery(task,details,kind) {
    const key=`recovery:${task.id}`,previous=this.store.get(key),count=(previous?.count||0)+1;
    const history=[...(previous?.history||[]),{at:this.now(),phase:task.phase,kind,details:details.slice(0,6000)}].slice(-3);
    this.store.set(key,{count,history,updatedAt:this.now()});
    if(count===2)this.store.event('task.diagnosis_required',task.id,{count,message:'Repeated failure: reproduce the smallest failing case, change the remedy, and verify before repeating broad checks.'});
  }
  resolveIncident(taskId){const key=`incident:${taskId}`,value=this.store.get(key);if(value&&value.status!=='resolved')this.store.set(key,{...value,status:'resolved',updatedAt:this.now()});}
}
