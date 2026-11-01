import path from 'node:path';
import { existsSync } from 'node:fs';

// npm's Windows shims are batch files. Execute the known JS entry point with
// Node instead of enabling a shell or interpreting untrusted command arguments.
export function executable(argv, { platform=process.platform, env=process.env, node=process.execPath }={}) {
  if(platform!=='win32')return argv;
  const [command,...args]=argv, name=path.basename(command).toLowerCase();
  if(!['npm','npm.cmd','codex','codex.cmd'].includes(name))return argv;
  const explicit=path.dirname(command)!=='.';
  const search=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1]||'';
  const directories=explicit?[path.dirname(command)]:search.split(';').filter(Boolean).map(p=>p.replace(/^"|"$/g,''));
  const base=name.replace(/\.cmd$/,'');
  for(const dir of directories){
    const native=path.join(dir,base+'.exe');
    if(!name.endsWith('.cmd')&&existsSync(native))return [native,...args];
    const entry=path.join(dir,'node_modules',base==='npm'?'npm':'@openai/codex','bin',base==='npm'?'npm-cli.js':'codex.js');
    if(existsSync(entry))return [node,entry,...args];
  }
  if(base==='npm'&&!explicit){
    const entry=path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js');
    if(existsSync(entry))return [node,entry,...args];
  }
  throw new Error(`Cannot resolve ${command}. Install its official CLI and restart the terminal, or configure a native executable path.`);
}
