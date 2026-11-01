import { createHash } from 'node:crypto';

const domains=[
  ['godot','Godot / игровой процесс',/godot|игр|гейм|боев|дрон|маршрут|gameplay/i,'Inspect scene lifecycle, collisions, input, saves and genuine engine playtests.'],
  ['web','Веб-интерфейс',/react|frontend|интерфейс|портал|dashboard|html|css/i,'Check responsive layout, accessibility, real data and browser behavior.'],
  ['data','Данные и надёжность',/sqlite|database|миграц|scheduler|очеред|протокол|баз[аы] данных/i,'Check transactional state, concurrency, migration compatibility and crash recovery.'],
];
const roles={discover:'Продуктовый исследователь',discovery_review:'Ревьюер discovery',research:'Исследователь',plan:'Архитектор',assess:'Планировщик',review:'Независимый ревьюер',retrospective:'Инженер улучшений',implement:'Разработчик'};

function modelPolicy(task,recovery){
  const repeated=(recovery?.count||0)>=2||task.repairs>=2||task.attempts>=2;
  if(repeated)return {model:'gpt-6-astra',effort:'high',reason:'Повторные неудачи: усиленная диагностика Astra.'};
  if(['review','discovery_review'].includes(task.phase))return {model:'gpt-6-astra',effort:'high',reason:'Итоговое независимое ревью: Astra в отдельной сессии.'};
  if(['discover','research','plan','assess','retrospective'].includes(task.phase))return {model:'gpt-6-astra',effort:'high',reason:'Исследование, планирование и оценка решений: Astra.'};
  const content=[task.title,task.instructions,...task.criteria].join('\n');
  const consequential=/безопасност|авторизац|аутентификац|миграц|транзакц|конкурент|коллизи|физик|боев|сохранени|совместимост|потер[яию] данных|security|authentication|authorization|migration|transaction|concurren|race condition|physics|collision|combat|save.?game|persistence|data loss/i.test(content);
  const repair=task.repairs>0||task.attempts>0||(recovery?.count||0)>0;
  // Astra is the conservative default. Cheaper models need evidence of a
  // bounded task; unknown complexity must not silently fall back to Sol.
  const bounded=task.phase==='implement'&&!repair&&!consequential&&task.criteria.length>0&&task.criteria.length<=3&&content.length<=1200;
  // A cheap route must positively recognize the complete requested operation,
  // description AND every acceptance criterion. Prefixes and a risk blacklist
  // alone cannot prove simplicity (e.g. "change color and implement an editor").
  const normalized=s=>s.trim().replace(/[.!]$/,'').trim();
  const title=normalized(task.title),instructions=normalized(task.instructions),criteria=task.criteria.map(normalized);
  const docs=bounded&&/^(исправить опечатку в (документации|readme)|docs: fix typo)$/i.test(title)
    &&/^(исправить только опечатку в (документации|readme)|fix only a typo in (documentation|readme))$/i.test(instructions)
    &&criteria.every(c=>/^(опечатка исправлена|исправлена опечатка|изменён только текст|typo corrected|only text changed)$/i.test(c));
  if(docs)return {model:'gpt-6-luna',effort:'low',reason:'Ограниченная задача документации без признаков сложной реализации.'};
  const cosmetic=bounded&&/^(изменить (цвет|отступ|подпись|текст) (кнопки|подсказки|заголовка)|исправить опечатку в (тексте|подписи)|change button (color|spacing|label)|fix label typo)$/i.test(title)
    &&/^(в одном стиле кнопки заменить цвет|изменить только (цвет|отступ|подпись|текст) (кнопки|подсказки|заголовка)|исправить только опечатку в (тексте|подписи)|change only button (color|spacing|label)|fix only label typo)$/i.test(instructions)
    &&criteria.every(c=>/^((цвет|отступ|подпись|текст) соответствует макету|опечатка исправлена|изменён только текст|поведение не изменилось|(color|spacing|label) matches the mockup|behavior unchanged|typo corrected)$/i.test(c));
  if(cosmetic)return {model:'gpt-6.1-sol',effort:'medium',reason:'Небольшое локальное изменение оформления или текста; ограниченные критерии.'};
  return {model:'gpt-6-astra',effort:'high',reason:consequential?'Сложная или чувствительная логика в описании и критериях: Astra.':'Содержательная реализация или неясная сложность: Astra по умолчанию.'};
}
export function chooseAgent({task,project,models=[],config={},recovery}){
  const text=[project.profile?.domain||'',project.name,task.title,task.instructions,...task.criteria].join(' ');
  const domain=domains.find(d=>d[2].test(text))||['project',project.name||'Проект',null,'Inspect repository conventions and build a focused evidence-based implementation plan.'];
  const repair=task.phase==='implement'&&(task.repairs>0||(recovery?.count||0)>0);
  const role=repair?'Инженер восстановления':roles[task.phase]||'Специалист';
  const custom=domain[0]==='project';
  const id=createHash('sha256').update([project.id,domain[0],role].join(':')).digest('hex').slice(0,20);
  const profile={id,name:`${role} · ${domain[1]}`,domain:domain[0],role,custom,
    focus:domain[3],createdFrom:custom?'project-task':'trusted-template'};
  const available=models.filter(m=>!m.hidden&&typeof m.model==='string');
  const normal=available.find(m=>m.isDefault)||available[0];
  const policy=modelPolicy(task,recovery);
  // Preferences are host policy; only returned, visible catalog entries can win.
  const preferred=[policy.model];
  const selected=config.model?available.find(m=>m.model===config.model):preferred.map(id=>available.find(m=>m.model===id)).find(Boolean)||normal;
  const model=config.model||selected?.model||null;
  const desired=policy.effort;
  const supported=selected?.supportedReasoningEfforts?.map(e=>e.reasoningEffort)||[];
  const effort=supported.includes(desired)?desired:selected?.defaultReasoningEffort||null;
  const reason=config.model?'Модель закреплена оператором.':!selected?'Каталог недоступен: используется модель Codex по умолчанию.':selected.model!==policy.model?`${policy.model} отсутствует в доступном каталоге; выбран ${selected.model}. ${policy.reason}`:policy.reason;
  return {profileId:id,agent:profile.name,model,effort,reason,profile,brief:{title:task.title,criteria:task.criteria.slice(0,15)},independent:['review','discovery_review'].includes(task.phase)};
}

export async function assignAgent(store,runner,config,task,project,runId,recovery,now=Date.now()){
  let catalog=store.get('models:catalog');
  if(runner.listModels&&(!catalog||now-(catalog.checkedAt||catalog.at||0)>3600000)){
    try{catalog={models:await runner.listModels(),at:now,checkedAt:now};store.set('models:catalog',catalog);}
    catch(error){catalog={...catalog,checkedAt:now,error:String(error.message).slice(0,300)};store.set('models:catalog',catalog);}
  }
  const assignment=chooseAgent({task,project,models:catalog?.models||[],config,recovery});
  store.tx(()=>{
    if(!store.get('agent-profile:'+assignment.profileId))store.set('agent-profile:'+assignment.profileId,{...assignment.profile,createdAt:now});
    store.db.prepare('INSERT INTO run_agents VALUES (?,?)').run(runId,JSON.stringify(assignment));
    store.event('agent.assigned',task.id,{agent:assignment.agent,model:assignment.model,effort:assignment.effort,reason:assignment.reason},now);
  });
  return assignment;
}
