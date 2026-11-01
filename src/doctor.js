import { runCommand } from './process.js';
import { CodexRunner } from './codex.js';

export async function diagnose(config,store,{command=runCommand,runner=new CodexRunner(config)}={}) {
  const checks=[];
  for(const [name,argv,hint] of [
    ['Git',['git','--version'],'Install Git and restart the terminal.'],
    ['Codex',[config.codexPath,'--version'],'Install Codex CLI or set CODEX_BIN to its executable.'],
    ['Codex login',[config.codexPath,'login','status'],'Run codex login in your terminal.'],
  ]){
    try{const r=await command(argv,{timeoutMs:15000,stateRoot:config.root});checks.push({name,ok:r.code===0&&!r.timedOut,detail:(r.stdout+r.stderr).trim().slice(-1500),hint:r.code===0?undefined:hint});}
    catch(e){checks.push({name,ok:false,detail:e.message,hint});}
  }
  let quota;
  try{quota=await runner.readQuota();checks.push({name:'Codex app-server protocol',ok:true});}
  catch(e){checks.push({name:'Codex app-server protocol',ok:false,detail:e.message,hint:'Check the installed CLI and its app-server support; no credentials are read by Dark Fabric.'});}
  const sqlite=store.db.pragma('integrity_check',{simple:true});checks.push({name:'SQLite',ok:sqlite==='ok',detail:sqlite});
  return {ok:checks.every(c=>c.ok),node:process.version,platform:process.platform,home:config.root,checks,quota};
}
