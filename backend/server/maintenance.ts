import {readFileSync,statSync,realpathSync} from 'node:fs';
import {createServer as createHttpsServer} from 'node:https';
import {z} from 'zod';
import {MaintenanceAuth} from './maintenance-auth';
import {MaintenanceService} from './maintenance-service';
import {maintenanceRunner} from './maintenance-runner';
import {createMaintenanceApp} from './maintenance-app';
const file=process.env.MAINTENANCE_CONFIG;if(!file)throw Error('请配置私有的 MAINTENANCE_CONFIG 文件');
if((statSync(file).mode&0o077)!==0)throw Error('维护配置文件必须仅管理员可读');
const config=z.object({resource:z.string().url(),repoRoot:z.string(),stateRoot:z.string(),adminHash:z.string(),clients:z.array(z.object({client_id:z.string(),redirect_uris:z.array(z.string().url()),token_endpoint_auth_method:z.literal('none'),grant_types:z.array(z.string()),response_types:z.array(z.string())})),checksImage:z.string(),lockHash:z.string(),deployHelper:z.string(),backupRoot:z.string(),postgres:z.boolean(),container:z.string(),port:z.number().int().min(1024).max(65535).default(4176)}).strict().parse(JSON.parse(readFileSync(file,'utf8')));
if(new URL(config.resource).protocol!=='https:'||new URL(config.resource).pathname!=='/maintenance/mcp')throw Error('维护接口必须使用独立 HTTPS 地址下的 /maintenance/mcp');
const repo=realpathSync(config.repoRoot);if(config.stateRoot.startsWith(repo+'/'))throw Error('维护状态必须保存在源码目录之外');
const auth=new MaintenanceAuth({root:config.stateRoot,resource:config.resource,adminHash:config.adminHash,clients:config.clients});
const service=new MaintenanceService({repoRoot:repo,stateRoot:config.stateRoot,runner:maintenanceRunner(config)});
const app=createMaintenanceApp(auth,service);
const cert=process.env.MAINTENANCE_TLS_CERT,key=process.env.MAINTENANCE_TLS_KEY;
if(Boolean(cert)!==Boolean(key))throw Error('维护 HTTPS 证书与私钥必须同时配置');
if(cert&&key){
 const credentials=()=>({cert:readFileSync(cert),key:readFileSync(key)});
 const server=createHttpsServer(credentials(),app);
 // Public binding is explicit; preparation and verification remain loopback-only.
 server.listen(config.port,process.env.MAINTENANCE_HOST??'127.0.0.1',()=>console.log('维护 HTTPS 服务已启动'));
 const reload=()=>{try{server.setSecureContext(credentials());}catch{console.error('维护证书更新失败，继续使用当前证书');}};
 process.on('SIGHUP',reload);
 const timer=setInterval(reload,600000);timer.unref();server.on('close',()=>clearInterval(timer));
}else{
 if(process.env.MAINTENANCE_HOST&&process.env.MAINTENANCE_HOST!=='127.0.0.1')throw Error('维护服务未配置 TLS，只允许本机访问');
 app.listen(config.port,'127.0.0.1',()=>console.log('维护服务已启动，仅监听本机端口 '+config.port));
}
