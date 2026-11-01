import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { qualityDigest } from './integrity.js';
import { uid } from './store.js';
import { Workspaces, inspectRepository, git, contained } from './git.js';

export function acquireLock(root) {
  const file=path.join(root,'service.lock');
  const token=uid();
  for(let attempt=0;attempt<2;attempt++) {
    try { writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx'});break; }
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      let lock;
      try {lock=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('Unreadable service lock; inspect it before removing it');}
      try {process.kill(lock.pid,0);throw new Error(`Dark Fabric already running (PID ${lock.pid})`);}
      catch(err){if(err.code!=='ESRCH')throw err;}
      unlinkSync(file);
    }
  }
  if(JSON.parse(readFileSync(file,'utf8')).token!==token)throw new Error('Service lock race');
  return ()=>{if(existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).token===token)unlinkSync(file);};
}
export function getToken(root) {
  const file=path.join(root,'operator.token');
  if(!existsSync(file))writeFileSync(file,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
  return readFileSync(file,'utf8').trim();
}
export function validateChecks(checks) {
  if(!Array.isArray(checks)||checks.length>20)throw new Error('Checks must be an array with at most 20 commands');
  for(const c of checks) {
    if(typeof c.name!=='string'||!c.name.trim()||!Array.isArray(c.command)||!c.command.length||c.command.some(s=>typeof s!=='string'||s.includes('\0')))throw new Error('Each check needs a name and command argv array');
    if(c.timeoutMs!==undefined&&(!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<100||c.timeoutMs>3_600_000))throw new Error('Invalid check timeout');
    if(c.protectedFiles!==undefined&&(!Array.isArray(c.protectedFiles)||c.protectedFiles.some(p=>typeof p!=='string')))throw new Error('protectedFiles must be relative file paths');
  }
  return checks;
}
export function pinChecks(checks,root) {
  return validateChecks(checks).map(c=>({...c,pins:(c.protectedFiles||[]).map(file=>({path:file,sha256:qualityDigest(readFileSync(contained(root,path.resolve(root,file))))}))}));
}
export function detectChecks(root) {
  const file=path.join(root,'package.json');
  if(existsSync(file)) {
    const scripts=JSON.parse(readFileSync(file,'utf8')).scripts||{};
    return ['test','check'].filter(n=>scripts[n]&&!scripts[n].includes('no test specified')).map(n=>({name:`npm ${n}`,command:['npm','run',n],timeoutMs:300000}));
  }
  return [];
}
export async function addProject(store,{location,name,checks}) {
  const repo=await inspectRepository(path.resolve(location));
  return store.addProject({name:name||path.basename(repo.path),path:repo.path,checks:pinChecks(checks??detectChecks(repo.path),repo.path)});
}
export async function addMission(store,config,projectId,goal,continuous=false) {
  if(typeof goal!=='string'||!goal.trim()||goal.length>50_000)throw new Error('Goal must contain 1–50000 characters');
  const project=store.project(projectId);
  if(!project)throw new Error('Project not found');
  const id=uid(),spaces=new Workspaces(config.root);
  const workspace=await spaces.mission(project.path,id);
  return store.addMission({id,projectId,goal:goal.trim(),continuous,discovery:true,...workspace});
}

export async function importProject(store,config,{location,name,checks}) {
  const source=path.resolve(location),id=uid();
  const target=contained(config.root,path.join(config.root,'projects',id));
  if(!lstatSync(source).isDirectory())throw new Error('Source must be a directory');
  if(target===source||target.startsWith(source+path.sep))throw new Error('Import destination must be outside the source directory');
  const excluded=new Set(['.git','.darkfabric','.godot','node_modules','exports','releases','.tools','bin','obj','.vs','coverage']);
  const files=[],skipped=[];let bytes=0;
  function scan(dir,rel='') {
    for(const e of readdirSync(dir,{withFileTypes:true})) {
      const relative=path.join(rel,e.name),from=path.join(dir,e.name);
      if(excluded.has(e.name)||e.isSymbolicLink()||/^\.env($|\.)/.test(e.name)||/\.(zip|7z|rar)$/i.test(e.name)||
        (rel==='qa' && (e.isDirectory() || !/\.(md|txt|json|ps1|cs)$/i.test(e.name)))) {skipped.push(relative);continue;}
      if(e.isDirectory())scan(from,relative);
      else if(e.isFile()) {
        const size=lstatSync(from).size;
        if(size>50_000_000)throw new Error(`Import file exceeds 50 MB: ${relative}`);
        bytes+=size;
        if(bytes>1_000_000_000||files.length>50_000)throw new Error('Source snapshot exceeds import limit; register a prepared Git repo instead');
        files.push({from,relative});
      }
    }
  }
  scan(source);mkdirSync(target,{recursive:true});
  for(const f of files) {const to=path.join(target,f.relative);mkdirSync(path.dirname(to),{recursive:true});copyFileSync(f.from,to);}
  const ignore=path.join(target,'.gitignore');
  writeFileSync(ignore,(existsSync(ignore)?readFileSync(ignore,'utf8')+'\n':'')+'\n# Dark Fabric generated files\n.darkfabric/\n.godot/\nnode_modules/\nexports/\nreleases/\nbin/\nobj/\n*.log\n.env\n.env.*\n');
  writeFileSync(path.join(target,'DARK_FABRIC_IMPORT.json'),JSON.stringify({source,importedAt:new Date().toISOString(),files:files.length,bytes,skipped},null,2));
  await git(target,['init','-b','main']);await git(target,['add','--all']);
  await git(target,['-c','user.name=Dark Fabric','-c','user.email=dark-fabric@localhost','commit','-m','Import source snapshot for isolated autonomous development']);
  return addProject(store,{location:target,name:name||path.basename(source),checks});
}
