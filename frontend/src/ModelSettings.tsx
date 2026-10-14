import { useEffect, useRef, useState } from 'react';
import {ProviderPicker} from './ProviderPicker';
import {customerMessage} from './customer-message';

type Settings={label:string;protocol:string;baseUrl:string;model:string;imageModel?:string;imageBaseUrl?:string;hasImageKey?:boolean;hasKey?:boolean};
type Props={request:(path:string,body?:unknown)=>Promise<any>};
const initial:Settings={label:'',protocol:'chat-completions',baseUrl:'',model:'',imageModel:''};
async function generateImage(request:(path:string,body?:unknown)=>Promise<any>,prompt:string,setBusy:(v:boolean)=>void,setMessage:(v:string)=>void){setBusy(true);try{const v=await request('models/images',{prompt,confirmCharge:true,count:1});setMessage(`生图成功，返回 ${v.images?.length??0} 张图片。`);}catch(e){setMessage(e instanceof Error?customerMessage(e):'生图失败');}finally{setBusy(false);}}

export function ModelSettings({request}:Props){
  const [fields,setFields]=useState(initial);
  const [custom,setCustom]=useState({label:'',model:'',protocol:''});
  const [apiKey,setApiKey]=useState('');
  const [imageApiKey,setImageApiKey]=useState('');
  const [saved,setSaved]=useState<Settings|null>(null);
  const [catalog,setCatalog]=useState<{activeId:string;profiles:{id:string;label:string;model:string;imageModel?:string}[]}>({activeId:'',profiles:[]});
  const [adding,setAdding]=useState(false);
  const [textModels,setTextModels]=useState<string[]>([]),[imageModels,setImageModels]=useState<string[]>([]);
  const discoverySequence=useRef({text:0,image:0});
  const [discovering,setDiscovering]=useState({text:false,image:false});
  async function discover(kind:'text'|'image',expected?:number){
    const sequence=expected??++discoverySequence.current[kind];
    if(sequence!==discoverySequence.current[kind])return;
    setDiscovering(old=>({...old,[kind]:true}));setMessage('正在自动读取可用模型…');
    try{const value=await request('models/discover',{kind,baseUrl:kind==='image'?(fields.imageBaseUrl||fields.baseUrl):fields.baseUrl,apiKey:(kind==='image'?(imageApiKey||(!fields.imageBaseUrl?apiKey:'')):apiKey)||undefined,protocol:custom.protocol||fields.protocol});if(sequence!==discoverySequence.current[kind])return;if(kind==='text')setTextModels(value.models);else setImageModels(value.models);userEdited.current=true;setFields(old=>({...old,...(kind==='text'?{model:value.models.includes(old.model)?old.model:(value.models[0]??'')}:{imageModel:value.models.includes(old.imageModel)?old.imageModel:(value.models[0]??'')})}));setMessage(value.models.length?`已获取 ${value.models.length} 个模型，已选中可用选项；需要时可更换。`:'此密钥未返回可用模型，请检查中转站分组，或手动填写模型名称。');}catch(e){if(sequence===discoverySequence.current[kind])setMessage('暂未获取到模型，可先保存地址和密钥；生成前需要服务商提供可用模型。');}finally{if(sequence===discoverySequence.current[kind])setDiscovering(old=>({...old,[kind]:false}));}
  }
  useEffect(()=>{
    const sequence=++discoverySequence.current.text;setDiscovering(old=>({...old,text:false}));
    if(!fields.baseUrl.trim()||!apiKey.trim())return;
    const timer=window.setTimeout(()=>void discover('text',sequence),1000);
    return()=>{window.clearTimeout(timer);};
  },[fields.baseUrl,apiKey,custom.protocol,fields.protocol]);
  useEffect(()=>{
    const sequence=++discoverySequence.current.image;setDiscovering(old=>({...old,image:false}));
    if(!fields.imageBaseUrl?.trim()||!imageApiKey.trim())return;
    const timer=window.setTimeout(()=>void discover('image',sequence),1000);
    return()=>{window.clearTimeout(timer);};
  },[fields.imageBaseUrl,imageApiKey]);
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
  async function switchProfile(id:string){setBusy(true);try{const value=await request('models/activate',{id});setSaved(value);setFields(value);setCustom({label:'',model:'',protocol:''});setApiKey('');setImageApiKey('');setAdding(false);setConsent(false);await loadCatalog();setMessage('已切换模型配置，后续创作使用此配置。');}catch(e){setMessage(String(e));}finally{setBusy(false);}}
  useEffect(()=>{let active=true;initialRequest.current('models').then(value=>{if(active&&value&&!userEdited.current){setFields(value);setSaved(value);}}).catch(()=>{if(active)setMessage('无法读取模型配置，请重新进入此页');});return()=>{active=false;};},[]);
  const change=(name:keyof Settings,value:string)=>{if(name==='baseUrl'||name==='imageBaseUrl')setConsent(false);userEdited.current=true;setFields(old=>({...old,[name]:value}));setMessage(name==='model'||name==='imageModel'?`已选择模型：${value||'未选择'}`:'');};
  async function save(textOnly=false):Promise<Settings|null>{
    let model=(custom.model||fields.model).trim();
    let label=(custom.label||fields.label).trim();
    if(!label){try{label=new URL(fields.baseUrl).hostname;}catch{label='自定义服务';}}
    if(!fields.baseUrl.trim()||(!apiKey.trim()&&(!saved?.hasKey||fields.baseUrl!==saved.baseUrl))){setMessage('请先填写文案服务地址和密钥。');return null;}
    if(!textOnly&&fields.imageBaseUrl?.trim()&&!imageApiKey.trim()&&(!saved?.hasImageKey||fields.imageBaseUrl!==saved.imageBaseUrl)){setMessage('图片地址已填写，请同时粘贴对应图片密钥，或暂时清空图片地址。');return null;}
    setBusy(true);setMessage('');setAnswer('');
    try{
      if(!model&&textOnly){const result=await request('models/discover',{kind:'text',baseUrl:fields.baseUrl,apiKey:apiKey.trim()||undefined,protocol:custom.protocol||fields.protocol});setTextModels(result.models);model=result.models[0]??'';}
      if(!model&&textOnly){setMessage('尚未获取到可用文案模型，请先重新获取模型列表。地址和密钥可以先保存。');return null;}
      const image=textOnly?{imageModel:saved?.imageModel,imageBaseUrl:saved?.imageBaseUrl}:{imageModel:fields.imageModel,imageBaseUrl:fields.imageBaseUrl?.trim()||undefined,imageApiKey:imageApiKey.trim()||undefined};
      const value=await request(adding?'models/profiles':'models',{label,protocol:custom.protocol||fields.protocol,baseUrl:fields.baseUrl.trim(),model,...image,apiKey:apiKey.trim()||undefined});
      setSaved(value);setFields(old=>textOnly?{...value,imageModel:old.imageModel,imageBaseUrl:old.imageBaseUrl}:value);setCustom({label:'',model:'',protocol:''});setApiKey('');if(!textOnly)setImageApiKey('');setAdding(false);await loadCatalog();setMessage(model?'配置已加密保存，可以继续测试连接。':'地址和密钥已加密保存，模型暂未获取，尚不能生成文案。');return value;
    }catch(e){setMessage(e instanceof Error?customerMessage(e):'保存失败，请检查服务和密钥。');return null;}finally{setBusy(false);}
  }
  async function run(text:string){
    if(!consent){setMessage('请先勾选允许调用所选服务。');return;}
    const changed=!saved||!saved.model||!!apiKey.trim()||!!custom.label||!!custom.model||fields.baseUrl!==saved.baseUrl||fields.model!==saved.model||(custom.protocol||fields.protocol)!==saved.protocol;
    if(changed&&!await save(true))return;
    setBusy(true);setMessage('');setAnswer('');
    try{const response=await request('models/chat',{prompt:text,confirmCharge:consent});setAnswer(response.text);setMessage('所选服务已返回文本。本次未操作小红书账号。');}
    catch(e){setMessage(e instanceof Error?customerMessage(e):'调用失败');}
    finally{setBusy(false);}
  }
  return <>
    <p className="section-intro">选好服务或填入地址，再粘贴密钥。模型会自动读取并选中，文案与图片分别配置。</p>
    <form className="grey-panel model-settings" onSubmit={e=>{e.preventDefault();void save();}}>
      <details><summary>切换或新增已保存配置（{catalog.profiles.length}）</summary><label>已保存配置<select disabled={busy} value={adding?'':catalog.activeId} onChange={e=>{if(e.target.value)void switchProfile(e.target.value);}}><option value="">选择配置</option>{catalog.profiles.map(p=><option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}</select></label><button type="button" className="ghost" disabled={busy} onClick={()=>{setAdding(true);setFields(initial);setApiKey('');setImageApiKey('');setTextModels([]);setImageModels([]);setMessage('填写新配置，已有配置保留。');}}>新增配置</button></details>
      <h2>{adding?'添加模型配置':'当前模型配置'}</h2><p>常用服务已填好地址和推荐选项，你只需粘贴服务商提供的密钥。</p>
      <section className="model-service-card"><section className="active-model-banner" aria-label="当前文案模型"><strong>当前文案模型</strong><span>{fields.model||"尚未选择"}</span><small>{fields.label||"请选择服务"}</small></section><h3>① 写文案 · 选择服务</h3><ProviderPicker kind="text" baseUrl={fields.baseUrl} onSelect={p=>{userEdited.current=true;setTextModels(p.models);setApiKey('');setCustom({label:'',model:'',protocol:''});setFields(old=>({...old,label:p.name,protocol:'chat-completions',baseUrl:p.url,model:p.models[0]??''}));setMessage(p.name==='自定义服务'?'已选择自定义服务，请在下方填写第三方中转地址、密钥和模型名称。':p.models.length?`已选择 ${p.name}，请填写密钥后保存。`:`已选择 ${p.name}，请填写已开通的模型或接入点 ID。`);}}/>
      <h3>粘贴文案密钥</h3>
      <div className="model-fields">
        <details className="model-advanced"><summary>修改服务地址</summary><label>服务地址<input type="url" value={fields.baseUrl} onChange={e=>change('baseUrl',e.target.value)} placeholder="https://api.deepseek.com"/></label></details>
        <label>文案密钥<input aria-label="API 密钥" type="password" autoComplete="new-password" value={apiKey} onChange={e=>{userEdited.current=true;setApiKey(e.target.value);}} placeholder={saved?.hasKey?'••••••••••••••••':'粘贴文案服务提供的密钥'} required={!saved?.hasKey}/><small>{saved?.hasKey?'已保存 · 输入新密钥修改，留空不变':'密钥将加密保存'}</small></label>
        <label>文案模型<select value={fields.model} onChange={e=>change('model',e.target.value)}><option value="">选择模型</option>{[...new Set([fields.model,...textModels].filter(Boolean))].map(m=><option key={m}>{m}</option>)}</select></label><button type="button" className="ghost" disabled={busy||discovering.text||!fields.baseUrl} onClick={()=>void discover('text')}>{discovering.text?'正在自动获取…':'获取文案模型列表'}</button>
      </div>
      <details className="model-advanced" aria-label="自定义设置"><summary>没有找到模型？手动填写名称或高级设置</summary><div className="model-fields"><label>服务名称<input value={custom.label} onChange={e=>setCustom(v=>({...v,label:e.target.value}))}/></label><label>模型名称<input value={custom.model} onChange={e=>setCustom(v=>({...v,model:e.target.value}))} placeholder="填写模型名称或接入点 ID"/></label><label>接口协议<select value={custom.protocol||fields.protocol} onChange={e=>setCustom(v=>({...v,protocol:e.target.value}))}><option value="chat-completions">Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label></div></details>
      </section><section className="model-service-card"><section className="active-model-banner image-model-banner" aria-label="当前生图模型"><strong>当前生图模型</strong><span>{fields.imageModel||"尚未选择"}</span><small>使用独立的图片服务，密钥与文案分别保存</small></section><h3>② 生成图片 · 选择服务</h3>
      <ProviderPicker kind="image" baseUrl={fields.imageBaseUrl??''} onSelect={p=>{userEdited.current=true;if(fields.imageBaseUrl===p.url && p.name!=='自定义服务')return;setImageModels(p.images??[]);setImageApiKey('');setFields(old=>({...old,imageBaseUrl:p.url,imageModel:p.images?.[0]??''}));setMessage(`已选择 ${p.name}，请填写生图密钥并选择模型。`);}}/>
      <p>选择图片服务后粘贴它的密钥。不同服务的密钥通常不能混用。</p>
      <div className="model-fields">
        <details className="model-advanced"><summary>修改图片服务地址</summary><label>生图 API 地址<input type="url" value={fields.imageBaseUrl??''} onChange={e=>change('imageBaseUrl',e.target.value)} placeholder="https://你的生图服务域名/v1"/></label></details>
        <label>图片密钥<input aria-label="生图 API 密钥" type="password" autoComplete="new-password" value={imageApiKey} onChange={e=>{userEdited.current=true;setImageApiKey(e.target.value);}} placeholder={saved?.hasImageKey?'••••••••••••••••':'粘贴图片服务提供的密钥'}/><small>{saved?.hasImageKey?'已保存 · 输入新密钥修改，留空不变':'密钥将加密保存'}</small></label>
        <details className="model-advanced"><summary>自定义图片模型</summary><label>自定义生图模型 ID<input value={fields.imageModel??''} onChange={e=>change('imageModel',e.target.value)}/></label></details><label>生图模型<select value={fields.imageModel??''} onChange={e=>change('imageModel',e.target.value)}><option value="">选择生图模型</option>{[...new Set([fields.imageModel,...imageModels].filter((m):m is string=>!!m))].map(m=><option key={m}>{m}</option>)}</select></label><button type="button" className="ghost" disabled={busy||discovering.image||!(fields.imageBaseUrl||fields.baseUrl)} onClick={()=>void discover('image')}>{discovering.image?'正在自动获取…':'获取生图模型列表'}</button>
      </div>

      </section>{message&&<p role="status">{message}</p>}<button className="primary" disabled={busy}>加密保存配置</button>
    </form>
    <section className="model-playground">
      <div className="model-playground-intro"><h2>试用文案和图片</h2><p>仅发送你填写的提示词；不会自动同步账号或发布内容。</p>
        <label className="model-shared-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>我确认将提示词发送至所选服务，调用费用由我的服务商账户承担</span></label>
      </div>
      <div className="ai-workbench-grid model-aligned-grid">
        <section className="grey-panel model-settings model-tool-card">
          <h2>生文案</h2>
          <div className="model-service-meta"><span>文案模型</span><strong>{saved?.model||'尚未配置'}</strong><small>{saved?.label||'请先保存服务配置'}</small></div>
          <label className="model-prompt-field">发送给模型的文本<textarea value={prompt} maxLength={8000} onChange={e=>setPrompt(e.target.value)} placeholder="例如：帮我拟定一份小红书选题清单"/></label>
          <div className="model-tool-actions"><button className="primary" disabled={busy||!consent||!(saved||fields.baseUrl&&apiKey.trim())||!prompt.trim()} onClick={()=>void run(prompt)}>{busy?'正在请求…':'调用所选模型'}</button><button className="ghost" type="button" disabled={busy||!consent||!(saved||fields.baseUrl&&apiKey.trim())} onClick={()=>void run('请简短回复：连接成功。')}>发起真实连接测试</button></div>
        </section>
        <section className="grey-panel model-settings model-tool-card">
          <h2>生图片</h2>
          <div className="model-service-meta"><span>生图模型</span><strong>{saved?.imageModel||'尚未配置'}</strong><small>{saved?.imageModel?'图片服务已保存':'请先保存图片服务配置'}</small></div>
          <label className="model-prompt-field">图片提示词<textarea value={imagePrompt} onChange={e=>setImagePrompt(e.target.value)} placeholder="例如：自然光下的通勤背包生活方式照片"/></label>
          <div className="model-tool-actions"><button className="primary" type="button" disabled={busy||!saved||!consent||!saved.imageModel||!imagePrompt.trim()} onClick={()=>void generateImage(request,imagePrompt,setBusy,setMessage)}>生成图片</button></div>
        </section>
      </div>
      {!consent&&<p className="media-caption">先勾选上方调用确认，再点击测试。</p>}{!saved&&!(fields.baseUrl&&apiKey.trim())&&<p className="media-caption">请先填写文案服务地址和密钥；测试时会自动读取模型并保存文案配置。</p>}{message&&<p className="model-workspace-status" role="status">{message}</p>}{answer&&<pre className="model-answer">{answer}</pre>}
    </section>
    </>;
}
