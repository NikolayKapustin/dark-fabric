import {quotaReserve,settingsDefaults} from './settings.js';
const brief=t=>t?{id:t.id,title:t.title.slice(0,300),phase:t.phase,status:t.status}:null;
export function factoryActivity(snapshot,config,incidents=[],now=Date.now()){
  const tasks=snapshot.tasks,byId=new Map(tasks.map(t=>[t.id,t])),activeMissions=new Set(snapshot.missions.filter(m=>m.status==='active').map(m=>m.id));
  const projectOf=t=>snapshot.projects?.find(p=>p.id===snapshot.missions.find(m=>m.id===t.mission_id)?.project_id);
  const pending=tasks.filter(t=>t.status==='pending'&&activeMissions.has(t.mission_id)&&!projectOf(t)?.paused&&(!projectOf(t)?.discovery_required||t.kind==='discovery'));
  const dependencyReady=t=>t.depends.every(id=>byId.get(id)?.status==='done');
  const virtual=t=>Math.max(projectOf(t)?.virtual_time||0,snapshot.schedulingClock||0);
  const running=tasks.find(t=>t.status==='running');
  const waiting=pending.filter(dependencyReady).sort((a,b)=>(a.available_at>now)-(b.available_at>now)||virtual(a)-virtual(b)||(projectOf(b)?.priority||3)-(projectOf(a)?.priority||3)||b.priority-a.priority||a.available_at-b.available_at);
  const current=running||waiting[0]||pending[0]||tasks.find(t=>t.status==='blocked');
  const incident=incidents.find(i=>i.taskId===current?.id&&i.status!=='resolved');
  const last=tasks.filter(t=>t.kind==='work'&&t.status==='done').sort((a,b)=>b.updated_at-a.updated_at)[0];
  const next=current?pending.find(t=>t.id!==current.id&&t.depends.includes(current.id))||waiting.find(t=>t.id!==current.id):null;
  let state='idle',reason='Нет доступных задач.';
  if(snapshot.paused){state='paused';reason='Очередь приостановлена оператором.';}
  else if(quotaReserve(snapshot.quota,{...settingsDefaults,...config}).blocked&&(!running||!['verify','integrate'].includes(running.phase))){state='quota';reason=`Сохраняем резерв лимита ${config.quotaReservePercent??settingsDefaults.quotaReservePercent}%. Обращения к Codex приостановлены до подтверждённого восстановления квоты.`;}
  else if(running){state='running';reason='Исполнитель выполняет текущий этап.';}
  else if(snapshot.quota?.blocked&&snapshot.quota.until>now){state='quota';reason='Ожидание восстановления лимита Codex.';}
  else if(snapshot.budget?.day===new Date(now).toISOString().slice(0,10)&&snapshot.budget.used>=config.dailyTurnLimit){state='budget';reason='Достигнут суточный бюджет фабрики; продолжение после 00:00 UTC.';}
  else if(waiting[0]?.available_at>now){state='retrying';reason=incident?`Техническая задача не завершена. Повторов: ${incident.attempts}. Ожидается следующая попытка.`:'Повтор задачи отложен после ошибки.';}
  else if(waiting.length){state='queued';reason='Следующая задача готова к запуску.';}
  else if(pending.length){state='dependencies';reason='Следующие задачи ждут завершения зависимостей; самостоятельного продвижения сейчас нет.';}
  else if(tasks.some(t=>t.status==='blocked')){state='blocked';reason='Требуется ответ на продуктовый вопрос.';}
  else if(snapshot.missions.length&&snapshot.missions.every(m=>m.status==='completed')){state='completed';reason='Все миссии завершены.';}
  return {state,reason,current:brief(current),next:brief(next),retryAt:state==='retrying'?waiting[0].available_at:null,
    startedAt:running?snapshot.runs.find(r=>r.task_id===running.id&&r.status==='running')?.started_at:null,
    lastDelivered:last?{...brief(last),at:last.updated_at,summary:(last.result?.summary||'').slice(0,1000)}:null,
    work:{done:tasks.filter(t=>t.kind==='work'&&t.status==='done').length,total:tasks.filter(t=>t.kind==='work').length}};
}
