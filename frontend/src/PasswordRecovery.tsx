import {useState} from 'react';

export function PasswordRecovery({initialUsername,onBack,onComplete,submit}:{initialUsername:string;onBack:()=>void;onComplete:(username:string)=>void;submit:(body:{username:string;code:string;password:string})=>Promise<unknown>}){
 const [username,setUsername]=useState(initialUsername),[code,setCode]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function reset(){
  if(busy)return;
  if(Array.from(password).length<12||new TextEncoder().encode(password).byteLength>72){setError('新密码至少 12 个字符，UTF-8 不超过 72 字节');return;}
  if(password!==confirm){setError('两次输入的新密码不一致');return;}
  setBusy(true);setError('');
  try{await submit({username:username.trim(),code:code.trim(),password});setPassword('');setConfirm('');setCode('');onComplete(username.trim());}
  catch(e){setError(e instanceof Error?e.message:'暂时无法重设，请稍后重试');}
  finally{setBusy(false);}
 }
 return <main className="account-login"><div className="login-brand">华科未来·矩阵云 <span>华科未来 · 内容与账号，一处管理</span></div><section className="login-card">
  <div className="login-eyebrow">找回账号</div><h1>重设登录密码</h1>
  <p>请联系工作台管理员，核实账号后获取一次性恢复码。恢复码 15 分钟内有效，只能使用一次。</p>
  <p>当前未接入邮件或短信找回。重设后原来的小红书账号、内容和配置都会保留。</p>
  <form onSubmit={e=>{e.preventDefault();void reset();}}>
   <label>账号<input autoComplete="username" required maxLength={40} value={username} onChange={e=>setUsername(e.target.value)} disabled={busy}/></label>
   <label>一次性恢复码<input autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={101} value={code} onChange={e=>setCode(e.target.value)} disabled={busy}/></label>
   <label>新密码<input type="password" autoComplete="new-password" required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
   <label>确认新密码<input type="password" autoComplete="new-password" required value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy}/></label>
   {error&&<p className="login-error" role="alert">{error}</p>}
   <button className="primary" disabled={busy}>{busy?'正在重设…':'重设密码'}</button>
   <button type="button" className="ghost" disabled={busy} onClick={onBack}>返回登录</button>
  </form>
 </section></main>;
}
