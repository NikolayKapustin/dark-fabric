const $=id=>document.getElementById(id);
const token=document.querySelector('meta[name=operator-token]').content;
let state,selected=null,loading=false,settingsDirty=false;
const drafts=new Map();
const names={pending:'В очереди',running:'В работе',blocked:'Нужен ответ',done:'Готово',active:'Активна',completed:'Завершена',research:'Исследование',plan:'План',implement:'Реализация',verify:'Проверки',review:'Ревью',integrate:'Интеграция',retrospective:'Улучшение',assess:'Следующий этап'};
const eventNames={'factory.settings.updated':'Настройки сохранены','tokens.analyzed':'Анализ расхода токенов','quota.reserve.wait':'Сохраняем резерв лимита','quota.reserve.recovered':'Лимит восстановлен','quota.reserve.interrupted':'Этап сохранён до восстановления лимита','task.claimed':'Начат этап','stage.completed':'Этап завершён','task.integrated':'Интегрировано','verification.passed':'Проверки пройдены','question.created':'Нужен ответ','question.answered':'Ответ сохранён','task.retry':'Повтор запланирован','task.repair':'Исправление','task.recovered':'Восстановлено','quota.wait':'Ожидание лимита','mission.created':'Создана миссия','mission.completed':'Миссия завершена','retrospective.created':'Анализ процесса'};
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function error(message){$('error').textContent=message;$('error').hidden=!message;}
async function api(url,data){const r=await fetch(url,{method:data===undefined?'GET':'POST',headers:{'X-Dark-Fabric-Token':token,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});const result=await r.json();if(!r.ok)throw new Error(result.error||r.statusText);return result;}
const date=value=>new Date(value).toLocaleString('ru-RU',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function detail(){
  const task=state.tasks.find(t=>t.id===selected);if(!task)return;
  const panel=$('task-detail');panel.replaceChildren(el('div',names[task.phase]||task.phase,'eyebrow'),el('h3',task.title),el('p',task.instructions));
  const usage=state.usage?.tasks.find(u=>u.taskId===task.id),assignment=state.usage?.assignments.find(a=>a.taskId===task.id);
  panel.append(el('p','Токены задачи: '+(usage?usage.totalTokens.toLocaleString('ru-RU'):'—')));
  if(assignment)panel.append(el('strong',assignment.agent),el('p',`${assignment.actualModel||assignment.model||'По умолчанию'} · ${assignment.effort||''}`),el('p',assignment.reason));
  panel.append(el('h4','Критерии готовности'));const list=el('ul');for(const c of task.criteria)list.append(el('li',c));panel.append(list);
  if(task.result.summary)panel.append(el('h4','Последний результат'),el('p',task.result.summary));
  if(task.feedback)panel.append(el('h4','Что исправить / учесть'),el('p',task.feedback));
  const checks=state.runs.filter(r=>r.task_id===task.id&&r.phase==='verify');
  if(checks.length){panel.append(el('h4','Проверки'));for(const check of checks.slice(0,2))panel.append(el('p',date(check.started_at)+' · '+check.status),el('pre',JSON.stringify(check.result,null,2)));}
  if(task.depends.length)panel.append(el('h4','Зависимости'),el('p',task.depends.map(id=>state.tasks.find(t=>t.id===id)?.title||id).join('\n')));
  if(task.workspace)panel.append(el('h4','Рабочая копия'),el('code',task.workspace));
  if(task.checkpoint_sha)panel.append(el('h4','Проверяемый commit'),el('code',task.checkpoint_sha));
}
function render(){
  const tasks=state.tasks,open=state.questions.filter(q=>q.answer===null),quota=state.quota;
  $('question-count').textContent=open.length;
  for(const [key,status]of[['active','running'],['pending','pending'],['blocked','blocked'],['done','done']])$(key+'-count').textContent=tasks.filter(t=>t.status===status).length;
  const reserveWait=state.quotaReserve?.blocked;
  const quotaWait=reserveWait||(quota?.blocked&&quota.until>Date.now());
  const budgetWait=state.budget?.day===new Date().toISOString().slice(0,10)&&state.budget.used>=state.dailyTurnLimit;
  $('status').textContent=state.paused?'Очередь приостановлена':quotaWait?'Ожидаем восстановления лимита':budgetWait?'Дневной бюджет исчерпан':tasks.some(t=>t.status==='running')?'Фабрика работает':tasks.some(t=>t.status==='pending')?'Выбираем доступные задачи':open.length?'Ожидаем ваши решения':'Фабрика готова к работе';
  $('status-description').textContent=state.paused?'Текущие этапы завершаются; новые пока не запускаются.':reserveWait?`Сохраняем резерв ${state.quotaReserve.threshold}%. Обращения к Codex приостановлены до подтверждённого восстановления лимита. Локальные проверки продолжаются.`:quotaWait?`Следующая проверка ${date((quota.checkedAt||quota.observedAt)+state.quotaPollMs)}. Локальные проверки продолжаются.`:budgetWait?'Новые обращения к Codex продолжатся после 00:00 UTC.':open.length?`${open.length} вопросов сохранено. Независимые задачи могут продолжаться.`:'Задачи и результаты сохраняются в локальной базе.';
  $('status-dot').className='dot'+(quotaWait||state.paused||open.length?' wait':'');
  $('updated').textContent='Обновлено '+new Date().toLocaleTimeString('ru-RU');
  $('pause').textContent=state.paused?'Продолжить работу':'Приостановить очередь';
  $('budget').textContent=state.budget?`Обращений к Codex за ${state.budget.day}: ${state.budget.used}`:'';
  if(!$('questions').contains(document.activeElement)){
    $('questions').replaceChildren();
    if(!open.length)$('questions').append(el('div','Открытых вопросов нет. Можно вернуться позже.','empty'));
    for(const q of open){
      const card=el('article',undefined,'question');card.append(el('div',q.title,'eyebrow'),el('h3',q.prompt));
      if(q.context){const details=el('details');details.append(el('summary','Контекст решения'),el('pre',q.context));card.append(details);}
      const form=el('form'),input=el('textarea');input.required=true;input.maxLength=20000;input.placeholder='Ваш ответ или уточнение…';input.setAttribute('aria-label','Ответ: '+q.prompt);input.value=drafts.get(q.id)||'';input.oninput=()=>drafts.set(q.id,input.value);
      if(q.choices.length){const options=el('div',undefined,'options');for(const c of q.choices){const b=el('button',c);b.type='button';b.onclick=()=>{input.value=c;drafts.set(q.id,c);input.focus();};options.append(b);}card.append(options);}
      const submit=el('button','Сохранить ответ','primary');submit.type='submit';form.append(input,submit);form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{await api('/api/answers',{id:q.id,answer:input.value});drafts.delete(q.id);document.activeElement.blur();await refresh();}catch(err){error(err.message);}finally{submit.disabled=false;}};card.append(form);$('questions').append(card);
    }
  }
  $('missions').replaceChildren();
  for(const m of state.missions){const card=el('div',undefined,'mission');card.append(el('strong',`${state.projects.find(p=>p.id===m.project_id)?.name||'Проект'} · ${names[m.status]||m.status}${m.continuous?' · Непрерывный цикл':''}`),el('p',m.goal.split('\n')[0]),el('code',`Результат: ${m.workspace}`));$('missions').append(card);}
  $('tasks').replaceChildren();$('empty-work').hidden=!!tasks.length;
  for(const task of tasks){const row=el('tr',undefined,task.id===selected?'selected':'');row.tabIndex=0;const status=el('td');status.append(el('span',names[task.status]||task.status,'badge '+task.status));row.append(el('td',task.title),el('td',names[task.phase]||task.phase),status);const select=()=>{selected=task.id;render();};row.onclick=select;row.onkeydown=e=>{if(e.key==='Enter')select();};$('tasks').append(row);}
  resources();detail();renderSettings();$('events').replaceChildren();
  for(const event of state.events.slice(0,30)){const line=el('div',undefined,'event');const description=state.tasks.find(t=>t.id===event.task_id)?.title||event.data.check&&`${event.data.check}: ${event.data.code===0?'успешно':'ошибка'}`||event.data.goal||event.data.message||'';line.append(el('time',date(event.at)),el('strong',eventNames[event.type]||event.type),el('span',description.slice(0,200)));$('events').append(line);}
  const current=$('project').value;$('project').replaceChildren();for(const p of state.projects){const o=el('option',p.name);o.value=p.id;$('project').append(o);}if(current)$('project').value=current;
}
async function refresh(){if(loading)return;loading=true;try{state=await api('/api/state');error('');render();}catch(e){error('Нет связи с фабрикой: '+e.message);}finally{loading=false;}}
$('pause').onclick=async()=>{try{await api('/api/pause',{paused:!state.paused});await refresh();}catch(e){error(e.message);}};
$('new-mission').onclick=()=>{$('mission-form').hidden=!$('mission-form').hidden;};
$('mission-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('/api/missions',{projectId:$('project').value,goal:$('goal').value});$('goal').value='';$('mission-form').hidden=true;await refresh();}catch(err){error(err.message);}finally{button.disabled=false;}};
$('settings-form').oninput=()=>{settingsDirty=true;$('settings-message').textContent='';};
$('settings-form').onsubmit=async e=>{
 e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
 try{await api('/api/settings',{quotaReservePercent:Number($('quota-reserve').value),tokenAnalysisEnabled:$('token-analysis-enabled').checked,tokenAnalysisIntervalHours:Number($('token-analysis-hours').value)});settingsDirty=false;$('settings-message').textContent='Настройки сохранены';await refresh();}
 catch(err){error(err.message);}finally{button.disabled=false;}
};
void refresh();setInterval(refresh,5000);

function renderSettings(){
 const s=state.settings,a=state.tokenAnalysis;if(!s||!a)return;
 if(!settingsDirty){$('quota-reserve').value=s.quotaReservePercent;$('token-analysis-enabled').checked=s.tokenAnalysisEnabled;$('token-analysis-hours').value=s.tokenAnalysisIntervalHours;}
 $('token-analysis-status').textContent=a.enabled?(a.nextAt?'Следующий анализ: '+date(a.nextAt):'Первый анализ — при следующем проходе работающей очереди.'):'Создание периодических задач выключено. Уже созданные задачи остаются в очереди.';
 const box=$('token-analysis-reports');box.replaceChildren();
 if(!a.reports.length)box.append(el('p','Отчётов пока нет. Анализ использует новые завершённые сессии с измеренным расходом токенов.'));
 for(const item of a.reports){
   const r=item.report,task=state.tasks.find(t=>t.id===item.task_id),card=el('article',undefined,'mission');
   card.append(el('strong','Анализ сессий · '+date(item.created_at)),el('p',`Сессий: ${r.sessionCount} · запусков: ${r.runCount} · ${r.totals.totalTokens.toLocaleString('ru-RU')} токенов`),el('p',`Неуспешных запусков: ${r.failedRuns}. Доля кэшированного входа: ${r.cacheHitPercent===null?'—':r.cacheHitPercent+'%'}. Частичных измерений: ${r.partialRuns}.`));
   if(task){const link=el('button','Открыть задачу анализа','quiet');link.onclick=()=>{selected=task.id;render();$('task-detail').scrollIntoView({behavior:'smooth'});};card.append(link,el('p',task.result?.summary||names[task.status]||task.status));}
   else card.append(el('p','Проект завершён: сохранён локальный отчёт без нового обращения к Codex.'));
   box.append(card);
 }
}

function resources(){
 const u=state.usage,q=state.quota,fmt=n=>Number.isFinite(n)?n.toLocaleString('ru-RU'):'—';
 const cards=$('resource-metrics');cards.replaceChildren();
 const turns=state.budget?.day===new Date().toISOString().slice(0,10)?state.budget.used:0;
 for(const [label,value] of [[`Токены сегодня · ${u?.timeZone||'UTC'}`,u?.known?fmt(u.today.totalTokens):'—'],['Всего учтено токенов',u?.known?fmt(u.total.totalTokens):'—'],['Осталось запусков сегодня',fmt(Math.max(0,state.dailyTurnLimit-turns))]]){const card=el('article');card.append(el('span',label),el('strong',value));cards.append(card);}
 const box=$('resource-details');box.replaceChildren();
 for(const key of ['primary','secondary']){const w=q?.[key];if(!w)continue;const remaining=Number.isFinite(w.usedPercent)?Math.max(0,100-w.usedPercent):null;box.append(el('p','Лимит аккаунта · '+w.windowDurationMins+' мин: осталось '+(remaining===null?'—':fmt(remaining)+'%')+' · сброс '+(w.resetsAt?date(w.resetsAt*1000):'неизвестен')));const bar=el('progress');bar.max=100;if(remaining!==null)bar.value=remaining;bar.setAttribute('aria-label','Остаток лимита');box.append(bar);}
 box.append(el('p','Лимит общий для аккаунта. Остаток в токенах сервис не сообщает. '+(q?.observedAt?'Данные: '+date(q.observedAt):'Нет измерений.')));
 if(!q?.known||Date.now()-(q?.observedAt||0)>(state.quotaPollMs||300000)+15000)box.append(el('p','Данные лимита требуют обновления.'));
 if(u?.known)box.append(el('p','Вход: '+fmt(u.total.inputTokens)+' · кэш (в составе входа): '+fmt(u.total.cachedInputTokens)+' · выход: '+fmt(u.total.outputTokens)+' · рассуждение (в составе выхода): '+fmt(u.total.reasoningOutputTokens)));
 if(u?.coverage)box.append(el('p','Учтено запусков: '+u.coverage.trackedRuns+' / '+u.coverage.modelRuns+(u.coverage.partialRuns?' · часть истории неполная':'')));
 const a=u?.assignments.find(x=>x.status==='running');if(a)box.append(el('strong',a.agent),el('p',(a.actualModel||a.model||'Модель по умолчанию')+' · '+(a.effort||'')),el('p',a.reason));
}
