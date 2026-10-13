import { useEffect,useState,type ReactNode } from 'react';
import {removeSessionValue} from './safe-storage';

async function accountRequest<T>(path:string,options:RequestInit,read:(response:Response)=>Promise<T>):Promise<T>{
  const controller=new AbortController();
  let timer:number|undefined;
  try{
    const timeout=new Promise<never>((_,reject)=>{
      timer=window.setTimeout(()=>{controller.abort();reject(Error('请求超时，结果尚未确认，请检查网络后重试。'));},15_000);
    });
    return await Promise.race([fetch(path,{credentials:'same-origin',...options,signal:controller.signal}).then(read),timeout]);
  }catch(e){
    if(controller.signal.aborted)throw Error('请求超时，结果尚未确认，请检查网络后重试。');
    throw e;
  }finally{window.clearTimeout(timer);}
}

export function AccountLogin({children}:{children:(username:string,logout:()=>Promise<void>,switchAccount:()=>Promise<void>)=>ReactNode}){
  const [checking,setChecking]=useState(true),[configured,setConfigured]=useState<boolean|null>(null);
  const [user,setUser]=useState<string|null>(null),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [register,setRegister]=useState(false),[switching,setSwitching]=useState(false);
  async function check(){
    setChecking(true);setError('');
    try{
      const [info,session]=await Promise.all([
        accountRequest('/api/auth/status',{cache:'no-store'},async r=>{if(!r.ok)throw Error('暂时无法连接工作台，请检查服务后重试');return r.json();}),
        accountRequest('/api/auth/session',{cache:'no-store'},async r=>{if(r.status===401)return null;if(!r.ok)throw Error('暂时无法连接工作台，请检查服务后重试');return r.json();}),
      ]);
      setConfigured(info.configured);setUser(session?.username??null);
    }catch(e){setError(e instanceof Error?e.message:'连接失败');}
    finally{setChecking(false);}
  }
  useEffect(()=>{void check();},[]);
  async function login(){
    if(register&&Array.from(password).length<12){setError('新密码至少需要 12 个字符');return;}
    if(register&&new TextEncoder().encode(password).byteLength>72){setError('新密码按 UTF-8 编码最多 72 字节，请缩短后重试');return;}
    if(register&&password!==confirm){setError('两次输入的密码不一致');return;}
    setBusy(true);setError('');
    try{
      const value=await accountRequest('/api/auth/'+(register?'register':'login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})},async r=>{const value=await r.json();if(!r.ok)throw Error(value.message??'登录失败');return value;});
      setPassword('');setConfirm('');setConfigured(true);setUser(value.username);setSwitching(false);
    }catch(e){setError(e instanceof Error?e.message:'连接失败，请重试');}
    finally{setBusy(false);}
  }
  async function logout(){
    setBusy(true);setError('');
    try{
      await accountRequest('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},async r=>{if(!r.ok)throw Error('退出失败，请重试');});
      removeSessionValue('matrix.pendingPairing');
      setUser(null);setUsername('');setPassword('');setConfirm('');setRegister(false);setSwitching(false);
    }catch(e){setError(e instanceof Error?e.message:'退出失败，请重试');throw e;}
    finally{setBusy(false);}
  }
  async function switchAccount(){
    setBusy(true);setError('');
    try{
      await accountRequest('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},async r=>{if(!r.ok)throw Error('切换账号失败，请重试');});
      removeSessionValue('matrix.pendingPairing');
      setUser(null);setUsername('');setPassword('');setConfirm('');setRegister(false);setSwitching(true);
    }catch(e){setError(e instanceof Error?e.message:'切换账号失败，请重试');}
    finally{setBusy(false);}
  }
  if(user)return <>{error&&<p className="login-error" role="alert">{error}</p>}{children(user,logout,switchAccount)}</>;
  return <main className="account-login"><div className="login-brand">华科未来·矩阵云 <span>华科未来 · 内容与账号，一处管理</span></div><section className="login-card">
    {checking?<p role="status">正在连接你的工作台…</p>:configured===null?<><h1>暂时无法连接</h1><p role="alert">{error}</p><button className="primary" onClick={()=>void check()}>重新连接</button></>:<>
      <div className="login-eyebrow">{switching?'切换账号':register?'创建账号':'欢迎来到矩阵云'}</div><h1>{register?'创建你的工作台':switching?'登录其他工作台账号':'登录你的工作台'}</h1>
      <p>{register?'创建后即可进入独立工作区，内容与设置分别保存。':switching?'输入另一个系统账号即可切换工作区。':'使用已有账号和密码继续管理你的内容。'}</p>
      <form onSubmit={e=>{e.preventDefault();void login();}}>
        <label>账号<input autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e=>setUsername(e.target.value)} minLength={3} maxLength={40} pattern="[a-zA-Z0-9_.\-]+" required placeholder="英文、数字或 ._-，至少 3 位"/></label>
        <label>密码<input type="password" autoComplete={!register?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)} minLength={register?12:1} maxLength={register?72:128} required placeholder={!register?'输入你的密码':'至少 12 个字符'}/></label>
        {register&&<><small>新密码至少 12 个字符，按 UTF-8 编码最多 72 字节；常用汉字每字 3 字节，表情通常 4 字节。</small><label>确认密码<input type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required minLength={12} maxLength={72} placeholder="再次输入密码"/></label></>}
        {error&&<p className="login-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy?'正在处理…':register?'创建账号并进入':'登录工作台'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={()=>{setRegister(v=>!v);setError('');setPassword('');setConfirm('');}}>{register?'已有账号，返回登录':'创建新账号'}</button>
        <small>登录状态保留 8 小时，可随时退出。请妥善保管密码。</small>
      </form>
    </>}
  </section><p className="login-footnote">密码不会以明文保存 · 你的内容按账号独立保存</p></main>;
}
