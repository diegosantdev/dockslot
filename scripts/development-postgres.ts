import EmbeddedPostgres from 'embedded-postgres';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);
/** pg_ctl creates the restricted Windows token needed when the shell is elevated. */
export class DevelopmentPostgres extends EmbeddedPostgres {
  private started = false;
  private async ctl() {
    const packageName = '@embedded-postgres/windows-x64';
    return (await import(packageName)).pg_ctl as string;
  }
  override async start() {
    if (process.platform !== 'win32') return super.start();
    const ctl = await this.ctl();
    try { await exec(ctl,['-D',this.options.databaseDir,'status'],{windowsHide:true}); this.started=true; return; } catch { /* Start only this helper's cluster. */ }
    await new Promise<void>((resolveStart,reject)=>{
      const child=spawn(ctl,
      [
        '-D',
        this.options.databaseDir,
        '-l',
        resolve(this.options.databaseDir, 'server.log'),
        '-o',
        `-p ${this.options.port} -h 127.0.0.1`,
        '-w',
        '-t',
        '180',
        'start',
      ],
      { windowsHide: true, env: process.env, stdio:'ignore' });
      child.on('error',reject);child.on('exit',code=>code===0?resolveStart():reject(new Error(`pg_ctl start exited ${code}; inspect server.log`)));
    });
    this.started = true;
  }
  override async createDatabase(name:string){if(process.platform!=='win32')return super.createDatabase(name);const client=this.getPgClient('postgres','127.0.0.1');await client.connect();try{await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);}finally{await client.end();}}
  override async stop() {
    if (process.platform !== 'win32') return super.stop();
    if (this.started) {
      await exec(await this.ctl(), ['-D', this.options.databaseDir, '-m', 'fast', '-w', 'stop'], {
        windowsHide: true,
        env: process.env,
      });
      this.started = false;
    }
  }
}
