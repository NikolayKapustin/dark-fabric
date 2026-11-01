import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {contained} from './git.js';
import {qualityDigest} from './integrity.js';

// The host and model must use the same definition of a protected-file pin.
export function inspectQualityPins(checks,workspace){
  return checks.flatMap(check=>(check.pins||[]).map(pin=>{
    const result={check:check.name,path:pin.path,expected:pin.sha256,algorithm:'sha256-utf8-crlf-to-lf',matched:false};
    try{
      const root=realpathSync(workspace),file=contained(root,realpathSync(contained(root,path.resolve(root,pin.path))));
      const bytes=readFileSync(file),actual=qualityDigest(bytes),raw=createHash('sha256').update(bytes).digest('hex');
      return {...result,actual,raw,matched:actual===pin.sha256,lineEndingOnly:actual===pin.sha256&&raw!==actual};
    }catch(error){return {...result,error:error.message};}
  }));
}
