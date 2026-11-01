import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseAgent,assignAgent} from '../src/agents.js';
import {fixture,result} from './helpers.js';
const models=['gpt-6.1-sol','gpt-6-astra','gpt-6-luna'].map((model,i)=>({model,isDefault:!i,supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low'}));
const base={task:{title:'Реализовать бой',instructions:'Godot',criteria:['test'],phase:'implement'},project:{id:'p',name:'Example Game'},models};
test('specialists select available models and escalate repeated failures without changing access',()=>{
 const normal=chooseAgent(base);assert.equal(normal.model,'gpt-6-astra');assert.equal(normal.profile.domain,'godot');assert.equal(normal.effort,'high');
 assert.equal(chooseAgent({...base,recovery:{count:2}}).model,'gpt-6-astra');
 const missing=chooseAgent({...base,models:[models[0]],recovery:{count:2}});assert.equal(missing.model,'gpt-6.1-sol');
 assert.equal(chooseAgent({...base,config:{model:'operator-pinned'}}).model,'operator-pinned');
});
test('new project profile is reusable; lightweight model is limited to documentation',()=>{
 const args={...base,task:{...base.task,title:'Исправить опечатку в документации',instructions:'Исправить только опечатку в README.',criteria:['Опечатка исправлена']},project:{id:'new',name:'Compiler'}};
 const a=chooseAgent(args),b=chooseAgent(args);assert.equal(a.model,'gpt-6-luna');assert.equal(a.profile.custom,true);assert.equal(a.profileId,b.profileId);
 assert.equal(chooseAgent({...args,task:{...args.task,phase:'review'}}).model,'gpt-6-astra');
});
test('catalog failure preserves previous catalog and cannot stall work',async t=>{
 const f=fixture(t),task=f.add(),r=f.store.startRun(task);f.store.set('models:catalog',{models,at:1});
 const a=await assignAgent(f.store,{listModels:async()=>{throw new Error('offline')}},f.config,task,f.project,r,null);
 assert.equal(a.model,'gpt-6-astra');assert.ok(f.store.get('models:catalog').error);assert.equal(f.store.rows('select * from run_agents').length,1);
});
test('implementation and review receive persisted assignments and separate threads',async t=>{
 const f=fixture(t);f.runner.listModels=async()=>models;f.add({instructions:'Godot game'});await f.step();await f.step();await f.step();
 assert.equal(f.runner.calls.length,2);assert.equal(f.runner.calls[0].model,'gpt-6-astra');assert.equal(f.runner.calls[1].model,'gpt-6-astra');assert.equal(f.runner.calls[1].threadId,null);assert.equal(f.runner.calls[1].effort,'high');
 assert.equal(f.store.rows('select * from run_agents').length,2);assert.match(f.runner.calls[1].prompt,/Assigned specialist: Независимый ревьюер/);
});

test('complex work selects Astra before failure even with a neutral or misleading title',()=>{
 for(const task of [
  {title:'OB01',instructions:'Два ответа на проход машины',criteria:['Коллизии согласованы с геометрией','Победа переживает сохранение и загрузку']},
  {title:'Изменить цвет кнопки',instructions:'Также исправить авторизацию пользователя',criteria:['Работает вход']},
  {title:'docs: update',instructions:'Document migration and data loss recovery',criteria:['Compatibility reviewed']},
  {title:'Новая функция',instructions:'Требования нужно уточнить по проекту',criteria:['Работает сценарий']},
  {title:'Изменить цвет кнопки и реализовать редактор уровней',instructions:'Добавить редактор сетки тайлов, кисти, слои и отмену действий.',criteria:['Работает редактор']},
  {title:'Изменить цвет кнопки',instructions:'Кроме цвета, реализовать поиск пути A* и иерархический автомат состояний врага.',criteria:['Цвет соответствует макету']},
  {title:'Обновить документацию',instructions:'Обновить README',criteria:['Реализация инвентаря и крафта. '.repeat(120)]},
  {title:'Изменить цвет кнопки',instructions:'В одном стиле кнопки заменить цвет.',criteria:['Реализовать поиск пути']},
  {title:'docs: fix typo',instructions:'Fix only a typo in README',criteria:['Add a level editor']},
 ]){const a=chooseAgent({...base,task:{...base.task,...task,attempts:0,repairs:0}});assert.equal(a.model,'gpt-6-astra');assert.equal(a.effort,'high');}
});

test('only bounded local edits use Sol and broader acceptance or retries promote to Astra',()=>{
 const task={...base.task,title:'Изменить цвет кнопки',instructions:'В одном стиле кнопки заменить цвет.',criteria:['Цвет соответствует макету']};
 assert.equal(chooseAgent({...base,task}).model,'gpt-6.1-sol');
 assert.equal(chooseAgent({...base,task:{...task,criteria:Array(4).fill('Отдельная проверка')}}).model,'gpt-6-astra');
 assert.equal(chooseAgent({...base,task:{...task,attempts:1}}).model,'gpt-6-astra');
 for(const phase of ['research','plan','assess','review','retrospective'])assert.equal(chooseAgent({...base,task:{...task,phase}}).model,'gpt-6-astra');
 const fallback=chooseAgent({...base,models:[models[0]]});assert.equal(fallback.model,'gpt-6.1-sol');assert.match(fallback.reason,/отсутствует в доступном каталоге/);
});
test('quota polling continues while a long stage is active',async t=>{
 const f=fixture(t);let reads=0;f.runner.readQuota=async()=>{reads++;return{known:true,complete:true,blocked:false,until:0}};
 f.engine.active.set('task',Promise.resolve(result()));await f.engine.tick();assert.equal(reads,1);f.engine.active.clear();
});

test('partial exhausted quota notifications block new turns and preserve longer cooldowns',async t=>{
 const f=fixture(t),now=Date.now(),reset=Math.ceil(now/1000)+3600;f.add();
 f.store.set('quota',{known:true,complete:true,blocked:false,until:0,observedAt:now,checkedAt:now});
 f.runner.run=async args=>{
  const notification={method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:100,resetsAt:reset},secondary:{usedPercent:null}}}};
  args.onEvent(notification);assert.equal(f.engine.modelAllowed(),false);assert.equal(f.store.get('quota').known,false);
  const longer=now+7200000;f.store.set('quota',{...f.store.get('quota'),until:longer});args.onEvent(notification);
  assert.equal(f.store.get('quota').until,longer);return result();
 };await f.step();assert.equal(f.engine.modelAllowed(),false);
});
