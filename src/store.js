import Database from './sqlite.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { initTelemetry } from './telemetry.js';
import { initInputs } from './inputs.js';
import { initProjects } from './projects.js';

export const uid = () => randomUUID();
const encode = value => JSON.stringify(value);
const decode = row => {
  if (!row) return row;
  const result = { ...row };
  for (const key of Object.keys(row)) if (key.endsWith('_json')) {
    result[key.slice(0,-5)] = JSON.parse(row[key]); delete result[key];
  }
  return result;
};

export class Store {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        checks_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        branch TEXT NOT NULL, workspace TEXT NOT NULL, base_sha TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
        kind TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
        criteria_json TEXT NOT NULL DEFAULT '[]', depends_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending', phase TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, repairs INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT, workspace TEXT, branch TEXT, checkpoint_sha TEXT,
        feedback TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '{}',
        lease TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        improvement INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        prompt TEXT NOT NULL, context TEXT NOT NULL, choices_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL, answer TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER,
        UNIQUE(task_id, dedupe_key)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), phase TEXT NOT NULL,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        thread_id TEXT, result_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        type TEXT NOT NULL, task_id TEXT, data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id),
        task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(mission_id,text)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_status ON tasks(status,available_at,priority);
      CREATE INDEX IF NOT EXISTS question_task ON questions(task_id,resolved_at);
      PRAGMA user_version = 1;
    `);
    if(!this.db.pragma('table_info(missions)').some(c=>c.name==='continuous'))this.db.exec('ALTER TABLE missions ADD COLUMN continuous INTEGER NOT NULL DEFAULT 0');
    this.db.pragma('user_version = 2');
    initTelemetry(this.db);
    initInputs(this.db);
    initProjects(this.db);
  }
  close() { this.db.close(); }
  // These are read/modify/write transactions shared with the remote bridge.
  // Reserve the writer before reading: upgrading a stale WAL snapshot can fail
  // immediately with SQLITE_BUSY_SNAPSHOT, regardless of busy_timeout.
  tx(fn) { return this.db.transaction(fn).immediate(); }
  rows(sql, ...params) { return this.db.prepare(sql).all(...params).map(decode); }
  row(sql, ...params) { return decode(this.db.prepare(sql).get(...params)); }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,encode(value)); }
  event(type, taskId, data = {}, now = Date.now()) { this.db.prepare('INSERT INTO events(at,type,task_id,data_json) VALUES (?,?,?,?)').run(now,type,taskId,encode(data)); }
  project(id) { return this.row('SELECT * FROM projects WHERE id=?',id); }
  mission(id) { return this.row('SELECT * FROM missions WHERE id=?',id); }
  task(id) { return this.row('SELECT * FROM tasks WHERE id=?',id); }
  addProject({ id=uid(),name, path: location, checks = [],priority=3 }) {
    const virtual=this.get('scheduler.virtualTime',0);
    this.db.prepare('INSERT INTO projects(id,name,path,checks_json,created_at,priority,virtual_time) VALUES (?,?,?,?,?,?,?)').run(id,name,location,encode(checks),Date.now(),priority,virtual);
    return this.project(id);
  }
  addMission({ id = uid(), projectId, goal, branch, workspace, baseSha, continuous = false,discovery=false }) {
    return this.tx(() => {
      this.db.prepare('INSERT INTO missions(id,project_id,goal,branch,workspace,base_sha,created_at,continuous) VALUES (?,?,?,?,?,?,?,?)').run(id,projectId,goal,branch,workspace,baseSha,Date.now(),Number(continuous));
      if(discovery&&!this.project(projectId).profile?.reviewedAt)this.db.prepare('UPDATE projects SET discovery_required=1 WHERE id=?').run(projectId);
      const research = this.addTask({ missionId:id, kind:discovery?'discovery':'research', title:discovery?'Discovery: продукт, домен, метрики и план':'Исследовать решения и ограничения', instructions:goal, phase:discovery?'discover':'research', priority:100 });
      this.addTask({ missionId:id, kind:'plan', title:'Выбрать план и построить очередь задач', instructions:goal, phase:'plan', depends:[research.id], priority:90 });
      this.event('mission.created',null,{id,goal});
      return this.mission(id);
    });
  }
  addTask({ id = uid(), missionId, kind = 'work', title, instructions, criteria = [], depends = [], phase = 'implement', priority = 0, improvement = false }) {
    const now=Date.now();
    this.db.prepare(`INSERT INTO tasks(id,mission_id,kind,title,instructions,criteria_json,depends_json,phase,priority,created_at,updated_at,improvement)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,missionId,kind,title,instructions,encode(criteria),encode(depends),phase,priority,now,now,Number(improvement));
    return this.task(id);
  }
  patch(id, fields, lease) {
    const allowed = new Set(['status','phase','priority','available_at','attempts','repairs','thread_id','workspace','branch','checkpoint_sha','feedback','result','lease']);
    const entries = Object.entries(fields);
    for (const [key] of entries) if (!allowed.has(key)) throw new Error(`Invalid task field: ${key}`);
    const sets = entries.map(([k])=>`${k === 'result' ? 'result_json' : k}=?`);
    const values = entries.map(([k,v])=>k === 'result' ? encode(v) : v);
    const result = this.db.prepare(`UPDATE tasks SET ${sets.join(',')},updated_at=? WHERE id=?${lease ? ' AND lease=?' : ''}`).run(...values,Date.now(),id,...(lease?[lease]:[]));
    if (result.changes !== 1) throw new Error('Task lease lost or task missing');
    return this.task(id);
  }
  claim({ now = Date.now(), modelAllowed = true } = {}) {
    return this.tx(() => {
      const clock=this.get('scheduler.virtualTime',0);
      const candidates = this.rows(`SELECT t.* FROM tasks t JOIN missions m ON m.id=t.mission_id JOIN projects p ON p.id=m.project_id
        WHERE t.status='pending' AND t.available_at<=? AND m.status='active' AND p.paused=0
        AND (p.discovery_required=0 OR t.kind='discovery')
        AND NOT EXISTS (SELECT 1 FROM tasks busy JOIN missions bm ON bm.id=busy.mission_id
          WHERE busy.status='running' AND bm.project_id=m.project_id)
        ORDER BY MAX(p.virtual_time,?),p.priority DESC,t.priority DESC,t.created_at,t.id`,now,clock);
      for (const task of candidates) {
        if (!modelAllowed && !['verify','integrate'].includes(task.phase)) continue;
        if (task.depends.some(id=>this.task(id)?.status !== 'done')) continue;
        if (this.row('SELECT id FROM questions WHERE task_id=? AND answer IS NULL',task.id)) continue;
        const lease=uid();
        this.patch(task.id,{status:'running',lease});
        const project=this.project(this.mission(task.mission_id).project_id),start=Math.max(project.virtual_time,clock);
        this.db.prepare('UPDATE projects SET virtual_time=? WHERE id=?').run(start+1/project.priority,project.id);
        this.set('scheduler.virtualTime',start);
        this.event('task.claimed',task.id,{phase:task.phase});
        return this.task(task.id);
      }
      return null;
    });
  }
  recover() {
    return this.tx(() => {
      const tasks=this.rows("SELECT * FROM tasks WHERE status='running'");
      for (const task of tasks) {
        this.patch(task.id,{status:'pending',lease:null,feedback:task.feedback+'\nPrevious service stopped mid-step. Inspect existing files and checkpoints before replaying. Do not duplicate effects.'});
        this.event('task.recovered',task.id,{phase:task.phase});
      }
      this.db.prepare("UPDATE runs SET status='interrupted',finished_at=? WHERE status='running'").run(Date.now());
      return tasks.length;
    });
  }
  ask(taskId, { prompt, context = '', choices = [], key = prompt }) {
    const existing=this.row('SELECT * FROM questions WHERE task_id=? AND dedupe_key=?',taskId,key);
    if (existing && existing.answer === null) return existing;
    // A genuinely recurring blocker needs a fresh answer, not a stale approval.
    const dedupe=existing ? `${key}:${uid()}` : key;
    const id=uid();
    this.db.prepare('INSERT INTO questions(id,task_id,prompt,context,choices_json,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?)').run(id,taskId,prompt,context,encode(choices),dedupe,Date.now());
    this.event('question.created',taskId,{id,prompt});
    return this.row('SELECT * FROM questions WHERE id=?',id);
  }
  block(task, questions, feedback='') {
    this.tx(() => {
      for (const q of questions) this.ask(task.id,q);
      this.patch(task.id,{status:'blocked',lease:null,feedback},task.lease);
    });
  }
  answer(id, answer) {
    if (typeof answer !== 'string' || !answer.trim() || answer.length>20_000) throw new Error('Answer must contain 1–20000 characters');
    return this.tx(() => {
      const q=this.row('SELECT * FROM questions WHERE id=?',id);
      if (!q) throw new Error('Question not found');
      if (q.answer !== null) throw new Error('Question already answered');
      this.db.prepare('UPDATE questions SET answer=?,resolved_at=? WHERE id=?').run(answer.trim(),Date.now(),id);
      if (!this.row('SELECT id FROM questions WHERE task_id=? AND answer IS NULL',q.task_id)) {
        const t=this.task(q.task_id);
        if (t.status==='blocked') this.patch(t.id,{status:'pending',available_at:0,attempts:0,repairs:0});
      }
      this.event('question.answered',q.task_id,{id});
      return this.task(q.task_id);
    });
  }
  answers(taskId) { return this.rows('SELECT * FROM questions WHERE task_id=? AND answer IS NOT NULL ORDER BY created_at',taskId); }
  startRun(task) {
    const id=uid();
    this.db.prepare('INSERT INTO runs(id,task_id,phase,status,started_at) VALUES (?,?,?,?,?)').run(id,task.id,task.phase,'running',Date.now());
    return id;
  }
  finishRun(id,status,result={}) { this.db.prepare('UPDATE runs SET status=?,finished_at=?,result_json=? WHERE id=?').run(status,Date.now(),encode(result),id); }
  consumeTurn(now = Date.now(), limit = Infinity) {
    return this.tx(() => {
      const day=new Date(now).toISOString().slice(0,10);
      let budget=this.get('budget',{day,used:0});
      if (budget.day!==day) budget={day,used:0};
      if (budget.used>=limit) return false;
      budget.used++; this.set('budget',budget); return true;
    });
  }
  saveLessons(task, texts) {
    const stmt=this.db.prepare('INSERT OR IGNORE INTO lessons VALUES (?,?,?,?,?)');
    for (const text of texts.slice(0,5)) if (text.trim()) stmt.run(uid(),task.mission_id,task.id,text.slice(0,2000),Date.now());
  }
  snapshot() {
    return {
      projects:this.rows('SELECT * FROM projects ORDER BY created_at'),
      missions:this.rows('SELECT * FROM missions ORDER BY created_at DESC'),
      tasks:this.rows('SELECT * FROM tasks ORDER BY priority DESC,created_at'),
      questions:this.rows('SELECT q.*,t.title,t.mission_id FROM questions q JOIN tasks t ON t.id=q.task_id ORDER BY q.created_at DESC'),
      events:this.rows('SELECT * FROM events ORDER BY id DESC LIMIT 100'),
      runs:this.rows('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100'),
      lessons:this.rows('SELECT * FROM lessons ORDER BY created_at DESC LIMIT 30'),
      quota:this.get('quota'), budget:this.get('budget'), heartbeat:this.get('heartbeat'),paused:this.get('paused',false),
      schedulingClock:this.get('scheduler.virtualTime',0),
    };
  }
}
