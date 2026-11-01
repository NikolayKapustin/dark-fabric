import path from 'node:path';
import { existsSync, mkdirSync, realpathSync,readFileSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { runCommand } from './process.js';

export class IntegrationError extends Error {
  constructor(cause) { super(cause.message,{cause});this.name='IntegrationError'; }
}

export async function git(cwd,args,{allowFailure=false,...options}={}) {
  // Mission paths are longer than task paths. Enable Windows long-path support
  // for our Git invocations without changing repository or user configuration.
  const r=await runCommand(['git',...(process.platform==='win32'?['-c','core.longpaths=true']:[]),...args],{cwd,...options});
  if(r.code!==0&&!allowFailure)throw new Error(`git ${args[0]}: ${(r.stderr||r.stdout).trim()}`);
  return r;
}
async function isAncestor(cwd,ancestor,descendant) {
  const result=await git(cwd,['merge-base','--is-ancestor',ancestor,descendant],{allowFailure:true});
  if(!result.timedOut&&!result.aborted){
    if(result.code===0)return true;
    if(result.code===1)return false;
  }
  throw new Error(`git merge-base: ${(result.stderr||result.stdout).trim()||'ancestry check failed'}`);
}
export function contained(root,target) {
  const rel=path.relative(path.resolve(root),path.resolve(target));
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('Path escapes factory workspace');
  return path.resolve(target);
}
export async function inspectRepository(location) {
  // The native resolver also expands Windows short names and canonicalizes
  // casing, so Git and Node agree on the identity of the same directory.
  location=realpathSync.native(location);
  const top=(await git(location,['rev-parse','--show-toplevel'])).stdout.trim();
  if(realpathSync.native(top)!==location)throw new Error('Register the repository root, not a subdirectory');
  const sha=(await git(location,['rev-parse','HEAD'])).stdout.trim();
  return {path:location,sha};
}
export class Workspaces {
  constructor(root) { this.stateRoot=root;this.root=path.join(root,'workspaces');mkdirSync(this.root,{recursive:true}); }
  assertIdle(workspace) {
    const key=createHash('sha256').update(path.resolve(workspace).toLowerCase()).digest('hex');
    const lock=path.join(this.stateRoot,'worker-locks',key,'service.lock');
    if(!existsSync(lock))return;
    const owner=JSON.parse(readFileSync(lock,'utf8'));
    try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
    throw new Error('Workspace still owned by a surviving Codex process; wait for cleanup');
  }
  location(kind,id) { if(!/^[a-f0-9-]+$/.test(id))throw new Error('Invalid workspace id');return contained(this.root,path.join(this.root,`${kind}-${id}`)); }
  async create(repo,branch,location,base) {
    contained(this.root,location);
    if(existsSync(location)) {
      const actual=(await git(location,['rev-parse','--show-toplevel'])).stdout.trim();
      const actualBranch=(await git(location,['symbolic-ref','--short','HEAD'])).stdout.trim();
      if(realpathSync.native(actual)!==realpathSync.native(location)||actualBranch!==branch)throw new Error('Existing workspace has unexpected identity');
      return;
    }
    const exists=(await git(repo,['show-ref','--verify','--quiet',`refs/heads/${branch}`],{allowFailure:true})).code===0;
    await git(repo,['worktree','add',...(exists?[]:['-b',branch]),location,exists?branch:base]);
  }
  async mission(repo,id) {
    const {sha}=await inspectRepository(repo);
    const branch=`dark-fabric/mission-${id}`,workspace=this.location('mission',id);
    await this.create(repo,branch,workspace,sha);
    return {branch,workspace,baseSha:sha};
  }
  async task(project,mission,task) {
    const branch=`dark-fabric/task-${task.id}`,workspace=this.location('task',task.id);
    await this.create(project.path,branch,workspace,mission.branch);
    return {branch,workspace};
  }
  async checkpoint(task) {
    const status=(await git(task.workspace,['status','--porcelain'])).stdout;
    if(status) {
      await git(task.workspace,['add','--all']);
      await git(task.workspace,['-c','user.name=Dark Fabric','-c','user.email=dark-fabric@localhost','commit','-m',`Dark Fabric: ${task.title.slice(0,120)}`]);
    }
    return (await git(task.workspace,['rev-parse','HEAD'])).stdout.trim();
  }
  async cleanAt(task) {
    return !(await git(task.workspace,['status','--porcelain'])).stdout.trim() &&
      (await git(task.workspace,['rev-parse','HEAD'])).stdout.trim()===task.checkpoint_sha;
  }
  async readOnlyHead(workspace){
    if((await git(workspace,['status','--porcelain'])).stdout.trim())throw Error('Discovery workspace has uncommitted changes; preserve and inspect them before proceeding');
    return (await git(workspace,['rev-parse','HEAD'])).stdout.trim();
  }
  async discovery(project,mission,task,save){
    // Pin once in durable state before creating a checkout. A failed agent can
    // never promote its own commit into the source baseline on the next retry.
    if(!task.checkpoint_sha)task=save({checkpoint_sha:await this.readOnlyHead(mission.workspace)});
    const fresh=()=>{const id=randomUUID();return save({workspace:this.location('discovery',id),branch:`dark-fabric/discovery-${id}`,thread_id:null});};
    if(!task.workspace)task=fresh();
    this.assertIdle(task.workspace);
    await this.create(project.path,task.branch,task.workspace,task.checkpoint_sha);
    if(!await this.cleanAt(task)){
      // Keep the old branch and every file intact for diagnosis; retry in a new
      // isolated checkout from the original pin. Never reset a dirty checkout.
      task=fresh();
      await this.create(project.path,task.branch,task.workspace,task.checkpoint_sha);
    }
    return task;
  }
  async integrate(mission,task) {
    if(!task.checkpoint_sha || !await this.cleanAt(task))throw new Error('Reviewed checkpoint changed; verification must run again');
    try{
      if((await git(mission.workspace,['status','--porcelain'])).stdout.trim())throw new Error('Integration workspace has external changes; refusing to overwrite them');
      if(await isAncestor(mission.workspace,task.checkpoint_sha,'HEAD'))return {alreadyIntegrated:true};
      // Only fast-forward reviewed bytes. A stale task returns through implement/check/review.
      if(!await isAncestor(mission.workspace,'HEAD',task.checkpoint_sha))return {stale:true};
      await git(mission.workspace,['merge','--ff-only',task.checkpoint_sha]);
      return {integrated:true};
    }catch(error){
      // Checkout/lock/disk failures retain diagnostics and retry integration even
      // after escalation; an implementation agent cannot repair host Git I/O.
      throw new IntegrationError(error);
    }
  }
  async sync(task,mission) {
    // Task changes stay on its branch. A conflict is intentionally left for the implementing agent.
    const status=(await git(task.workspace,['status','--porcelain'])).stdout.trim();
    const merging=(await git(task.workspace,['rev-parse','-q','--verify','MERGE_HEAD'],{allowFailure:true})).code===0;
    if(merging)return 'An integration merge is in progress. Resolve conflicts, preserve both changes, and finish the merge.';
    if(status)return 'There are saved uncommitted changes from an earlier attempt. Preserve and inspect them before continuing.';
    const result=await git(task.workspace,['-c','user.name=Dark Fabric','-c','user.email=dark-fabric@localhost','merge','--no-edit',mission.branch],{allowFailure:true});
    return result.code===0?'':'Resolve the merge conflict with the integration branch, then finish the merge before completing work.';
  }
}
