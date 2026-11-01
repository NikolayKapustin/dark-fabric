#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { readFileSync,existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { acquireLock, getToken, addProject, addMission, importProject, validateChecks,pinChecks } from './service.js';
import { createServer } from './server.js';
import { diagnose } from './doctor.js';
import { startPortal } from './portal.js';

const program=new Command().name('dark-fabric').description('Durable autonomous Codex factory').version('0.1.0').option('--home <directory>','State directory');
let store,config;
function open() {config=loadConfig(program.opts().home);store=new Store(path.join(config.root,'factory.sqlite'));return {store,config};}
const print=value=>console.log(JSON.stringify(value,null,2));
const readChecks=file=>file?validateChecks(JSON.parse(readFileSync(file,'utf8'))):undefined;
program.command('init').action(()=>{open();getToken(config.root);print({home:config.root});});
program.command('status').action(()=>{open();print(store.snapshot());});
program.command('questions').action(()=>{open();print(store.rows('SELECT * FROM questions WHERE answer IS NULL ORDER BY created_at'));});
program.command('answer <id> <text>').action((id,text)=>{open();print(store.answer(id,text));});
program.command('pause').action(()=>{open();store.set('paused',true);console.log('Scheduling paused; active stages may finish.');});
program.command('resume').action(()=>{open();store.set('paused',false);console.log('Scheduling resumed.');});
program.command('doctor').action(async()=>{
  open();
  const report=await diagnose(config,store);print(report);if(!report.ok)process.exitCode=1;
});
const project=program.command('project');
project.command('add <path>').option('--name <name>').option('--checks <jsonFile>').action(async(location,opts)=>{open();print(await addProject(store,{location,name:opts.name,checks:readChecks(opts.checks)}));});
project.command('import <path>').description('Snapshot a directory without changing its source').option('--name <name>').option('--checks <jsonFile>').action(async(location,opts)=>{open();print(await importProject(store,config,{location,name:opts.name,checks:readChecks(opts.checks)}));});
project.command('checks <id> <jsonFile>').action((id,file)=>{open();const project=store.project(id);if(!project)throw new Error('Project not found');store.db.prepare('UPDATE projects SET checks_json=? WHERE id=?').run(JSON.stringify(pinChecks(readChecks(file),project.path)),id);console.log('Quality commands updated.');});
program.command('mission <projectId> [goal]').option('--goal-file <file>','Read goal text from a UTF-8 file').option('--continuous','Reassess and continue the original goal after each batch').action(async(projectId,goal,opts)=>{open();print(await addMission(store,config,projectId,opts.goalFile?readFileSync(opts.goalFile,'utf8'):goal,!!opts.continuous));});
program.command('backup <file>').action(async(file)=>{open();await store.db.backup(path.resolve(file));console.log('SQLite snapshot saved. Back up workspaces and logs separately.');});
program.command('portal').description('Local portal only; keeps the factory stopped').action(async()=>{
  const portal=await startPortal(loadConfig(program.opts().home));
  console.log(`Dark Fabric portal: ${portal.url} (executor and bridge are not started)`);
  console.log('Stop with Ctrl+C or npm run down. To execute tasks, close the portal and use npm run up.');
  const stop=()=>void portal.close();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.on('message',message=>{if(message==='shutdown')stop();});
});
program.command('serve').action(async()=>{
  open();if(existsSync(path.join(config.root,'stop')))throw new Error('Factory is stopped by the operator. Use npm run up for an explicit restart.');
  const unlock=acquireLock(config.root);
  const database=store;
  let server,engine,stopPoll;
  try {
    const recovered=store.recover();engine=new Engine(store,config,{onHeartbeat:()=>{if(process.connected)process.send({type:'heartbeat'},()=>{});}});
    server=createServer(store,config,getToken(config.root));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
    console.log(`Dark Fabric: http://127.0.0.1:${config.port} (recovered ${recovered} stages)`);
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;clearInterval(stopPoll);await engine.stop();await new Promise(r=>server.close(r));unlock();database.close();process.exit(0);};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    process.on('message',message=>{if(message==='shutdown')void stop();});
    stopPoll=setInterval(()=>{if(existsSync(path.join(config.root,'stop')))void stop();},1000);
    await engine.start();
    // Keep ownership of the store until shutdown.
    store=null;
  } catch(e) {clearInterval(stopPoll);if(engine)await engine.stop();server?.close();unlock();throw e;}
});
try {await program.parseAsync();}catch(error){console.error(error.message);process.exitCode=1;}finally{store?.close();}
