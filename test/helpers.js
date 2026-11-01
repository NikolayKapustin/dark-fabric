import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';

export const result=(extra={})=>({status:'done',summary:'Completed with evidence',questions:[],evidence:[{source:'https://example.org/spec',finding:'Primary requirements'}],tasks:[],lessons:[],...extra,...(extra.questions?{questions:extra.questions.map(q=>({category:'product',...q}))}:{})});
export const planTask=(key,dependsOn=[])=>({key,title:key,instructions:'Implement '+key,dependsOn,acceptanceCriteria:['Executable regression passes'],priority:1});
export function fixture(t,options={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'dark-fabric-test-'));
  const config={...loadConfig(root),autoImprove:false,...options};
  const store=new Store(path.join(root,'test.sqlite'));
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const project=store.addProject({name:'fixture',path:root,checks:[{name:'check',command:['node','--version']}]});
  const mission=store.addMission({projectId:project.id,goal:'Build fixture',branch:'mission',workspace:root,baseSha:'base'});
  store.db.prepare("UPDATE tasks SET status='done' WHERE mission_id=?").run(mission.id);
  const runner={calls:[],readQuota:async()=>({known:true,blocked:false,until:0,observedAt:Date.now()}),run:async function(args){this.calls.push(args);args.onThread?.('thread-1');return result();}};
  const workspaces={task:async()=>({workspace:root,branch:'task'}),checkpoint:async()=> 'sha-1',cleanAt:async()=>true,integrate:async()=>({integrated:true}),sync:async()=>''};
  const engine=new Engine(store,config,{runner,workspaces,command:async()=>({code:0,stdout:'ok',stderr:''})});
  const add=(fields={})=>store.addTask({missionId:mission.id,title:'work',instructions:'work',criteria:['check'],...fields});
  const step=async(modelAllowed=true)=>{const task=store.claim({modelAllowed});if(task)await engine.execute(task);return task;};
  return {root,config,store,project,mission,runner,workspaces,engine,add,step};
}
