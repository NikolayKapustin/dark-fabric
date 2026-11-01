import {factoryActivity} from './activity.js';
import {projectRoadmap} from './roadmap.js';
import {metricHash} from './projects.js';

export function portfolioSnapshot(store,snapshot,config,incidents){
  const projects=snapshot.projects.slice(0,20).map(p=>{
    const missions=snapshot.missions.filter(m=>m.project_id===p.id),missionIds=new Set(missions.map(m=>m.id));
    const tasks=snapshot.tasks.filter(t=>missionIds.has(t.mission_id)),ids=new Set(tasks.map(t=>t.id));
    const discovery=tasks.filter(t=>t.kind==='discovery').sort((a,b)=>b.created_at-a.created_at)[0];
    const {evidence=[],summary='',...fields}=p.profile||{};
    const profile={...fields,...(fields.domain?{summary:summary.slice(0,2000),evidence:evidence.slice(0,8).map(e=>({source:e.source.slice(0,600),finding:e.finding.slice(0,600)}))}:{})};
    const measurements=store.rows('SELECT * FROM project_metrics WHERE project_id=?',p.id).filter(m=>profile.metrics?.some(d=>d.id===m.metric_id&&metricHash(d)===m.definition_hash));
    const tokens=store.rows('SELECT u.usage_json FROM run_usage u JOIN runs r ON r.id=u.run_id JOIN tasks t ON t.id=r.task_id JOIN missions m ON m.id=t.mission_id WHERE m.project_id=?',p.id).reduce((n,r)=>n+r.usage.totalTokens,0);
    return {id:p.id,name:p.name,priority:p.priority,paused:!!p.paused,profile,measurements,tokens,
      inputCount:store.row('SELECT count(*) n FROM mission_inputs i JOIN missions m ON m.id=i.mission_id WHERE m.project_id=?',p.id).n,
      questionCount:snapshot.questions.filter(q=>missionIds.has(q.mission_id)&&q.answer===null).length,
      discovery:discovery?{taskId:discovery.id,status:discovery.status,phase:discovery.phase,summary:discovery.result?.summary?.slice(0,2000)||''}:null,
      counts:Object.fromEntries(['pending','running','blocked','done'].map(k=>[k,tasks.filter(t=>t.status===k).length])),
      activity:factoryActivity({...snapshot,projects:[p],missions,tasks,runs:snapshot.runs.filter(r=>ids.has(r.task_id)),paused:snapshot.paused||!!p.paused},config,incidents),
      roadmap:missions.length?projectRoadmap(missions.find(m=>m.status==='active')||missions[0],tasks,p):null};
  });
  const intakes=store.rows("SELECT * FROM project_intakes ORDER BY created_at DESC LIMIT 20").map(r=>({id:r.id,name:r.payload.name,status:r.status,error:r.error,availableAt:r.available_at,createdAt:r.created_at}));
  return {projects,intakes,totalProjects:snapshot.projects.length};
}
