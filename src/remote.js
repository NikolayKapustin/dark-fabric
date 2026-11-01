import { createHash } from 'node:crypto';
import { factoryActivity } from './activity.js';
import { usageSnapshot } from './telemetry.js';
import { acceptInput,inputSnapshot } from './inputs.js';
import {requestProject,updateProject,queueDiscovery} from './projects.js';
import {portfolioSnapshot} from './portfolio.js';
import {factorySettings,quotaReserve} from './settings.js';

const text=(value,max=20000)=>String(value??'').slice(0,max);
function compactRoadmap(roadmap,budget=24000){
  if(!roadmap)return;
  const nodes=roadmap.nodes;roadmap.totalNodes??=Object.keys(nodes).length;
  roadmap.totalQueue??=Object.values(nodes).filter(n=>n.kind==='task').length;
  for(const node of Object.values(nodes)){
    node.title=text(node.title,140);node.body=text(node.body,180);node.summary=text(node.summary,180);
    if(node.criteria)node.criteria=node.criteria.slice(0,3).map(c=>text(c,100));
    if(node.depends)node.depends=node.depends.slice(0,8);node.excerpt=true;
  }
  while(Buffer.byteLength(JSON.stringify(roadmap))>budget){
    const leaves=Object.values(nodes).filter(n=>!roadmap.roots.includes(n.id)&&n.id!=='queue'&&n.status!=='running'&&!n.children?.length);
    const node=leaves.sort((a,b)=>(a.kind!=='task')-(b.kind!=='task')||(a.status!=='done')-(b.status!=='done'))[0];
    if(!node)break;
    delete nodes[node.id];
    for(const parent of Object.values(nodes))if(parent.children?.includes(node.id)){parent.children=parent.children.filter(id=>id!==node.id);parent.omittedChildren=(parent.omittedChildren||0)+1;}
  }
  roadmap.shownQueue=Object.values(nodes).filter(n=>n.kind==='task').length;
  roadmap.excerpt=Object.keys(nodes).length<roadmap.totalNodes;
}
// Explicit projection: no credentials, quality command arguments or raw tool logs.
export function remoteSnapshot(store,config) {
  config={...config,...factorySettings(store,config)};
  const s=store.snapshot();
  const incidents=store.rows("SELECT value FROM meta WHERE key LIKE 'incident:%'").map(row=>JSON.parse(row.value)).filter(i=>i.status!=='resolved');
  const portfolio=portfolioSnapshot(store,s,config,incidents);
  const questions=s.questions.filter(q=>q.answer===null).slice(0,50);
  const protectedIds=new Set([...s.tasks.filter(t=>t.status==='running').map(t=>t.id),...portfolio.projects.map(p=>p.activity.current?.id).filter(Boolean),...questions.map(q=>q.task_id)]);
  const tasks=s.tasks.filter(t=>protectedIds.has(t.id)),selected=new Set(tasks.map(t=>t.id));
  const ordered=[...s.tasks.filter(t=>t.status!=='done'),...s.tasks.filter(t=>t.status==='done').sort((a,b)=>b.updated_at-a.updated_at)];
  const buckets=portfolio.projects.map(p=>ordered.filter(t=>s.missions.find(m=>m.id===t.mission_id)?.project_id===p.id&&!selected.has(t.id)));
  while(tasks.length<150&&buckets.some(b=>b.length))for(const bucket of buckets)if(bucket.length&&tasks.length<150)tasks.push(bucket.shift());
  const missionIds=new Set(tasks.map(t=>t.mission_id));
  const missions=[...s.missions.filter(m=>missionIds.has(m.id)),...s.missions.filter(m=>!missionIds.has(m.id))].slice(0,Math.max(50,missionIds.size));
  const snapshot={
    generatedAt:Date.now(),dailyTurnLimit:config.dailyTurnLimit,quotaPollMs:config.quotaPollMs,
    settings:factorySettings(store,config),quotaReserve:quotaReserve(s.quota,config),
    usage:usageSnapshot(store),
    inputs:inputSnapshot(store),inputCount:store.row('SELECT COUNT(*) n FROM mission_inputs').n,
    executionAccess:config.executionAccess,
    roadmap:portfolio.projects.length===1?portfolio.projects[0].roadmap:null,intakes:portfolio.intakes,totalProjects:portfolio.totalProjects,
    activity:factoryActivity(s,config,incidents),
    incidents:incidents.slice(0,20).map(i=>({taskId:i.taskId,title:text(i.title,300),kind:i.kind,status:i.status,attempts:i.attempts,nextAt:i.nextAt})),
    taskCounts:Object.fromEntries(['pending','running','blocked','done'].map(status=>[status,s.tasks.filter(t=>t.status===status).length])),
    totalTasks:s.tasks.length,totalQuestions:s.questions.filter(q=>q.answer===null).length,
    heartbeat:s.heartbeat,paused:s.paused,quota:s.quota,budget:s.budget,
    projects:portfolio.projects,
    missions:missions.map(m=>({id:m.id,project_id:m.project_id,goal:text(m.goal,2000),status:m.status,continuous:m.continuous,workspace:m.workspace})),
    tasks:tasks.map(t=>({id:t.id,mission_id:t.mission_id,title:text(t.title,300),status:t.status,phase:t.phase,instructions:text(t.instructions,6000),criteria:t.criteria.slice(0,15).map(c=>text(c,500)),depends:t.depends,feedback:text(t.feedback,6000),checkpoint_sha:t.checkpoint_sha,result:{summary:text(t.result?.summary,6000)}})),
    questions:questions.map(q=>({id:q.id,task_id:q.task_id,mission_id:q.mission_id,title:text(q.title,300),prompt:text(q.prompt,3000),context:text(q.context,3000),choices:q.choices.slice(0,8).map(c=>text(c,500)),answer:null})),
    events:s.events.slice(0,30).map(e=>({id:e.id,at:e.at,type:e.type,task_id:e.task_id,data:{projectId:e.data.projectId,message:text(e.data.message,500),check:text(e.data.check,200),code:e.data.code}})),
    runs:s.runs.slice(0,30).map(r=>({id:r.id,task_id:r.task_id,phase:r.phase,status:r.status,started_at:r.started_at,finished_at:r.finished_at})),
  };
  // Keep long-running factories within D1's row limit; retain full history locally.
  if(Buffer.byteLength(JSON.stringify(snapshot))>1100000){
    const short=(value,width=180)=>typeof value==='string'?text(value,width):Array.isArray(value)?value.map(v=>short(v,width)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,['id','domain','theme'].includes(k)?v:short(v,width)])):value;
    for(const project of snapshot.projects){project.profile=short(project.profile);project.excerpt=true;
      compactRoadmap(project.roadmap);
    }
    for(const input of snapshot.inputs){input.truncated=input.body.length>1000;input.body=text(input.body,1000);}
    for(const task of snapshot.tasks){task.instructions=text(task.instructions,700);task.feedback=text(task.feedback,700);task.result.summary=text(task.result.summary,700);task.criteria=task.criteria.slice(0,5).map(c=>text(c,150));task.depends=task.depends.slice(0,40);task.excerpt=true;}
    for(const q of snapshot.questions){q.prompt=text(q.prompt,1500);q.context=text(q.context,500);q.choices=q.choices.slice(0,5).map(c=>text(c,200));q.excerpt=true;}
    for(const m of snapshot.missions)m.goal=text(m.goal,300);
    while(Buffer.byteLength(JSON.stringify(snapshot))>1100000){const index=snapshot.tasks.findLastIndex(t=>!protectedIds.has(t.id));if(index<0)break;snapshot.tasks.splice(index,1);}
    if(Buffer.byteLength(JSON.stringify(snapshot))>1100000)for(const project of snapshot.projects)compactRoadmap(project.roadmap,6000);
    // UTF-8 bytes, not character counts: twenty complete CJK profiles and their
    // measurements must also fit. Keep metric IDs, values and timestamps exact.
    for(const width of [100,60,30]){
      if(Buffer.byteLength(JSON.stringify(snapshot))<=1100000)break;
      for(const project of snapshot.projects){
        project.profile=short(project.profile,width);
        for(const m of project.measurements){m.source=text(m.source,width);m.note=text(m.note,width);m.excerpt=true;}
      }
      for(const task of snapshot.tasks){task.instructions=text(task.instructions,width*2);task.feedback=text(task.feedback,width*2);task.result.summary=text(task.result.summary,width*2);task.criteria=task.criteria.slice(0,3).map(c=>text(c,width));task.excerpt=true;}
      for(const q of snapshot.questions){q.prompt=text(q.prompt,width*3);q.context=text(q.context,width);q.choices=q.choices.slice(0,5).map(c=>text(c,width));q.excerpt=true;}
      for(const input of snapshot.inputs){input.body=text(input.body,width*3);input.truncated=true;}
    }
    snapshot.compact=true;
  }
  return snapshot;
}

export function applyRemoteCommand(store,command,now=Date.now()) {
  if(!command||!/^[-a-zA-Z0-9]{16,80}$/.test(command.id))throw new Error('Invalid command ID');
  const key=`remote.receipt:${command.id}`;
  const fingerprint=createHash('sha256').update(JSON.stringify([command.kind,command.payload])).digest('hex');
  return store.tx(()=>{
    const previous=store.get(key);
    if(previous){if(previous.fingerprint!==fingerprint)throw new Error('Command ID conflict');return previous;}
    let receipt;
    try{
      if(!Number.isFinite(command.createdAt)||command.createdAt>now+300000||now-command.createdAt>7*86400000)throw new Error('Команда устарела. Отправьте её снова.');
      if(command.kind==='answer') {
        store.answer(command.payload?.id,command.payload?.answer);
      } else if(command.kind==='input') {
        acceptInput(store,{id:command.id,missionId:command.payload?.missionId,body:command.payload?.body,createdAt:command.createdAt});
      } else if(command.kind==='project.create') {
        requestProject(store,command.id,command.payload);
      } else if(command.kind==='project.update') {
        updateProject(store,command.payload||{});
      } else if(command.kind==='project.discover') {
        queueDiscovery(store,command.payload?.id);
      } else if(command.kind==='pause') {
        if(typeof command.payload?.paused!=='boolean')throw new Error('Invalid pause value');
        store.set('paused',command.payload.paused);
        store.event(command.payload.paused?'factory.paused':'factory.resumed',null,{source:'remote',commandId:command.id});
      } else throw new Error('Remote operation is not allowed');
      receipt={id:command.id,fingerprint,status:'applied',message:command.kind==='input'?'Вводные сохранены. Разбор поставлен в очередь.':'Выполнено',at:now};
    }catch(e){receipt={id:command.id,fingerprint,status:'rejected',message:text(e.message,500),at:now};}
    // The effect and receipt commit together, including nested answer/unblock changes.
    store.set(key,receipt);
    return receipt;
  });
}

export function validateRemoteConfig(value) {
  const url=new URL(value.url);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Remote URL must be an HTTPS origin');
  if(!url.hostname.endsWith('.chatgpt.site'))throw new Error('Only the configured Sites service is supported');
  for(const name of ['serviceToken','bridgeToken'])if(typeof value[name]!=='string'||value[name].length<32)throw new Error(`Missing ${name}`);
  return {...value,url:url.origin};
}

export class RemoteBridge {
  constructor(store,config,remote,{fetcher=fetch}={}){this.store=store;this.config=config;this.remote=validateRemoteConfig(remote);this.fetcher=fetcher;this.receipts=[];}
  async sync() {
    const snapshot=remoteSnapshot(this.store,this.config);
    const response=await this.fetcher(`${this.remote.url}/api/bridge/sync`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),
      headers:{'Content-Type':'application/json','OAI-Sites-Authorization':`Bearer ${this.remote.serviceToken}`,'X-Dark-Fabric-Bridge':this.remote.bridgeToken},
      body:JSON.stringify({snapshot,receipts:this.receipts}),
    });
    if(!response.ok)throw new Error(`Remote service returned HTTP ${response.status}`);
    const result=await response.json();
    if(!Array.isArray(result.commands)||result.commands.length>30)throw new Error('Invalid remote response');
    this.receipts=[];
    // Do not change decisions while the local factory is stopped. They remain queued.
    const live=snapshot.heartbeat?.pid&&!snapshot.heartbeat.stopped&&Date.now()-snapshot.heartbeat.at<60000;
    if(live)for(const command of result.commands)this.receipts.push(applyRemoteCommand(this.store,command,Number.isFinite(result.storedAt)?result.storedAt:Date.now()));
    this.store.set('remote.status',{url:this.remote.url,at:Date.now(),ok:true,queued:result.commands.length});
    return {applied:this.receipts.length};
  }
}
