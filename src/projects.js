import path from 'node:path';
import {existsSync,mkdirSync,writeFileSync,readFileSync,realpathSync,readdirSync,lstatSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {git,Workspaces,contained} from './git.js';

export function initProjects(db){
  const columns=db.pragma('table_info(projects)').map(c=>c.name);
  for(const [name,type] of Object.entries({priority:'INTEGER NOT NULL DEFAULT 3',paused:'INTEGER NOT NULL DEFAULT 0',virtual_time:'REAL NOT NULL DEFAULT 0',discovery_required:'INTEGER NOT NULL DEFAULT 0',profile_json:"TEXT NOT NULL DEFAULT '{}'",discovery_json:"TEXT NOT NULL DEFAULT '{}'"}))if(!columns.includes(name))db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS project_intakes(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS project_metrics(project_id TEXT NOT NULL REFERENCES projects(id),metric_id TEXT NOT NULL,value REAL NOT NULL,source TEXT NOT NULL,note TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),checkpoint TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(project_id,metric_id));`);
  if(!db.pragma('table_info(project_metrics)').some(c=>c.name==='definition_hash'))db.exec("ALTER TABLE project_metrics ADD COLUMN definition_hash TEXT NOT NULL DEFAULT ''");
}
export function validateProjectRequest(value){
  if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>100||typeof value.goal!=='string'||!value.goal.trim()||value.goal.length>12000||!Number.isInteger(value.priority)||value.priority<1||value.priority>5)throw Error('Укажите название, описание до 12000 символов и приоритет 1–5.');
  return {name:value.name.trim(),goal:value.goal.trim(),priority:value.priority};
}
export function requestProject(store,id,payload,now=Date.now()){
  return store.tx(()=>{
  payload=validateProjectRequest(payload);
  if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid project request id');
  if(store.row("SELECT (SELECT count(*) FROM projects)+(SELECT count(*) FROM project_intakes WHERE status!='done') n").n>=20)throw Error('Достигнут предел 20 проектов.');
  store.db.prepare('INSERT INTO project_intakes(id,mission_id,payload_json,created_at) VALUES (?,?,?,?)').run(id,randomUUID(),JSON.stringify(payload),now);
  store.event('project.requested',null,{projectId:id,message:payload.name});
  });
}
export function updateProject(store,{id,priority,paused}){
  if(!store.project(id))throw Error('Проект не найден.');
  if(priority!==undefined&&(!Number.isInteger(priority)||priority<1||priority>5))throw Error('Приоритет: 1–5.');
  if(paused!==undefined&&typeof paused!=='boolean')throw Error('Некорректная пауза проекта.');
  if(priority===undefined&&paused===undefined)throw Error('Нет изменений.');
  store.tx(()=>{
    const p=store.project(id),floor=Math.max(p.virtual_time,store.get('scheduler.virtualTime',0));
    store.db.prepare('UPDATE projects SET priority=?,paused=?,virtual_time=? WHERE id=?').run(priority??p.priority,paused===undefined?p.paused:Number(paused),Math.max(0,floor),id);
    store.event('project.updated',null,{projectId:id,priority:priority??p.priority,paused:paused??!!p.paused});
  });
}
export function queueDiscovery(store,projectId){
  return store.tx(()=>{
    const project=store.project(projectId);if(!project)throw Error('Проект не найден.');
    const mission=store.row("SELECT * FROM missions WHERE project_id=? AND status='active' ORDER BY created_at DESC LIMIT 1",projectId);
    if(!mission)throw Error('Нет активной миссии для discovery.');
    const existing=store.row("SELECT t.* FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE m.project_id=? AND t.kind='discovery' AND t.status!='done'",projectId);
    if(existing)return existing;
    if(!project.profile?.reviewedAt)store.db.prepare('UPDATE projects SET discovery_required=1 WHERE id=?').run(projectId);
    return store.addTask({missionId:mission.id,kind:'discovery',phase:'discover',priority:110,title:'Discovery: продукт, домен, метрики и план',instructions:mission.goal});
  });
}

// External Git operations use durable IDs and are replayed before the single
// DB commit. Only the factory worker provisions; the bridge only enqueues.
export async function provisionProject(store,config,intake,{signal}={}){
  const target=contained(config.root,path.join(config.root,'projects',intake.id));
  mkdirSync(target,{recursive:true});contained(realpathSync(config.root),realpathSync(target));
  const marker=path.join(target,'.factory-project.json');
  if(lstatSync(target).isSymbolicLink()||(!existsSync(marker)&&readdirSync(target).length))throw Error('Refusing an unowned project directory');
  if(existsSync(marker)&&JSON.parse(readFileSync(marker,'utf8')).id!==intake.id)throw Error('Project workspace identity mismatch');
  if(!existsSync(marker))writeFileSync(marker,JSON.stringify({id:intake.id}),{flag:'wx'});
  const options={signal,timeoutMs:30000};
  if(!existsSync(path.join(target,'.git')))await git(target,['init','-b','main'],options);
  const head=await git(target,['rev-parse','--verify','HEAD'],{...options,allowFailure:true});
  if(head.code!==0){
    // The directory is new and not exposed to agents until provisioning commits.
    writeFileSync(path.join(target,'PROJECT_BRIEF.md'),`# ${intake.payload.name}\n\n${intake.payload.goal}\n`);
    writeFileSync(path.join(target,'.gitignore'),'node_modules/\n.darkfabric/\n.godot/\nbin/\nobj/\n.env\n.env.*\n*.log\n');
    await git(target,['add','--all'],options);
    await git(target,['-c','user.name=Dark Fabric','-c','user.email=dark-fabric@localhost','commit','-m','Initialize project brief for discovery'],options);
  }
  const workspace=await new Workspaces(config.root).mission(target,intake.mission_id);
  store.tx(()=>{
    if(!store.project(intake.id))store.addProject({id:intake.id,name:intake.payload.name,path:target,priority:intake.payload.priority,checks:[{name:'Project tests',command:['npm','run','test'],timeoutMs:300000},{name:'Project checks',command:['npm','run','check'],timeoutMs:300000}]});
    if(!store.mission(intake.mission_id))store.addMission({id:intake.mission_id,projectId:intake.id,goal:intake.payload.goal,continuous:true,discovery:true,...workspace});
    store.db.prepare("UPDATE project_intakes SET status='done',error=NULL WHERE id=?").run(intake.id);
    store.event('project.created',null,{projectId:intake.id,message:intake.payload.name});
  });
}
export async function processProjectIntake(store,config,options={}){
  const intake=store.row("SELECT * FROM project_intakes WHERE status!='done' AND available_at<=? ORDER BY created_at LIMIT 1",Date.now());
  if(!intake)return;
  try{await provisionProject(store,config,intake,options);}
  catch(error){
    const attempts=intake.attempts+1,available=Date.now()+Math.min(3600000,30000*2**Math.min(attempts-1,7));
    store.db.prepare("UPDATE project_intakes SET status='retrying',attempts=?,available_at=?,error=? WHERE id=?").run(attempts,available,String(error.message).slice(0,500),intake.id);
    store.event('project.retry',null,{projectId:intake.id,message:'Подготовка проекта будет повторена автоматически.'});
  }
}

export function recordProjectMetrics(store,project,task,result,now=Date.now()){
  for(const measurement of result.measurements||[]){
    const definition=project.profile?.metrics?.find(m=>m.id===measurement.id),hash=definition&&metricHash(definition);
    if(hash&&result.metricDefinitions?.[measurement.id]===hash)store.db.prepare(`INSERT INTO project_metrics VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,metric_id) DO UPDATE SET value=excluded.value,source=excluded.source,note=excluded.note,task_id=excluded.task_id,checkpoint=excluded.checkpoint,at=excluded.at,definition_hash=excluded.definition_hash`).run(project.id,measurement.id,measurement.value,measurement.source,measurement.note,task.id,task.checkpoint_sha,now,hash);
  }
}
export const metricHash=m=>createHash('sha256').update(JSON.stringify([m.id,m.label,m.unit,m.target,m.method])).digest('hex');
