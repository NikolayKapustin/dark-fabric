import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Explicit enumeration also works on Node 22 and shells without glob expansion.
const files=readdirSync('test').filter(f=>f.endsWith('.test.js')).sort().map(f=>'test/'+f);
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);
process.exitCode=result.status??1;
