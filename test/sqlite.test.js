import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from '../src/sqlite.js';

test('SQLite nested rollback retains outer transaction; outer rollback discards all changes',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY)');
  db.transaction(()=>{
    db.prepare('INSERT INTO entries VALUES (?)').run(1);
    assert.throws(()=>db.transaction(()=>{db.exec('INSERT INTO entries VALUES (2)');throw Error('inner');}).immediate(),/inner/);
    db.exec('INSERT INTO entries VALUES (3)');
  }).immediate();
  assert.deepEqual(db.prepare('SELECT id FROM entries ORDER BY id').all(),[{id:1},{id:3}]);
  assert.throws(()=>db.transaction(()=>{db.exec('INSERT INTO entries VALUES (4)');db.transaction(()=>db.exec('INSERT INTO entries VALUES (5)')).immediate();throw Error('outer');}).immediate(),/outer/);
  assert.deepEqual(db.prepare('SELECT id FROM entries ORDER BY id').all(),[{id:1},{id:3}]);
  assert.throws(()=>db.transaction(()=>Promise.resolve()).immediate(),/synchronous/);
  db.exec('INSERT INTO entries VALUES (6)');
});

test('SQLite backup includes committed WAL state and reopens independently read-only',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'df sqlite backup '));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=new Database(path.join(root,'source.sqlite'));
  try{
    db.pragma('journal_mode=WAL');db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY,value TEXT)');
    db.transaction(()=>db.prepare('INSERT INTO entries VALUES (?,?)').run(1,'данные')).immediate();
    const file=path.join(root,'backup.sqlite');await db.backup(file);
    db.exec('INSERT INTO entries VALUES (2,\'later\')');
    const snapshot=new Database(file,{readonly:true,fileMustExist:true});
    try{assert.deepEqual(snapshot.prepare('SELECT * FROM entries').all(),[{id:1,value:'данные'}]);assert.equal(snapshot.pragma('integrity_check',{simple:true}),'ok');assert.throws(()=>snapshot.exec('DELETE FROM entries'),/readonly/i);}
    finally{snapshot.close();}
  }finally{db.close();}
  assert.throws(()=>new Database(path.join(root,'missing.sqlite'),{fileMustExist:true}),/does not exist/);
});
