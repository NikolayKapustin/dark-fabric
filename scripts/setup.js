import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executable } from '../src/executable.js';
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||major===23||(major===22&&minor<16)){console.error('Install Node.js 24 LTS (minimum 22.16).');process.exit(1);}
const root=fileURLToPath(new URL('..',import.meta.url));
for(const argv of [['git','--version'],['npm','ci'],[process.execPath,'src/cli.js','init'],[process.execPath,'src/cli.js','doctor']]){
  const [command,...args]=executable(argv);
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true});
  if(result.error||result.status!==0){console.error(result.error?.message||'Setup stopped. Fix the diagnostic above and run npm run setup again.');process.exit(1);}
}
console.log('Ready. Run npm run up, then open http://127.0.0.1:4317. No project has been started.');
