import type { Express, Request, Response } from 'express';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { runSqlite } from './sqlite-client';
import { z } from 'zod';

const derive=promisify(scrypt);
const credentials=z.object({username:z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/).transform(s=>s.toLowerCase()),password:z.string().min(12).max(72).refine(value=>Buffer.byteLength(value,'utf8')<=72)}).strict();
const cookieName='zhixu_session';const duration=8*60*60*1000;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";

export function createAccountAuth(dir:string,publicOrigin?:string,platformUsername?:string){
  mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'accounts.sqlite');
  const sql=(query:string)=>runSqlite(file,query).trim();
  sql('CREATE TABLE IF NOT EXISTS administrator(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);');chmodSync(file,0o600);
  sql(`CREATE TABLE IF NOT EXISTS login_users(username TEXT PRIMARY KEY,salt TEXT NOT NULL,hash TEXT NOT NULL,workspace TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS session_users(session_hash TEXT PRIMARY KEY,username TEXT NOT NULL);
    INSERT OR IGNORE INTO login_users SELECT username,salt,hash,'owner',username FROM administrator;
    INSERT OR IGNORE INTO session_users SELECT sessions.hash,administrator.username FROM sessions CROSS JOIN administrator;`);
  const configured=()=>sql('SELECT count(*) FROM administrator;')==='1';
  function sessionId(req:Request){const value=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';return /^[a-f0-9]{64}$/.test(value)?value:'';}
  function user(req:Request){const id=sessionId(req);if(!id)return null;const username=sql(`SELECT u.username FROM session_users u JOIN sessions s ON s.hash=u.session_hash WHERE s.hash=${quote(digest(id))} AND s.expires>${Date.now()};`);return username||null;}
  function workspace(req:Request){const username=user(req);return username?sql(`SELECT workspace FROM login_users WHERE username=${quote(username)};`):null;}
  function sameOrigin(req:Request){const origin=req.get('origin');const expected=publicOrigin??`${req.protocol}://${req.get('host')}`;return !!origin&&origin===expected&&req.get('sec-fetch-site')!=='cross-site';}
  function localSetup(req:Request){const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip??'');return local&&/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.get('host')??'');}
  function issue(req:Request,res:Response,username:string){const id=randomBytes(32).toString('hex');sql(`BEGIN; DELETE FROM sessions WHERE expires<=${Date.now()} OR hash=${quote(digest(sessionId(req)))}; DELETE FROM session_users WHERE session_hash NOT IN (SELECT hash FROM sessions); INSERT INTO sessions(hash,expires) VALUES(${quote(digest(id))},${Date.now()+duration}); INSERT INTO session_users VALUES(${quote(digest(id))},${quote(username)}); COMMIT;`);res.cookie(cookieName,id,{httpOnly:true,sameSite:'strict',secure:publicOrigin?.startsWith('https:')||req.secure,path:'/api',maxAge:duration});}
  function routes(app:Express){
    const attempts=new Map<string,{count:number;until:number}>();
    app.use('/api/auth',(_,res,next)=>{res.set('Cache-Control','no-store');next();});
    app.get('/api/auth/status',(req,res)=>res.json({configured:configured(),setupAllowed:localSetup(req)}));
    app.get('/api/auth/session',(req,res)=>{const username=user(req);return username?res.json({username}):res.status(401).json({message:'请登录工作台'});});
    app.get('/api/auth/profile',(req,res)=>{const username=user(req);if(!username)return res.status(401).json({message:'请登录'});return res.json({username,displayName:sql(`SELECT display_name FROM login_users WHERE username=${quote(username)};`),workspace:workspace(req),sessionHours:8});});
    app.use(['/api/auth/setup','/api/auth/login','/api/auth/logout','/api/auth/register'],(req,res,next)=>{
      if(req.method!=='POST')return res.sendStatus(405);
      if(!sameOrigin(req)||!req.is('application/json'))return res.status(403).json({message:'请从工作台页面操作'});
      next();
    });
    app.post('/api/auth/setup',async(req,res)=>{
      if(!localSetup(req))return res.status(403).json({message:'首次初始化请在服务器本机完成'});
      if(configured())return res.status(409).json({message:'管理员已创建，请直接登录'});
      const parsed=credentials.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'账号需为 3–40 位英文、数字或 ._-；密码至少 12 个字符，UTF-8 不超过 72 字节'});
      const salt=randomBytes(16).toString('hex');const hash=(await derive(parsed.data.password,salt,64) as Buffer).toString('hex');
      const changed=sql(`BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO administrator SELECT 1,${quote(parsed.data.username)},${quote(salt)},${quote(hash)} WHERE NOT EXISTS(SELECT 1 FROM login_users WHERE username=${quote(parsed.data.username)} OR workspace='owner');
        INSERT OR IGNORE INTO login_users SELECT username,salt,hash,'owner',username FROM administrator WHERE username=${quote(parsed.data.username)} AND salt=${quote(salt)};
        SELECT changes(); COMMIT;`);
      if(changed!=='1')return res.status(409).json({message:'管理员或此账号已存在，请登录或使用其他账号名'});
      issue(req,res,parsed.data.username);return res.status(201).json({username:parsed.data.username});
    });
    app.post(['/api/auth/login','/api/auth/register'],async(req,res)=>{
      const now=Date.now();for(const [key,value] of attempts)if(value.until<=now)attempts.delete(key);
      const ip=req.ip??'unknown';const bucket=attempts.get(ip)??{count:0,until:now+15*60*1000};
      if(bucket.count>=10||attempts.size>=5000)return res.status(429).json({message:'尝试次数过多，请 15 分钟后重试'});
      bucket.count++;attempts.set(ip,bucket);
      if(req.path.endsWith('/register')){
        const parsed=credentials.safeParse(req.body);if(!parsed.success)return res.status(400).json({message:'账号需为 3–40 位英文、数字或 ._-；密码至少 12 个字符，UTF-8 不超过 72 字节'});
        if(parsed.data.username===platformUsername?.trim().toLowerCase())return res.status(409).json({message:'此账号名由平台保留，请使用其他账号名'});
        const salt=randomBytes(16).toString('hex');const hash=(await derive(parsed.data.password,salt,64) as Buffer).toString('hex');
        const workspace=randomUUID();
        const changed=sql(`INSERT OR IGNORE INTO login_users VALUES(${quote(parsed.data.username)},${quote(salt)},${quote(hash)},${quote(workspace)},${quote(parsed.data.username)}); SELECT changes();`);
        if(changed!=='1')return res.status(409).json({message:'此账号已存在，请登录或使用其他账号名'});
        issue(req,res,parsed.data.username);return res.status(201).json({username:parsed.data.username,workspace});
      }
      const input=z.object({username:z.string().trim().max(40),password:z.string().max(128)}).safeParse(req.body);
      if(!input.success)return res.status(401).json({message:'账号或密码不正确'});
      const saved=sql(`SELECT username,salt,hash FROM login_users WHERE username=${quote(input.data.username.toLowerCase())};`).split('|');
      const actual=await derive(input.data.password,saved[1]??'unknown-account-salt',64) as Buffer;
      const expected=saved[2]?Buffer.from(saved[2],'hex'):Buffer.alloc(64);
      if(expected.length!==actual.length||!timingSafeEqual(actual,expected)||saved[0]!==input.data.username.toLowerCase())return res.status(401).json({message:'账号或密码不正确'});
      attempts.delete(ip);issue(req,res,saved[0]);return res.json({username:saved[0]});
    });
    app.post('/api/auth/profile',(req,res)=>{
      const username=user(req);if(!username)return res.status(401).json({message:'请登录'});
      if(!sameOrigin(req)||!req.is('application/json'))return res.status(403).json({message:'请从工作台操作'});
      const parsed=z.object({displayName:z.string().trim().min(1).max(40).regex(/^[^\r\n]+$/)}).strict().safeParse(req.body);
      if(!parsed.success)return res.status(400).json({message:'昵称需为 1–40 个字符'});
      sql(`UPDATE login_users SET display_name=${quote(parsed.data.displayName)} WHERE username=${quote(username)};`);return res.json({username,displayName:parsed.data.displayName});
    });
    app.post('/api/auth/logout',(req,res)=>{const id=sessionId(req);if(id)sql(`DELETE FROM sessions WHERE hash=${quote(digest(id))};`);res.clearCookie(cookieName,{httpOnly:true,sameSite:'strict',secure:publicOrigin?.startsWith('https:')||req.secure,path:'/api'});res.json({ok:true});});
  }
  return {routes,user,sameOrigin,workspace};
}
