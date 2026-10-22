import 'dotenv/config';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
const exec=promisify(execFile),url=new URL(process.env.DATABASE_URL||'postgres://dockslot:dockslot@127.0.0.1:55432/dockslot');
const name=`dockslot_restore_${randomBytes(5).toString('hex')}`,folder=resolve('.local/backups');mkdirSync(folder,{recursive:true});
const env={...process.env,PGHOST:url.hostname,PGPORT:url.port||'5432',PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)};
const binary=(name:string)=>process.env.PG_BIN?join(process.env.PG_BIN,name+(process.platform==='win32'?'.exe':'')):name;
const source=new pg.Client({connectionString:url.href}),adminUrl=new URL(url);adminUrl.pathname='/postgres';const admin=new pg.Client({connectionString:adminUrl.href});await source.connect();await admin.connect();let created=false;
try{
  const file=resolve(folder,`${name}.dump`);await exec(binary('pg_dump'),['-d',url.pathname.slice(1),'-Fc','-f',file],{env,windowsHide:true});await admin.query(`CREATE DATABASE "${name}"`);created=true;
  await exec(binary('pg_restore'),['-d',name,'--no-owner','--exit-on-error',file],{env,windowsHide:true});const restoredUrl=new URL(url);restoredUrl.pathname=`/${name}`;const restored=new pg.Client({connectionString:restoredUrl.href});await restored.connect();
  try{for(const table of ['organizations','sites','appointments','dock_allocations','audit_events','outbox_events']){const a=(await source.query(`SELECT count(*) FROM ${table}`)).rows[0].count,b=(await restored.query(`SELECT count(*) FROM ${table}`)).rows[0].count;if(a!==b)throw new Error(`Count differs for ${table}: ${a} != ${b}`);}
    const overlap=await restored.query("SELECT 1 FROM dock_allocations a JOIN dock_allocations b ON a.id<b.id AND a.dock_id=b.dock_id AND a.start_at<b.end_at AND b.start_at<a.end_at WHERE a.state='active' AND b.state='active' LIMIT 1");if(overlap.rowCount)throw new Error('Restored active allocations overlap');console.log(JSON.stringify({status:'passed',backup:file,restoredDatabase:name,checks:'six table counts and no active overlaps'}));
  }finally{await restored.end();}
}finally{if(created)await admin.query(`DROP DATABASE "${name}"`);await source.end();await admin.end();}
