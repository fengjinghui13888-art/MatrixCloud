import {useEffect,useState} from 'react';
const serviceHelp:Record<string,string>={DeepSeek:'https://api-docs.deepseek.com/',智谱:'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'};
export const providers=[
 {name:'DeepSeek',url:'https://api.deepseek.com',models:['deepseek-chat','deepseek-reasoner']},
 {name:'OpenAI',url:'https://api.openai.com/v1',models:['gpt-5.3','gpt-5.3-mini','gpt-4.1','gpt-4o'],images:['gpt-image-2.5','gpt-image-1','dall-e-3']},
 {name:'通义千问',url:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:['qwen-plus','qwen-turbo','qwen-max']},
 {name:'智谱',url:'https://open.bigmodel.cn/api/paas/v4',models:['GLM-5.3','GLM-5.3-Flash','glm-4-plus','glm-4-flash'],images:['cogview-4','cogview-3-flash']},
 {name:'Kimi',url:'https://api.moonshot.cn/v1',models:['moonshot-v1-8k','moonshot-v1-32k','moonshot-v1-128k']},
 {name:'硅基流动',url:'https://api.siliconflow.cn/v1',models:['deepseek-ai/DeepSeek-V3','deepseek-ai/DeepSeek-R1']},
 {name:'火山方舟',url:'https://ark.cn-beijing.volces.com/api/v3',models:[]},
 {name:'百川',url:'https://api.baichuan-ai.com/v1',models:['Baichuan4','Baichuan3-Turbo']},
 {name:'零一万物',url:'https://api.lingyiwanwu.com/v1',models:['yi-large','yi-lightning']},
 {name:'MiniMax',url:'https://api.minimax.chat/v1',models:['MiniMax-Text-01','MiniMax-M2'],images:['image-01']},
 {name:'火山方舟生图',url:'https://ark.cn-beijing.volces.com/api/v3',models:[],images:['doubao-seedream-4-0','doubao-seedream-3-0-t2i']},
 {name:'通义万相',url:'https://dashscope.aliyuncs.com/api/v1',models:[],images:['wanx2.1-t2i-turbo','wanx2.1-t2i-plus']},
 {name:'Flux',url:'https://api.siliconflow.cn/v1',models:[],images:['black-forest-labs/FLUX.1-schnell','black-forest-labs/FLUX.1-dev']},
 {name:'Agnes 生图',url:'https://api.agnes-ai.cn/v1',models:[],images:['agnes-image-2.5','agnes-image-2.1-flash']},
 {name:'自定义服务',url:'',models:[]},
];
export function ProviderPicker({onSelect,kind,baseUrl,disabled=false}:{onSelect:(p:typeof providers[number])=>void;kind:'text'|'image';baseUrl:string;disabled?:boolean}){
 const [search,setSearch]=useState(''); const [selected,setSelected]=useState(''); useEffect(()=>{const p=providers.find(x=>x.url===baseUrl);if(p?.url)setSelected(p.name)},[baseUrl]);
 const available=providers.filter(p=>kind==='image'?(p.name!=='自定义服务'&&!!p.images?.length):((p.models.length>0||p.name==='火山方舟'||p.name==='自定义服务')&&!['百川','零一万物'].includes(p.name)));
 const matches=available.filter(p=>p.name.toLowerCase().includes(search.toLowerCase()));
 return <section className="provider-picker" aria-label={kind==='text'?'文案供应商':'生图供应商'}><label>选择供应商<input placeholder="搜索供应商" value={search} onChange={e=>setSearch(e.target.value)}/></label><div className="provider-grid">{matches.map(p=><button type="button" title={`选择${p.name}`} key={p.name} disabled={disabled} aria-pressed={p.url?baseUrl===p.url:selected===p.name} className={selected===p.name || (baseUrl===p.url && !!p.url)?'selected':''} onClick={()=>{setSelected(p.name);onSelect(p)}}><span aria-hidden="true">{p.name.slice(0,1)}</span>{p.name}</button>)}</div>{serviceHelp[selected]&&<p className="service-help"><a href={serviceHelp[selected]} target="_blank" rel="noopener noreferrer">不知道密钥在哪里？查看 {selected} 开通说明</a></p>}{!matches.length&&<p>没有匹配的供应商，请更换关键词。</p>}</section>;
}
