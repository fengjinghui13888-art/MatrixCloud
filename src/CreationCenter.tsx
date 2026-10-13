import { useEffect, useRef, useState } from 'react';
import type { CreationTask } from '../server/creation-queue';

export type CreationDraft={title:string;body:string;images:string[]};
export function CreationCenter({request,onUse}:{request:(path:string,body?:unknown)=>Promise<any>;onUse:(draft:CreationDraft)=>void}){
  const [form,setForm]=useState({topic:'',sellingPoints:'',audience:'',style:'',imageCount:3});
  const [tasks,setTasks]=useState<CreationTask[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [choices,setChoices]=useState<Record<string,string>>({});
  const requestId=useRef((globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)),initialRequest=useRef(request);
  useEffect(()=>{let active=true;const refresh=()=>initialRequest.current('creation-tasks').then(value=>{if(active){setTasks(value);setError('');}}).catch(()=>{if(active)setError('暂时无法获取创作结果，请刷新重试。');});void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},10000);return()=>{active=false;clearInterval(timer);};},[]);
  const [direct,setDirect]=useState(false),[charge,setCharge]=useState(false);
  useEffect(()=>{let active=true;initialRequest.current('models').then(value=>{if(active)setDirect(!!value);}).catch(()=>{});return()=>{active=false;};},[]);
  const statuses:Record<string,string>={queued:'等待处理',running:'正在创作',completed:'图文已生成',partial:'部分完成',failed:'生成失败'};
  return <section className="creation-center"><form className="grey-panel model-settings" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{let task=await request('creation-tasks',{...form,requestId:requestId.current});setTasks(old=>[task,...old.filter(t=>t.id!==task.id)]);if(direct&&charge){setMessage('正在后台生成标题正文，无需切换页面。');task=await request('creation-tasks/'+task.id+'/run-text',{confirmCharge:true});setTasks(old=>[task,...old.filter(t=>t.id!==task.id)]);setMessage(task.message);}else setMessage('创作要求已保存，等待处理。');}catch(e){setError(String(e));}finally{setBusy(false);}}}>
    <div className="creation-heading"><div><h2>AI 图文创作</h2><p>告诉我们你想写什么，标题、文案和配图会回到这里。</p></div><span className="creation-badge">智能创作</span></div>
    <div className="model-fields">{([{key:'topic',label:'创作主题',placeholder:'例如：介绍新款通勤背包',max:500},{key:'sellingPoints',label:'产品卖点与事实',placeholder:'填写真实材质、用途与特点',max:2000},{key:'audience',label:'目标人群',placeholder:'例如：城市通勤人群',max:500},{key:'style',label:'文案与图片风格',placeholder:'例如：自然分享，简洁生活摄影',max:500}] as const).map(item=><label key={item.key}>{item.label}<input required={item.key==='topic'} maxLength={item.max} placeholder={item.placeholder} value={form[item.key]} onChange={e=>{setForm(old=>({...old,[item.key]:e.target.value}));requestId.current=(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);}}/></label>)}
    <label>配图数量<select value={form.imageCount} onChange={e=>{setForm(old=>({...old,imageCount:Number(e.target.value)}));requestId.current=(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);}}>{Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>{i+1} 张</option>)}</select></label></div>
    <p className="media-caption">使用已配置的模型与生图服务，生成后先审核，再带入发布表单确认。</p>
    {direct&&<label className="consent"><input type="checkbox" checked={charge} onChange={e=>setCharge(e.target.checked)}/>确认使用当前工作区的模型额度生成标题正文</label>}<button className="primary" disabled={busy||(direct&&!charge)}>{busy?'正在后台处理…':direct?'生成标题与正文':'保存创作要求'}</button>{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
  </form>
  {tasks.map(task=><article className="grey-panel" key={task.id}><div className="creation-heading"><h3>{task.topic}</h3><span className="creation-badge">{statuses[task.status]??task.status}</span></div>
    {task.status==='queued'&&<p className="media-caption">任务已创建，生成服务准备中。</p>}
    {task.status==='running'&&<p>任务正在处理中，结果会自动回传。此页面每 10 秒检查一次。</p>}
    {task.message&&<p>{task.message}</p>}
    {!!task.titles?.length&&<label>选择标题<select aria-label={`标题选择 ${task.id}`} value={choices[task.id]??task.titles[0]} onChange={e=>setChoices(old=>({...old,[task.id]:e.target.value}))}>{task.titles.map(title=><option key={title}>{title}</option>)}</select></label>}
    {task.body&&<p className="note-full-text">{task.body}</p>}
    {!!task.images?.length&&<div className="creation-images">{task.images.map((url,index)=><GeneratedImage key={url+index} url={url} index={index}/>)}</div>}
    {task.imageProvider&&<p className="media-caption">生图服务：{task.imageProvider} · 图片由执行端回传；长期保存取决于服务商链接有效期。</p>}
    {!!task.titles?.length&&task.body&&<button className="primary" onClick={()=>onUse({title:choices[task.id]??task.titles![0],body:task.body!,images:task.images??[]})}>带入发布表单继续编辑</button>}
  </article>)}
  </section>;
}
function GeneratedImage({url,index}:{url:string;index:number}){const [failed,setFailed]=useState(false);return failed?<div className="content-missing">第 {index+1} 张图片暂时无法加载，请检查生成链接。</div>:<a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`生成配图 ${index+1}`} loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/></a>;}
