import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { greyDataDir as dir } from './runtime-paths.js';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from './store';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import { createGreyApp } from './grey-app';
import {Postgres,databaseUrl} from './postgres';
import {createPostgresStore} from './postgres-store';

mkdirSync(dir,{recursive:true});
const keyPath=join(dir,'access-token');
if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32).toString('hex'),{mode:0o600});
const token=process.env.MCP_SERVICE_TOKEN??readFileSync(keyPath,'utf8').trim();
process.env.STUDIO_TOKEN??=token;
process.env.LOCAL_CONNECTOR_ROOT=join(dir,'local-connector');
const ownerPath=join(dir,'platform-owner');
const platformAdminUsername=process.env.PLATFORM_ADMIN_USERNAME??(existsSync(ownerPath)?readFileSync(ownerPath,'utf8').trim():undefined);
const url=databaseUrl(),database=url?new Postgres(url):undefined;
if(database){
 const schema=await database.pool.query('SELECT version FROM schema_migration WHERE version=2');
 if(!schema.rowCount)throw Error('请先完成数据库迁移，再启动新版本');
}
const app=createGreyApp(database?createPostgresStore(database,'owner'):createStore(join(dir,'operations.sqlite')),token,{modelDataDir:dir,authDataDir:dir,publicOrigin:process.env.CUSTOMER_PUBLIC_ORIGIN??process.env.PUBLIC_ORIGIN,platformAdminUsername,database});
const http=httpServer(app);app.locals.connectorChannel?.attach(http);
http.listen(Number(process.env.PORT??4174),process.env.HOST??'127.0.0.1',()=>console.log('华科未来·矩阵云工作台已启动'));
if(process.env.TLS_CERT&&process.env.TLS_KEY){
 const credentials=()=>({cert:readFileSync(process.env.TLS_CERT!),key:readFileSync(process.env.TLS_KEY!)});
 const https=httpsServer(credentials(),app);app.locals.connectorChannel?.attach(https);
 https.listen(Number(process.env.TLS_PORT??443),process.env.HOST??'127.0.0.1');
 process.on('SIGHUP',()=>{try{https.setSecureContext(credentials());console.log('HTTPS 证书已更新');}catch{console.error('HTTPS 证书更新失败，继续使用现有证书');}});
}
