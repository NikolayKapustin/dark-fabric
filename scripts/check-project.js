import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { runCommand } from '../src/process.js';
const config=loadConfig(),store=new Store(path.join(config.root,'factory.sqlite'));
try{
  const project=store.project(process.argv[2]);if(!project)throw new Error('Unknown project');
  for(const check of project.checks){
    console.log('CHECK:',check.name);
    const result=await runCommand(check.command,{cwd:project.path,timeoutMs:check.timeoutMs});
    console.log(result.stdout.slice(-8000));if(result.stderr)console.error(result.stderr.slice(-5000));
    store.event('project.baseline_check',null,{projectId:project.id,check:check.name,...result});
    if(result.code!==0||result.timedOut){process.exitCode=1;break;}
    console.log('PASS:',check.name);
  }
}finally{store.close();}
