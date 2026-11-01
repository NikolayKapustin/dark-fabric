import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=/(^|\/)(\.darkfabric|node_modules|outputs|sites|\.openai|\.codex)(\/|$)|(^|\/)(operator\.token|remote\.json|auth\.json|\.env(\..*)?)$|\.(sqlite(-wal|-shm)?|db|log|jsonl|pfx|p12|pem)$/i;
const secret=/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const errors=[];
for(const file of files){
  if(forbidden.test(file))errors.push('Private/runtime path: '+file);
  const stat=statSync(file);if(stat.size>1_000_000){errors.push('Unexpected large release file: '+file);continue;}
  const content=readFileSync(file,'utf8');if(secret.test(content))errors.push('Credential-shaped content: '+file);
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('Release tree checked: '+files.length+' tracked files; no runtime paths or recognized credential patterns.');
