// Own Codex's process tree. EOF from the factory means its worker disappeared.
// Keep the per-workspace lock until every Codex descendant has been terminated.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { acquireLock } from './service.js';
import { stopTree } from './process.js';
import { executable } from './executable.js';
const [home,workspace,...command]=process.argv.slice(2);
const [binary,...args]=executable(command);
let release=()=>{},ending=false;
if(workspace){
  const dir=path.join(home,'worker-locks',createHash('sha256').update(path.resolve(workspace).toLowerCase()).digest('hex'));
  mkdirSync(dir,{recursive:true});
  try{release=acquireLock(dir);}catch(e){console.error(e.message);process.exit(1);}
}
const child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
function stop(){if(ending)return;ending=true;child.stdin.end();stopTree(child);}
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
process.stdin.on('end',stop);process.stdin.on('close',stop);process.stdin.on('error',stop);
process.stdout.on('error',stop);child.stdin.on('error',stop);
process.on('SIGINT',stop);process.on('SIGTERM',stop);
let spawnFailed=false;
child.once('error',e=>{spawnFailed=true;console.error(e.message);});
child.once('close',code=>{release();process.exitCode=spawnFailed||code!==0?1:0;process.stdin.destroy();});
