import {configureTrustedProxy} from './trusted-proxy';
import {MaintenanceCleanup} from './maintenance-cleanup';
import express from 'express';
import {randomBytes,createHash} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {mcpAuthRouter,createOAuthMetadata,getOAuthProtectedResourceMetadataUrl} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {z} from 'zod';
import {MaintenanceAuth,maintenanceScopes,escapeHtml} from './maintenance-auth';
import {MaintenanceService} from './maintenance-service';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const text=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});

export function createMaintenanceApp(auth:MaintenanceAuth,service:MaintenanceService){
 const app=express(),resource=new URL(auth.options.resource),origin=resource.origin;
 configureTrustedProxy(app);
 const cleanup=new MaintenanceCleanup(service.options.repoRoot,service.state);
 const tries=new Map<string,{count:number;until:number}>();
 app.disable('x-powered-by');app.use(express.json({limit:'300kb'}));app.use(express.urlencoded({extended:false,limit:'8kb'}));
 app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});if(req.get('origin')&&req.get('origin')!==origin)return res.status(403).json({message:'来源不允许'});next();});
 app.get('/maintenance/health',(_req,res)=>res.json({ok:true,service:'matrix-maintenance'}));
 app.get('/.well-known/oauth-authorization-server',(_req,res)=>res.json({...createOAuthMetadata({provider:auth,issuerUrl:new URL(origin),scopesSupported:maintenanceScopes}),authorization_response_iss_parameter_supported:true}));
 app.use(mcpAuthRouter({provider:auth,issuerUrl:new URL(origin),resourceServerUrl:resource,scopesSupported:maintenanceScopes}));
 const cookie=(req:express.Request)=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('matrix_maintenance_csrf='))?.slice('matrix_maintenance_csrf='.length);
 function form(res:express.Response,id:string,body:string){res.cookie('matrix_maintenance_csrf',id,{httpOnly:true,secure:true,sameSite:'lax',path:'/maintenance',maxAge:300000});res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>矩阵云维护授权</title><body>${body}</body></html>`);}
 function verifyForm(req:express.Request){if(req.get('origin')!==origin||typeof req.body.csrf!=='string'||req.body.csrf!==cookie(req))throw Error('页面验证已失效，请重新打开');const key=req.ip??'unknown',now=Date.now(),entry=tries.get(key);if(entry&&entry.until>now&&entry.count>=5)throw Error('验证次数过多，请一分钟后重试');if(tries.size>1000)for(const [k,v] of tries)if(v.until<now)tries.delete(k);tries.set(key,{count:entry&&entry.until>now?entry.count+1:1,until:entry&&entry.until>now?entry.until:now+60000});}
 app.get('/maintenance/consent',(req,res)=>{try{const p=auth.pending(String(req.query.id));form(res,p.id,`<h1>允许客户端维护矩阵云</h1><p>客户端：${escapeHtml(p.clientId)}</p><p>权限：${escapeHtml(p.scopes.join('、'))}</p><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(p.id)}"><label>维护管理员密码 <input name="password" type="password" required autocomplete="current-password"></label><button>授权</button></form>`);}catch{res.status(400).send('授权请求无效或已过期');}});
 app.post('/maintenance/consent',(req,res)=>{try{verifyForm(req);res.redirect(auth.consent(req.body.csrf,String(req.body.password??'')));}catch(e){res.status(403).send(escapeHtml(String((e as Error).message)));}});
 app.get('/maintenance/releases/:id/approve',(req,res)=>{const release=service.state.get('release',req.params.id);if(!z.string().uuid().safeParse(req.params.id).success||!release||release.status!=='prepared')return res.status(404).send('发布版本不存在或已执行');auth.state.pruneExpiring(['approval-form'],Date.now());if(auth.state.list('approval-form').length>=100)return res.status(429).send('确认请求过多，请稍后重试');const nonce=randomBytes(32).toString('hex');auth.state.put('approval-form',hash(nonce),{releaseId:req.params.id,expires:Date.now()+300000,stage:'login'});form(res,nonce,`<h1>管理员审查发布版本</h1><form method="post"><input type="hidden" name="csrf" value="${nonce}"><label>维护管理员密码 <input name="password" type="password" required autocomplete="current-password"></label><button>验证并查看差异</button></form>`);});
 app.post('/maintenance/releases/:id/approve',(req,res)=>{try{
  verifyForm(req);const pending=auth.state.get('approval-form',hash(req.body.csrf));
  if(!pending||pending.releaseId!==req.params.id||pending.expires<Date.now()||!auth.verifyAdministrator(String(req.body.password??'')))throw Error('发布确认验证失败');
  const release=service.state.get('release',req.params.id);if(!release||release.status!=='prepared')throw Error('发布版本不存在或已执行');
  auth.state.remove('approval-form',hash(req.body.csrf));
  if(pending.stage==='login'){
   const nonce=randomBytes(32).toString('hex');auth.state.put('approval-form',hash(nonce),{releaseId:release.id,commit:release.commit,imageDigest:release.imageDigest,expires:Date.now()+300000,stage:'review'});
   return form(res,nonce,`<h1>确认维护版本上线</h1><p>版本：${escapeHtml(release.commit)}</p><p>镜像：${escapeHtml(release.imageDigest)}</p><pre>${escapeHtml(service.releaseDiff(release.id))}</pre><p>超过显示上限的差异须在维护客户端完整审查。</p><form method="post"><input type="hidden" name="csrf" value="${nonce}"><label><input type="checkbox" name="compatible" value="yes" required>已审查完整差异、检查结果、备份及数据库回滚兼容性</label><p><label>维护管理员密码 <input name="password" type="password" required autocomplete="current-password"></label></p><button>确认此版本，15分钟内有效</button></form>`);
  }
  if(pending.stage!=='review'||pending.commit!==release.commit||pending.imageDigest!==release.imageDigest||req.body.compatible!=='yes')throw Error('版本确认已失效');
  service.approveRelease(req.params.id,'owner');res.send('已确认此版本，可返回维护客户端执行上线。');
 }catch(e){res.status(403).send(escapeHtml((e as Error).message));}});
 app.all(resource.pathname,requireBearerAuth({verifier:auth,resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(resource)}),async(req,res)=>{
  if(req.method!=='POST')return res.status(405).set('Allow','POST').end();
  const server=new McpServer({name:'matrix-cloud-maintenance',version:'1.0.0'}),scopes=req.auth!.scopes;
  const register=(name:string,description:string,scope:string,inputSchema:any,readOnly:boolean,fn:(args:any)=>unknown)=>{if(!scopes.includes(scope))return;server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:readOnly,openWorldHint:false}},async(args:any)=>{try{const result=await fn(args);service.state.audit('owner','mcp:'+name,'', 'ok');return text(result);}catch(e){service.state.audit('owner','mcp:'+name,'','failed');return {...text({message:(e as Error).message}),isError:true};}});};
  register('maintenance_context','读取当前版本、问题摘要和最近维护作业。','maintenance:read',{},true,()=>service.context());
  register('source_read','按行读取受保护的版本化源码，最多200行。','maintenance:read',{path:z.string(),start:z.number().int().min(1).default(1),lines:z.number().int().min(1).max(200).default(100),change_id:z.string().uuid().optional()},true,a=>service.readSource(a.path,a.start,a.lines,a.change_id));
  register('source_search','搜索源码，最多返回50条。','maintenance:read',{query:z.string().min(1).max(200)},true,a=>service.searchSource(a.query));
  register('change_create','从当前提交创建隔离修改工作区。','maintenance:write',{base_commit:z.string().regex(/^[a-f0-9]{40}$/)},false,a=>service.createChange(a.base_commit));
  register('source_hash','读取补丁所需的文件哈希，新文件返回null。','maintenance:read',{change_id:z.string().uuid(),path:z.string()},true,a=>service.fileHash(a.change_id,a.path));
  register('change_apply','更新指定文件；必须匹配读取时的哈希，自动生成版本。','maintenance:write',{change_id:z.string().uuid(),path:z.string(),content:z.string().max(256000),expected_hash:z.string().nullable()},false,a=>service.applyPatch(a.change_id,a.path,a.content,a.expected_hash));
  register('change_diff','返回本次修改差异，最多32KB。','maintenance:read',{change_id:z.string().uuid(),offset:z.number().int().min(0).default(0)},true,a=>service.diff(a.change_id,a.offset));
  register('checks_run','在无生产凭证的隔离环境执行固定测试及构建，返回作业编号。','maintenance:write',{change_id:z.string().uuid()},false,a=>service.submitJob('checks',()=>service.runChecks(a.change_id)));
  register('job_status','查询异步作业状态及摘要。','maintenance:read',{job_id:z.string().uuid()},true,a=>service.job(a.job_id));
  register('release_prepare','构建已通过检查的版本；完成后管理员在确认页面审查。','maintenance:release',{change_id:z.string().uuid()},false,a=>service.submitJob('prepare',async()=>{const r=await service.prepareRelease(a.change_id);return {...r,approval_url:origin+'/maintenance/releases/'+r.id+'/approve'};}));
  register('release_deploy','部署管理员已确认的精确版本，确认只使用一次。','maintenance:release',{release_id:z.string().uuid()},false,a=>service.submitJob('deploy',()=>service.deployRelease(a.release_id)));
  register('rollback_prepare','选择已验证版本准备回滚；仍需管理员确认。','maintenance:release',{release_id:z.string().uuid()},false,a=>{const r=service.prepareRollback(a.release_id);return {...r,approval_url:origin+'/maintenance/releases/'+r.id+'/approve'};});
  register('cleanup_preview','列出本项目可重建缓存和过期安装包；不含客户数据、源码或浏览器登录目录。','maintenance:cleanup',{},true,()=>cleanup.preview());
  register('cleanup_apply','已验证发布后按清单哈希清理，发生变化的文件跳过。','maintenance:cleanup',{manifest_id:z.string().uuid(),release_id:z.string().uuid()},false,a=>{if(service.state.get('release',a.release_id)?.status!=='deployed')throw Error('必须先完成已验证发布');return cleanup.apply(a.manifest_id);});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void server.close();});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch{if(!res.headersSent)res.status(500).json({message:'维护请求未完成，请查询作业状态'});}
 });
 return app;
}
