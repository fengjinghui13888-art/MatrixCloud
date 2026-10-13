import type {Express,Request,Response} from 'express';
import {createHash,randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {Postgres,type AsyncMethods} from './postgres';
import type {createAccountAuth} from './account-auth';
export type Role='admin'|'operator'|'lead_viewer';
export type Identity={username:string;workspace:string;displayName:string;role:Role};
export type Auth=AsyncMethods<ReturnType<typeof createAccountAuth>>&{identity?:(req:Request)=>Promise<Identity|null>;active?:(tenant:string)=>Promise<boolean>};
const derive=promisify(scrypt),cookieName='zhixu_session',duration=8*60*60*1000;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const credentials=z.object({username:z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/).transform(s=>s.toLowerCase()),password:z.string().min(12).max(72).refine(value=>Buffer.byteLength(value,'utf8')<=72)}).strict();
const role=z.enum(['admin','operator','lead_viewer']);
export function createTenantAuth(db:Postgres,publicOrigin?:string,platformUsername?:string):Auth{
  const sessionId=(req:Request)=>{const v=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';return /^[a-f0-9]{64}$/.test(v)?v:'';};
  const sameOrigin=(req:Request)=>!!req.get('origin')&&req.get('origin')===(publicOrigin??`${req.protocol}://${req.get('host')}`)&&req.get('sec-fetch-site')!=='cross-site';
  const localSetup=(req:Request)=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip??'')&&/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.get('host')??'');
  const identity=async(req:Request):Promise<Identity|null>=>{if(!sessionId(req))return null;const r=await db.pool.query(`SELECT u.username,u.tenant_id AS workspace,u.display_name AS "displayName",u.role FROM login_session s JOIN app_user u ON u.tenant_id=s.tenant_id AND u.username=s.username JOIN tenant t ON t.tenant_id=u.tenant_id WHERE s.hash=$1 AND s.expires>$2 AND u.enabled AND t.enabled`,[digest(sessionId(req)),Date.now()]);return r.rows[0]??null;};
  const configured=async()=>!!(await db.pool.query("SELECT 1 FROM app_user WHERE tenant_id='owner'")).rowCount;
  const issue=async(req:Request,res:Response,u:{username:string;workspace:string})=>{
    const token=randomBytes(32).toString('hex');
    await db.transaction(u.workspace,async s=>{await s.query('DELETE FROM login_session WHERE expires<=$1 OR hash=$2',[Date.now(),digest(sessionId(req))]);await s.query('INSERT INTO login_session VALUES($1,$2,$3,$4)',[digest(token),u.workspace,u.username,Date.now()+duration]);});
    res.cookie(cookieName,token,{httpOnly:true,sameSite:'strict',secure:publicOrigin?.startsWith('https:')||req.secure,path:'/api',maxAge:duration});
  };
  async function verify(password:string,saved:any){
    if(saved?.password_hash.startsWith('$2'))return Buffer.byteLength(password)<=72&&bcrypt.compare(password,saved.password_hash);
    const actual=await derive(password,saved?.password_salt??'unknown-account-salt',64) as Buffer,expected=saved?Buffer.from(saved.password_hash,'hex'):Buffer.alloc(64);
    return !!saved&&actual.length===expected.length&&timingSafeEqual(actual,expected);
  }
  function routes(app:Express){
    app.use('/api/auth',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
    app.use('/api/auth',(req,res,next)=>{if(['GET','HEAD','OPTIONS'].includes(req.method))return next();if(!sameOrigin(req)||!req.is('application/json'))return res.status(403).json({message:'请从工作台页面操作'});next();});
    app.get('/api/auth/status',async(req,res)=>res.json({configured:await configured(),setupAllowed:localSetup(req)}));
    app.get('/api/auth/session',async(req,res)=>{const u=await identity(req);return u?res.json(u):res.status(401).json({message:'请登录工作台'});});
    app.get('/api/auth/profile',async(req,res)=>{const u=await identity(req);return u?res.json({...u,sessionHours:8}):res.status(401).json({message:'请登录'});});
    app.post('/api/auth/profile',async(req,res)=>{const u=await identity(req);if(!u)return res.sendStatus(401);const p=z.object({displayName:z.string().trim().min(1).max(40).regex(/^[^\r\n]+$/)}).strict().safeParse(req.body);if(!p.success)return res.status(400).json({message:'昵称需为 1–40 个字符'});await db.pool.query('UPDATE app_user SET display_name=$1 WHERE tenant_id=$2 AND username=$3',[p.data.displayName,u.workspace,u.username]);return res.json({...u,displayName:p.data.displayName});});
    app.post(['/api/auth/setup','/api/auth/register','/api/auth/login'],async(req,res)=>{
      const key=digest(req.ip??'unknown'),stamp=Math.floor(Date.now()/900000);
      const count=await db.pool.query('INSERT INTO login_limit VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_limit.bucket=excluded.bucket THEN login_limit.count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count',[key,stamp]);
      if(count.rows[0].count>10)return res.status(429).json({message:'尝试次数过多，请 15 分钟后重试'});
      if(req.path.endsWith('/login')){
        const parsed=z.object({username:z.string().trim().max(40).transform(s=>s.toLowerCase()),password:z.string().max(128)}).safeParse(req.body);if(!parsed.success)return res.status(401).json({message:'账号或密码不正确'});
        const u=(await db.pool.query('SELECT u.*,t.enabled AS tenant_enabled FROM app_user u JOIN tenant t ON t.tenant_id=u.tenant_id WHERE username=$1',[parsed.data.username])).rows[0];
        if(!await verify(parsed.data.password,u)||!u?.enabled||!u?.tenant_enabled)return res.status(401).json({message:'账号或密码不正确，或账号已停用'});
        // Existing scrypt credentials remain valid; upgrade only after successful verification.
        if(!u.password_hash.startsWith('$2')&&Buffer.byteLength(parsed.data.password)<=72)await db.pool.query("UPDATE app_user SET password_hash=$1,password_salt='' WHERE username=$2 AND password_hash=$3",[await bcrypt.hash(parsed.data.password,12),u.username,u.password_hash]);
        await db.pool.query('DELETE FROM login_limit WHERE key=$1',[key]);await issue(req,res,{username:u.username,workspace:u.tenant_id});await db.audit(u.tenant_id,u.username,'login','session','success');return res.json({username:u.username,role:u.role,workspace:u.tenant_id});
      }
      const setup=req.path.endsWith('/setup');if(setup&&!localSetup(req))return res.status(403).json({message:'首次初始化请在服务器本机完成'});
      const p=credentials.safeParse(req.body);if(!p.success)return res.status(400).json({message:'账号需为 3–40 位英文、数字或 ._-；密码至少 12 个字符，UTF-8 不超过 72 字节'});
      if(!setup&&p.data.username===platformUsername?.trim().toLowerCase())return res.status(409).json({message:'此账号名由平台保留，请使用其他账号名'});
      const hash=await bcrypt.hash(p.data.password,12);
      try{
        const tenant=await db.transaction('owner',async s=>{
          await s.query("SELECT pg_advisory_xact_lock(hashtextextended('matrix-registration',0))");
          if(setup&&(await s.query("SELECT 1 FROM app_user WHERE tenant_id='owner'")).rowCount)throw Error('管理员已创建，请直接登录');
          const id=setup?'owner':randomUUID();
          await s.query('INSERT INTO tenant(tenant_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,p.data.username]);
          await s.query("INSERT INTO app_user(tenant_id,username,password_hash,display_name,role) VALUES($1,$2,$3,$2,'admin')",[id,p.data.username,hash]);
          return id;
        });
        await issue(req,res,{username:p.data.username,workspace:tenant});return res.status(201).json({username:p.data.username,role:'admin',workspace:tenant});
      }catch{return res.status(409).json({message:'此账号已存在，请登录或使用其他账号名'});}
    });
    app.post('/api/auth/logout',async(req,res)=>{await db.pool.query('DELETE FROM login_session WHERE hash=$1',[digest(sessionId(req))]);res.clearCookie(cookieName,{httpOnly:true,sameSite:'strict',secure:publicOrigin?.startsWith('https:')||req.secure,path:'/api'});res.json({ok:true});});
    app.use('/api/auth/team',async(req,res,next)=>{const u=await identity(req);if(!u)return res.sendStatus(401);if(u.role!=='admin')return res.status(403).json({message:'仅客户管理员可管理成员'});res.locals.identity=u;next();});
    app.get('/api/auth/team',async(_req,res)=>{const u=res.locals.identity as Identity;const r=await db.pool.query('SELECT username,display_name AS "displayName",role,enabled FROM app_user WHERE tenant_id=$1 ORDER BY created_at,username',[u.workspace]);res.json({items:r.rows,currentUsername:u.username});});
    app.post('/api/auth/team',async(req,res)=>{
      const u=res.locals.identity as Identity;const p=credentials.extend({role,displayName:z.string().trim().min(1).max(40)}).safeParse(req.body);if(!p.success)return res.status(400).json({message:'请填写账号、角色和至少 12 个字符的初始密码（UTF-8 不超过 72 字节）'});
      try{await db.pool.query('INSERT INTO app_user(tenant_id,username,password_hash,display_name,role) VALUES($1,$2,$3,$4,$5)',[u.workspace,p.data.username,await bcrypt.hash(p.data.password,12),p.data.displayName,p.data.role]);await db.audit(u.workspace,u.username,'member.create',p.data.username,'success');return res.status(201).json({ok:true});}catch{return res.status(409).json({message:'该登录账号已存在，请更换账号名'});}
    });
    app.post('/api/auth/team/:username',async(req,res)=>{
      const u=res.locals.identity as Identity,p=z.object({role:role.optional(),enabled:z.boolean().optional(),password:credentials.shape.password.optional()}).strict().safeParse(req.body);if(!p.success)return res.status(400).json({message:'成员设置不合法'});
      const target=String(req.params.username);if(target===u.username&&(p.data.enabled===false||p.data.role&&p.data.role!=='admin'))return res.status(409).json({message:'不能停用自己或移除自己的管理员权限'});
      const hash=p.data.password?await bcrypt.hash(p.data.password,12):null;
      try{await db.transaction(u.workspace,async s=>{await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[u.workspace+':team']);const member=(await s.query('SELECT role,enabled FROM app_user WHERE tenant_id=$1 AND username=$2 FOR UPDATE',[u.workspace,target])).rows[0];if(!member)throw Error('成员不存在');if(member.role==='admin'&&member.enabled&&(p.data.enabled===false||p.data.role&&p.data.role!=='admin')&&Number((await s.query("SELECT count(*) FROM app_user WHERE tenant_id=$1 AND role='admin' AND enabled",[u.workspace])).rows[0].count)<=1)throw Error('至少保留一位启用的管理员');await s.query("UPDATE app_user SET role=coalesce($3,role),enabled=coalesce($4,enabled),password_hash=coalesce($5,password_hash),password_salt=CASE WHEN $5::text IS NULL THEN password_salt ELSE '' END WHERE tenant_id=$1 AND username=$2",[u.workspace,target,p.data.role??null,p.data.enabled??null,hash]);await s.query('DELETE FROM login_session WHERE tenant_id=$1 AND username=$2',[u.workspace,target]);});await db.audit(u.workspace,u.username,'member.update',target,'success');return res.json({ok:true});}catch(e){return res.status(409).json({message:e instanceof Error?e.message:'更新失败'});}
    });
    app.get('/api/auth/audit',async(req,res)=>{const u=await identity(req);if(!u||u.role!=='admin')return res.sendStatus(403);return res.json({items:await db.rows(u.workspace,'SELECT actor,action,target,result,created_at AS "createdAt" FROM audit_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[u.workspace])});});
    app.use('/api/auth/tenants',async(req,res,next)=>{const u=await identity(req);if(!u||u.workspace!=='owner'||u.role!=='admin'||u.username!==platformUsername)return res.sendStatus(403);res.locals.identity=u;next();});
    app.get('/api/auth/tenants',async(_req,res)=>res.json({items:(await db.pool.query('SELECT tenant_id AS id,name,enabled,created_at AS "createdAt" FROM tenant ORDER BY created_at')).rows}));
    app.post('/api/auth/tenants/:id',async(req,res)=>{const id=String(req.params.id),p=z.object({enabled:z.boolean()}).strict().safeParse(req.body);if(id==='owner'||!p.success)return res.status(400).json({message:'不能停用平台所属客户'});const r=await db.pool.query('UPDATE tenant SET enabled=$2 WHERE tenant_id=$1 RETURNING tenant_id',[id,p.data.enabled]);if(!r.rowCount)return res.sendStatus(404);await db.audit('owner',res.locals.identity.username,'tenant.status',id,p.data.enabled?'enabled':'disabled');res.json({ok:true});});
  }
  return {routes,user:async req=>(await identity(req))?.username??null,workspace:async req=>(await identity(req))?.workspace??null,sameOrigin,identity,active:tenant=>db.active(tenant)};
}

export function roleAllows(role:Role,method:string,path:string){
  // Express routes are case-insensitive and accept a trailing slash.
  path=path.replace(/\/+$/,'').toLowerCase()||'/';
  if(role==='admin')return true;
  if(role==='lead_viewer')return ['GET','HEAD'].includes(method)&&['/api/operations','/api/leads'].includes(path);
  if(path.startsWith('/api/costs')&&method!=='GET')return false;
  if(path.startsWith('/api/admin')||path.startsWith('/api/auth/team'))return false;
  if(path.startsWith('/api/connector')&&method!=='GET')return method==='POST'&&(
    path==='/api/connector/pairings'||/^\/api\/connector\/pairings\/[^/]+\/cancel$/.test(path)||
    /^\/api\/connector\/devices\/[^/]+\/select$/.test(path)
  );
  if(path.startsWith('/api/models')&&method!=='GET')return ['/api/models/chat','/api/models/images'].includes(path);
  if(/^\/api\/studio\/[^/]+\/(claim|progress|receipt)$/.test(path))return false;
  return true;
}
