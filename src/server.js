import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { addMission, validateChecks,pinChecks } from './service.js';
import { usageSnapshot } from './telemetry.js';
import {factorySettings,updateSettings,quotaReserve} from './settings.js';
import {tokenAnalysisSnapshot} from './token-analysis.js';

const publicRoot=new URL('../public/',import.meta.url);
function json(res,status,data) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
function equal(a,b) {return typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function body(req) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw new Error('Expected application/json');
  let text='';
  for await(const chunk of req) {text+=chunk;if(text.length>100000)throw new Error('Request too large');}
  return JSON.parse(text);
}
export function createServer(store,config,token) {
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host=req.headers.host||'';
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)){json(res,403,{error:'Local host required'});return;}
    if(req.headers.origin && ![`http://${host}`].includes(req.headers.origin)){json(res,403,{error:'Origin denied'});return;}
    const url=new URL(req.url,`http://${host}`);
    try {
      if(req.method==='GET'&&url.pathname==='/health') {json(res,200,{ok:true,service:'dark-fabric',pid:process.pid});return;}
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)) {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        let content=readFileSync(fileURLToPath(new URL(file,publicRoot)),'utf8');
        if(file==='index.html')content=content.replace('__OPERATOR_TOKEN__',token);
        res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
        res.end(content);return;
      }
      if(!equal(req.headers['x-dark-fabric-token'],token)){json(res,401,{error:'Operator token required'});return;}
      if(req.method==='GET'&&url.pathname==='/api/state'){
        const settings=factorySettings(store,config);
        json(res,200,{...store.snapshot(),dailyTurnLimit:config.dailyTurnLimit,quotaPollMs:config.quotaPollMs,usage:usageSnapshot(store),settings,quotaReserve:quotaReserve(store.get('quota'),settings),tokenAnalysis:tokenAnalysisSnapshot(store,settings)});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/settings'){
        json(res,200,{settings:updateSettings(store,config,await body(req))});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/answers') {
        const data=await body(req);json(res,200,store.answer(data.id,data.answer));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/pause') {
        const data=await body(req);if(typeof data.paused!=='boolean')throw new Error('paused must be boolean');
        store.set('paused',data.paused);store.event(data.paused?'factory.paused':'factory.resumed',null);json(res,200,{paused:data.paused});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/missions') {
        const data=await body(req);if(data.continuous!==undefined&&typeof data.continuous!=='boolean')throw new Error('continuous must be boolean');json(res,201,await addMission(store,config,data.projectId,data.goal,!!data.continuous));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/checks') {
        const data=await body(req);validateChecks(data.checks);
        const project=store.project(data.projectId);if(!project)throw new Error('Project not found');
        store.db.prepare('UPDATE projects SET checks_json=? WHERE id=?').run(JSON.stringify(pinChecks(data.checks,project.path)),data.projectId);
        store.event('project.checks.updated',null,{projectId:data.projectId});json(res,200,{ok:true});return;
      }
      json(res,404,{error:'Not found'});
    } catch(error) {json(res,400,{error:error.message});}
  });
}
