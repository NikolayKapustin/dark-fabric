import Ajv from 'ajv';

const str={type:'string'};
const strings={type:'array',items:str};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const resultSchema=object({
  status:{type:'string',enum:['done','blocked','changes_requested']},
  summary:str,
  questions:{type:'array',items:object({category:{type:'string',enum:['product','technical','credential']},prompt:str,context:str,choices:strings})},
  evidence:{type:'array',items:object({source:str,finding:str})},
  tasks:{type:'array',items:object({key:str,title:str,instructions:str,dependsOn:strings,acceptanceCriteria:strings,priority:{type:'integer',minimum:0,maximum:10}})},
  lessons:strings,
});
const ajv=new Ajv({allErrors:true});
const validate=ajv.compile(resultSchema);
const bounded={type:'string',minLength:1,maxLength:600};
const list={type:'array',minItems:1,maxItems:8,items:bounded};
export const profileSchema=object({
  domain:{type:'string',enum:['game','web','mobile','data','service','research','other']},
  theme:{type:'string',enum:['ember','ocean','violet','forest','paper']},
  tagline:bounded,problem:bounded,audience:bounded,
  scope:list,outOfScope:list,constraints:list,risks:list,
  alternatives:{type:'array',minItems:2,maxItems:4,items:object({name:bounded,tradeoff:bounded,decision:bounded})},
  metrics:{type:'array',minItems:2,maxItems:8,items:object({id:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,39}$'},label:bounded,unit:bounded,target:bounded,method:bounded})},
  milestones:{type:'array',minItems:2,maxItems:8,items:object({title:bounded,outcome:bounded})},
});
const measurementSchema={type:'array',maxItems:8,items:object({id:{type:'string',maxLength:40},value:{type:'number'},source:bounded,note:bounded})};
const discoverySchema={...resultSchema,properties:{...resultSchema.properties,profile:{anyOf:[profileSchema,{type:'null'}]}},required:[...resultSchema.required,'profile']};
const metricResultSchema={...resultSchema,properties:{...resultSchema.properties,measurements:measurementSchema},required:[...resultSchema.required,'measurements']};
const validateDiscovery=ajv.compile(discoverySchema),validateMetrics=ajv.compile(metricResultSchema);
export function stageSchema(task,project){return task.phase==='discover'?discoverySchema:task.phase==='review'&&project.profile?.metrics?.length?metricResultSchema:resultSchema;}
export function validateStageResult(result,task,project,maxTasks){
  if(task.phase==='discover'){
    if(!validateDiscovery(result))throw Error('Invalid discovery: '+ajv.errorsText(validateDiscovery.errors));
    if(result.status==='done'&&!result.profile)throw Error('Completed discovery requires a profile');
    if(result.profile&&new Set(result.profile.metrics.map(m=>m.id)).size!==result.profile.metrics.length)throw Error('Duplicate metric identifiers');
  }else if(task.phase==='review'&&project.profile?.metrics?.length){
    if(!validateMetrics(result))throw Error('Invalid measurements: '+ajv.errorsText(validateMetrics.errors));
    const ids=new Set();for(const m of result.measurements){if(!project.profile.metrics.some(p=>p.id===m.id)||ids.has(m.id))throw Error('Unknown or duplicate project metric');ids.add(m.id);}
  }
  const {profile,measurements,...base}=result;
  validateResult(base,task.phase==='discover'?'research':task.phase==='discovery_review'?'review':task.phase,maxTasks);
  if(task.phase!=='discover'&&profile!==undefined)throw Error('Only discovery can propose a profile');
  if(task.phase!=='review'&&measurements!==undefined)throw Error('Only review can report measurements');
  return result;
}
export function validateResult(result,phase,maxTasks=40) {
  if(!validate(result)) throw new Error('Invalid agent result: '+ajv.errorsText(validate.errors));
  if(JSON.stringify(result).length>200_000) throw new Error('Agent result is too large');
  if(!result.summary.trim()) throw new Error('Agent result needs a summary');
  if(result.status==='blocked' && !result.questions.length) throw new Error('Blocked result needs a concrete question');
  if(result.status==='done' && result.questions.length) throw new Error('Unanswered questions cannot be marked done');
  if(!['plan','assess','retrospective'].includes(phase) && result.tasks.length) throw new Error('Only a planner can create tasks');
  if(phase==='research' && result.status==='done' && !result.evidence.some(e=>/^https:\/\//.test(e.source))) throw new Error('Research requires linked primary-source evidence');
  if(phase==='plan' && result.status==='done' && !result.tasks.length) throw new Error('Plan must contain actionable work');
  validatePlan(result.tasks,maxTasks);
  return result;
}
export function validatePlan(tasks,maxTasks=40) {
  if(tasks.length>maxTasks) throw new Error(`Plan exceeds ${maxTasks} tasks`);
  const keys=new Set();
  for(const t of tasks) {
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(t.key)||keys.has(t.key))throw new Error('Task keys must be unique identifiers');
    if(!t.title.trim()||!t.instructions.trim()||!t.acceptanceCriteria.length||t.acceptanceCriteria.some(c=>!c.trim())) throw new Error('Every task needs instructions and acceptance criteria');
    keys.add(t.key);
  }
  const map=new Map(tasks.map(t=>[t.key,t]));
  const visiting=new Set(),done=new Set();
  function visit(key) {
    if(done.has(key))return;
    if(visiting.has(key))throw new Error('Task dependency cycle');
    const t=map.get(key);
    if(!t)throw new Error(`Unknown dependency: ${key}`);
    visiting.add(key);t.dependsOn.forEach(visit);visiting.delete(key);done.add(key);
  }
  keys.forEach(visit);
}
