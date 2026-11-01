import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';

// Keep the store's small synchronous API while using Node's bundled SQLite.
// No native npm addon, compiler, Python, or per-platform binary download.
function call(fn){
  try{return fn();}catch(error){
    const primary=error.errcode&255;
    if(error.code==='ERR_SQLITE_ERROR'){
      const names={5:'SQLITE_BUSY',6:'SQLITE_LOCKED',19:'SQLITE_CONSTRAINT'};
      if(names[primary])error.code=names[primary];
    }
    throw error;
  }
}
export default class Database {
  constructor(filename,{readonly=false,fileMustExist=false}={}){
    if(fileMustExist&&!existsSync(filename))throw new Error('Database file does not exist');
    this.native=new DatabaseSync(filename,{readOnly:readonly});this.sequence=0;
  }
  close(){return call(()=>this.native.close());}
  exec(sql){return call(()=>this.native.exec(sql));}
  prepare(sql){
    const statement=call(()=>this.native.prepare(sql));
    return {
      run:(...args)=>call(()=>statement.run(...args)),
      get:(...args)=>call(()=>{const row=statement.get(...args);return row?{...row}:undefined;}),
      all:(...args)=>call(()=>statement.all(...args).map(row=>({...row}))),
    };
  }
  pragma(sql,{simple=false}={}){
    const rows=this.prepare('PRAGMA '+sql).all();return simple?Object.values(rows[0]||{})[0]:rows;
  }
  transaction(fn){
    const execute=(mode,args)=>{
      const nested=this.native.isTransaction,savepoint='df_'+(++this.sequence);
      this.exec(nested?'SAVEPOINT '+savepoint:'BEGIN '+mode);
      try{
        const result=fn(...args);
        if(result&&typeof result.then==='function')throw new TypeError('SQLite transactions must be synchronous');
        this.exec(nested?'RELEASE '+savepoint:'COMMIT');return result;
      }catch(error){
        if(this.native.isTransaction){
          if(nested){this.exec('ROLLBACK TO '+savepoint);this.exec('RELEASE '+savepoint);}
          else this.exec('ROLLBACK');
        }
        throw error;
      }
    };
    const run=(...args)=>execute('DEFERRED',args);
    run.immediate=(...args)=>execute('IMMEDIATE',args);return run;
  }
  backup(file){return backup(this.native,file);}
}
