import path from 'node:path';
import { mkdirSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { git,Workspaces } from '../src/git.js';
import { addProject } from '../src/service.js';

const root=path.resolve('.darkfabric','smoke-'+Date.now()),source=path.join(root,'source');
mkdirSync(source,{recursive:true});
writeFileSync(path.join(source,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(path.join(source,'math.js'),'export function add(a,b) { return a - b; }\n');
writeFileSync(path.join(source,'test.js'),"import assert from 'node:assert/strict'; import {test} from 'node:test'; import {add} from './math.js'; test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);assert.equal(add(0,0),0);});\n");
await git(source,['init','-b','main']);await git(source,['add','.']);await git(source,['-c','user.name=Dark Fabric','-c','user.email=dark-fabric@localhost','commit','-m','Smoke fixture with failing regression']);
const config={...loadConfig(path.join(root,'state')),autoImprove:false,turnTimeoutMs:180000};
const store=new Store(path.join(config.root,'factory.sqlite'));
try{
  const project=await addProject(store,{location:source,name:'Codex live smoke',checks:[{name:'addition regression',command:[process.execPath,'--test','test.js'],protectedFiles:['test.js']}]});
  // The synthetic fixture supplies its own known plan; product discovery is
  // tested separately. A normal operator mission always keeps discovery gates.
  const id=randomUUID();
  const mission=store.addMission({id,projectId:project.id,goal:'Fix the addition function without changing the supplied test.',...await new Workspaces(config.root).mission(source,id)});
  store.db.prepare("UPDATE tasks SET status='done' WHERE mission_id=?").run(mission.id);
  const task=store.addTask({missionId:mission.id,title:'Fix addition',instructions:'Fix math.js so add(a,b) adds numbers. Do not change test.js. This is a tiny smoke test; no research or dependencies needed. Return done when fixed.',criteria:['add(2,3) is 5','add(-2,3) is 1','supplied tests are unchanged']});
  const engine=new Engine(store,config);
  for(let i=0;i<8;i++){
    const next=store.claim();if(!next)break;
    console.log('Live stage:',next.phase);await engine.execute(next);
    const current=store.task(task.id);console.log('Result:',current.status,current.phase,current.feedback);
    if(current.status==='done'||current.status==='blocked')break;
  }
  const final=store.task(task.id);console.log(JSON.stringify({status:final.status,phase:final.phase,root,mission:mission.workspace,questions:store.snapshot().questions},null,2));
  if(final.status!=='done')process.exitCode=1;
}finally{store.close();}
