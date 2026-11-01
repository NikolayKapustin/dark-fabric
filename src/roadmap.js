import {readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// A documented convention, independent of project name or domain.
const files=['ROADMAP.md','docs/roadmap.md','STATUS.md'];
const clean=text=>text.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*`]/g,'').trim();
function readSource(root,file){
  try{
    const base=realpathSync(root),target=realpathSync(path.join(base,file)),relative=path.relative(base,target);
    if(relative.startsWith('..')||path.isAbsolute(relative))return null;
    const stat=statSync(target);if(!stat.isFile()||stat.size>1_000_000)return null;
    return {file,content:readFileSync(target,'utf8')};
  }catch{return null;}
}
export function parseSections(content,file){
  const lines=content.split(/\r?\n/),sections=[];let current=null,fence=null;
  for(let i=0;i<lines.length;i++){
    const marker=/^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;continue;}
    const match=!fence&&/^(#{1,4})\s+(.+)$/.exec(lines[i]);
    if(match){current={title:clean(match[2]).slice(0,300),level:match[1].length,source:{file,line:i+1},lines:[]};sections.push(current);}
    else if(current)current.lines.push(lines[i]);
  }
  return sections.map(s=>({...s,body:clean(s.lines.join('\n')).slice(0,8000),lines:undefined}));
}
export function projectRoadmap(mission,tasks,project){
  const nodes={},milestones=project?.profile?.milestones||[];
  nodes.stages={id:'stages',title:'Этапы проекта',children:[],body:'План и документы проекта. Готовность подтверждается задачами, проверками и ревью.'};
  milestones.slice(0,40).forEach((m,i)=>{const id='milestone:'+i;nodes.stages.children.push(id);nodes[id]={id,title:m.title,body:m.outcome,children:[],kind:'milestone'};});
  const sources=files.map(f=>readSource(mission.workspace,f)).filter(Boolean);
  for(const source of sources){
    const stack=[];
    for(const section of parseSections(source.content,source.file).slice(0,80)){
      const id=`doc:${source.file}:${section.source.line}`;
      nodes[id]={id,title:section.title,body:section.body,source:section.source,children:[],kind:'spec'};
      while(stack.length&&stack.at(-1).level>=section.level)stack.pop();
      (stack.length?nodes[stack.at(-1).id]:nodes.stages).children.push(id);stack.push({id,level:section.level});
    }
  }
  nodes.now={id:'now',title:'Текущая работа',children:['queue'],body:'Изолированная очередь проекта.'};
  const work=tasks.filter(t=>t.mission_id===mission.id&&t.kind==='work').sort((a,b)=>(a.status==='done')-(b.status==='done')||b.updated_at-a.updated_at).slice(0,40);
  nodes.queue={id:'queue',title:'Очередь фабрики',kind:'queue',children:work.map(t=>`task:${t.id}`),body:'Готово означает проверки, ревью и интеграцию.'};
  for(const task of work)nodes[`task:${task.id}`]={id:`task:${task.id}`,title:task.title.slice(0,300),kind:'task',taskId:task.id,status:task.status,phase:task.phase,
    children:[],body:task.instructions.slice(0,5000),criteria:task.criteria.slice(0,15).map(c=>c.slice(0,500)),depends:task.depends.slice(0,40),summary:task.result?.summary?.slice(0,2000)||''};
  const data={nodes,roots:['stages','now'],sources:sources.map(s=>s.file),available:true,latestVersion:null,
    sourceRevision:createHash('sha256').update(sources.map(s=>s.content).join('\n')).digest('hex').slice(0,12),
    missionId:mission.id,title:project?.name||'Проект',snapshotAt:Date.now()};
  if(Buffer.byteLength(JSON.stringify(data))>350000)for(const node of Object.values(nodes)){
    if(node.body?.length>900){node.body=node.body.slice(0,900);node.excerpt=true;}
    if(node.criteria)node.criteria=node.criteria.slice(0,5).map(c=>c.slice(0,150));
    if(node.summary)node.summary=node.summary.slice(0,500);
  }
  return data;
}
