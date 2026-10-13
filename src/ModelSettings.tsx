import { useEffect, useRef, useState } from 'react';
import {ProviderPicker} from './ProviderPicker';

type Settings={label:string;protocol:string;baseUrl:string;model:string;imageModel?:string;imageBaseUrl?:string;hasImageKey?:boolean;hasKey?:boolean};
type Props={request:(path:string,body?:unknown)=>Promise<any>};
const initial:Settings={label:'',protocol:'chat-completions',baseUrl:'',model:'',imageModel:''};
async function generateImage(request:(path:string,body?:unknown)=>Promise<any>,prompt:string,setBusy:(v:boolean)=>void,setMessage:(v:string)=>void){setBusy(true);try{const v=await request('models/images',{prompt,confirmCharge:true,count:1});setMessage(`生图成功，返回 ${v.images?.length??0} 张图片。`);}catch(e){setMessage(e instanceof Error?e.message:'生图失败');}finally{setBusy(false);}}

export function ModelSettings({request}:Props){
  const [fields,setFields]=useState(initial);
  const [custom,setCustom]=useState({label:'',model:'',protocol:'chat-completions'});
  const [apiKey,setApiKey]=useState('');
  const [imageApiKey,setImageApiKey]=useState('');
  const [saved,setSaved]=useState<Settings|null>(null);
  const [catalog,setCatalog]=useState<{activeId:string;profiles:{id:string;label:string;model:string;imageModel?:string}[]}>({activeId:'',profiles:[]});
  const [adding,setAdding]=useState(false);
  const [textModels,setTextModels]=useState<string[]>([]),[imageModels,setImageModels]=useState<string[]>([]);
  async function discover(kind:'text'|'image'){
    setBusy(true);setMessage('正在读取供应商模型列表…');
    try{const value=await request('models/discover',{kind,baseUrl:kind==='image'?(fields.imageBaseUrl||fields.baseUrl):fields.baseUrl,apiKey:(kind==='image'?(imageApiKey||(!fields.imageBaseUrl?apiKey:'')):apiKey)||undefined,protocol:fields.protocol});if(kind==='text')setTextModels(value.models);else setImageModels(value.models);setMessage(`已获取 ${value.models.length} 个模型，请从下拉列表选择。模型用途和权限以供应商说明为准。`);}catch(e){setMessage(e instanceof Error?e.message:'无法获取模型列表');}finally{setBusy(false);}
  }
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [prompt,setPrompt]=useState('');
  const [imagePrompt,setImagePrompt]=useState('');
  const [consent,setConsent]=useState(false);
  const [answer,setAnswer]=useState('');
  const initialRequest=useRef(request);
  const userEdited=useRef(false);
  async function loadCatalog(){const value=await request('models/profiles');if(Array.isArray(value?.profiles))setCatalog(value);}
  useEffect(()=>{void loadCatalog().catch(()=>{});},[]);
  async function switchProfile(id:string){setBusy(true);try{const value=await request('models/activate',{id});setSaved(value);setFields(value);setApiKey('');setImageApiKey('');setAdding(false);setConsent(false);await loadCatalog();setMessage('已切换模型配置，后续创作使用此配置。');}catch(e){setMessage(String(e));}finally{setBusy(false);}}
  useEffect(()=>{let active=true;initialRequest.current('models').then(value=>{if(active&&value&&!userEdited.current){setFields(value);setSaved(value);}}).catch(()=>{if(active)setMessage('无法读取模型配置，请重新进入此页');});return()=>{active=false;};},[]);
  const change=(name:keyof Settings,value:string)=>{userEdited.current=true;setFields(old=>({...old,[name]:value}));setMessage(name==='model'||name==='imageModel'?`已选择模型：${value||'未选择'}`:'');};
  async function save(){
    if(!(custom.label||fields.label).trim()||!fields.baseUrl.trim()||!(custom.model||fields.model).trim()||(!apiKey.trim()&&(!saved?.hasKey||fields.baseUrl!==saved.baseUrl))){setMessage('请填写文案服务配置；首次配置或更换地址时需要填写密钥。');return;}
    if(fields.imageBaseUrl?.trim()&&!imageApiKey.trim()&&(!saved?.hasImageKey||fields.imageBaseUrl!==saved.imageBaseUrl)){setMessage('首次配置或更换生图地址时，请填写生图密钥。');return;}
    setBusy(true);setMessage('');setAnswer('');
    try{const value=await request(adding?'models/profiles':'models',{label:custom.label||fields.label,protocol:custom.protocol||fields.protocol,baseUrl:fields.baseUrl,model:custom.model||fields.model,imageModel:fields.imageModel,imageBaseUrl:fields.imageBaseUrl?.trim()||undefined,imageApiKey:imageApiKey.trim()||undefined,apiKey:apiKey.trim()||undefined});setSaved(value);setFields(value);setApiKey('');setImageApiKey('');setAdding(false);setConsent(false);await loadCatalog();setMessage('配置已加密保存，尚未验证模型连接。');}
    catch(e){setMessage(e instanceof Error?e.message:'保存失败，请检查字段和连接。');}
    finally{setBusy(false);}
  }
  async function run(text:string){
    setBusy(true);setMessage('');setAnswer('');
    try{const response=await request('models/chat',{prompt:text,confirmCharge:consent});setAnswer(response.text);setMessage('所选服务已返回文本。本次未操作小红书账号。');}
    catch(e){setMessage(e instanceof Error?e.message:'调用失败');}
    finally{setBusy(false);}
  }
  return <>
    <p className="section-intro">粘贴兼容接口地址和密钥，配置完成即可在工作台生成文案与图片。</p>
    <form className="grey-panel model-settings" onSubmit={e=>{e.preventDefault();void save();}}>
      <details><summary>切换或新增已保存配置（{catalog.profiles.length}）</summary><label>已保存配置<select disabled={busy} value={adding?'':catalog.activeId} onChange={e=>{if(e.target.value)void switchProfile(e.target.value);}}><option value="">选择配置</option>{catalog.profiles.map(p=><option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}</select></label><button type="button" className="ghost" disabled={busy} onClick={()=>{setAdding(true);setFields(initial);setApiKey('');setImageApiKey('');setTextModels([]);setImageModels([]);setMessage('填写新配置，已有配置保留。');}}>新增配置</button></details>
      <h2>{adding?'添加模型配置':'当前模型配置'}</h2><p>选择常用服务可自动填入地址，也可以粘贴自己的 URL。密钥加密保存，以后切换无需重填。</p>
      <section className="active-model-banner" aria-label="当前文案模型"><strong>当前文案模型</strong><span>{fields.model||"尚未选择"}</span><small>{fields.baseUrl||"请选择供应商"}</small></section><h3>1. 选择文案供应商</h3><ProviderPicker kind="text" baseUrl={fields.baseUrl} onSelect={p=>{userEdited.current=true;setTextModels(p.models);setApiKey('');setFields(old=>({...old,baseUrl:p.url,model:p.models[0]??''}));setMessage(p.name==='自定义服务'?'已选择自定义服务，请在下方填写第三方中转地址、密钥和模型名称。':p.models.length?`已选择 ${p.name}，请填写密钥后保存。`:`已选择 ${p.name}，请填写已开通的模型或接入点 ID。`);}}/>
      <h3>2. 粘贴密钥，选择模型</h3>
      <div className="model-fields">
        <label>服务地址<input type="url" value={fields.baseUrl} onChange={e=>change('baseUrl',e.target.value)} placeholder="https://api.deepseek.com" required/></label>
        <label>API 密钥<input type="password" autoComplete="new-password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={saved?.hasKey?'••••••••••••••••':'输入文案 API 密钥'} required={!saved?.hasKey}/><small>{saved?.hasKey?'已保存 · 输入新密钥修改，留空不变':'密钥将加密保存'}</small></label>
        <label>文案模型<select value={fields.model} onChange={e=>change('model',e.target.value)}><option value="">选择模型</option>{[...new Set([fields.model,...textModels].filter(Boolean))].map(m=><option key={m}>{m}</option>)}</select></label><button type="button" className="ghost" disabled={busy||!fields.baseUrl} onClick={()=>void discover('text')}>获取文案模型列表</button>
      </div>
      <section aria-label="自定义设置"><h3>自定义设置</h3><div className="model-fields"><label>服务名称<input value={custom.label} onChange={e=>setCustom(v=>({...v,label:e.target.value}))}/></label><label>模型名称<input value={custom.model} onChange={e=>setCustom(v=>({...v,model:e.target.value}))} placeholder="填写模型名称或接入点 ID"/></label><label>接口协议<select value={custom.protocol} onChange={e=>setCustom(v=>({...v,protocol:e.target.value}))}><option value="chat-completions">Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label></div></section>
      <section className="active-model-banner image-model-banner" aria-label="当前生图模型"><strong>当前生图模型</strong><span>{fields.imageModel||"尚未选择"}</span><small>{fields.imageBaseUrl||"请选择生图供应商"}</small></section><h3>生图 API · 独立服务</h3>
      <ProviderPicker kind="image" baseUrl={fields.imageBaseUrl??''} onSelect={p=>{userEdited.current=true;if(fields.imageBaseUrl===p.url && p.name!=='自定义服务')return;setImageModels(p.images??[]);setImageApiKey('');setFields(old=>({...old,imageBaseUrl:p.url,imageModel:p.images?.[0]??''}));setMessage(`已选择 ${p.name}，请填写生图密钥并选择模型。`);}}/>
      <p>可以与文案使用不同厂商。地址和密钥同时留空时沿用文案服务；服务需支持 Images Generations 协议。</p>
      <div className="model-fields">
        <label>生图 API 地址<input type="url" value={fields.imageBaseUrl??''} onChange={e=>change('imageBaseUrl',e.target.value)} placeholder="https://你的生图服务域名/v1"/></label>
        <label>生图 API 密钥<input type="password" autoComplete="new-password" value={imageApiKey} onChange={e=>setImageApiKey(e.target.value)} placeholder={saved?.hasImageKey?'••••••••••••••••':'生图服务商提供的 API Key'}/><small>{saved?.hasImageKey?'已保存 · 输入新密钥修改，留空不变':'密钥将加密保存'}</small></label>
        <label>自定义生图模型 ID<input value={fields.imageModel??''} onChange={e=>change('imageModel',e.target.value)}/></label><label>生图模型<select value={fields.imageModel??''} onChange={e=>change('imageModel',e.target.value)}><option value="">选择生图模型</option>{[...new Set([fields.imageModel,...imageModels].filter((m):m is string=>!!m))].map(m=><option key={m}>{m}</option>)}</select></label><button type="button" className="ghost" disabled={busy||!(fields.imageBaseUrl||fields.baseUrl)} onClick={()=>void discover('image')}>获取生图模型列表</button>
      </div>
      <p>仅支持公网 HTTPS；地址填到 API 根路径或版本路径。非兼容协议不能只靠更换地址接入。</p>
      {message&&<p role="status">{message}</p>}<button className="primary" disabled={busy}>加密保存配置</button>
    </form>
    <section className="model-playground">
      <div className="model-playground-intro"><h2>模型工作区</h2><p>仅发送你填写的提示词；不会自动同步账号或发布内容。</p>
        <label className="model-shared-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>我确认将提示词发送至所选服务，调用费用由我的服务商账户承担</span></label>
      </div>
      <div className="ai-workbench-grid model-aligned-grid">
        <section className="grey-panel model-settings model-tool-card">
          <h2>生文案</h2>
          <div className="model-service-meta"><span>文案模型</span><strong>{saved?.model||'尚未配置'}</strong><small>{saved?.baseUrl||'请先保存模型配置'}</small></div>
          <label className="model-prompt-field">发送给模型的文本<textarea value={prompt} maxLength={8000} onChange={e=>setPrompt(e.target.value)} placeholder="例如：帮我拟定一份小红书选题清单"/></label>
          <div className="model-tool-actions"><button className="primary" disabled={busy||!saved||!consent||!prompt.trim()} onClick={()=>void run(prompt)}>{busy?'正在请求…':'调用所选模型'}</button><button className="ghost" type="button" disabled={busy||!saved||!consent} onClick={()=>void run('请简短回复：连接成功。')}>发起真实连接测试</button></div>
        </section>
        <section className="grey-panel model-settings model-tool-card">
          <h2>生图片</h2>
          <div className="model-service-meta"><span>生图模型</span><strong>{saved?.imageModel||'尚未配置'}</strong><small>{saved?(saved.imageBaseUrl||saved.baseUrl):'请先保存生图配置'}</small></div>
          <label className="model-prompt-field">图片提示词<textarea value={imagePrompt} onChange={e=>setImagePrompt(e.target.value)} placeholder="例如：自然光下的通勤背包生活方式照片"/></label>
          <div className="model-tool-actions"><button className="primary" type="button" disabled={busy||!saved||!consent||!saved.imageModel||!imagePrompt.trim()} onClick={()=>void generateImage(request,imagePrompt,setBusy,setMessage)}>生成图片</button></div>
        </section>
      </div>
      {message&&<p className="model-workspace-status" role="status">{message}</p>}{answer&&<pre className="model-answer">{answer}</pre>}
    </section>
    </>;
}
