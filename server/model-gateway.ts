import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { modelSettingsSchema, type ModelSettings } from './model-settings';
import { randomUUID } from 'node:crypto';

export type ModelTransport=(url:string,headers:Record<string,string>,body:unknown)=>Promise<unknown>;
export class ModelRequestError extends Error {
  constructor(message:string,readonly code:string,readonly status?:number){super(message);this.name='ModelRequestError';}
}
function networkFailure(error:unknown,stage:string){
  if(error instanceof ModelRequestError)return error;
  const code=(error as NodeJS.ErrnoException)?.code;
  const reason=code==='ECONNRESET'?'连接被服务商中断':code==='ENOTFOUND'?'域名无法解析':code==='ECONNREFUSED'?'服务商拒绝连接':code==='ETIMEDOUT'?'连接超时':'连接中断，请稍后重试';
  return new ModelRequestError(`${stage}：${reason}`,'NETWORK');
}
const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,bits);

export async function downloadModelImage(url:string){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||isIP(u.hostname)||u.hostname.startsWith('['))throw Error('生成图片必须来自公网 HTTPS 域名');
  let timer:ReturnType<typeof setTimeout>|undefined;
  let addresses:string[];
  try{addresses=await Promise.race([resolve4(u.hostname),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('图片域名解析超时')),5000);})]);}finally{clearTimeout(timer);}
  if(!addresses.length||addresses.some(ip=>blocked.check(ip)))throw Error('生成图片不能来自内网地址');
  return new Promise<string>((resolve,reject)=>{
    const req=request({hostname:addresses[0],servername:u.hostname,port:u.port||443,path:u.pathname+u.search,method:'GET',agent:false,headers:{Host:u.host}},res=>{
      if(res.statusCode!==200){res.resume();reject(Error('生成图片归档失败 HTTP '+res.statusCode));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8*1024*1024){const error=new ModelRequestError('生成图片超过 8 MB 归档限制','SIZE_LIMIT');reject(error);req.destroy(error);return;}chunks.push(chunk);});
      res.on('error',e=>reject(networkFailure(e,'生成图片归档失败')));res.on('end',()=>{const bytes=Buffer.concat(chunks),mime=bytes[0]===255?'jpeg':bytes.toString('ascii',0,4)==='RIFF'?'webp':'png';resolve('data:image/'+mime+';base64,'+bytes.toString('base64'));});
    });
    const timeout=setTimeout(()=>{const error=new ModelRequestError('生成图片下载超过 30 秒，归档未完成','TIMEOUT');reject(error);req.destroy(error);},30000);req.on('close',()=>clearTimeout(timeout));req.on('error',e=>reject(networkFailure(e,'生成图片归档失败')));req.end();
  });
}

// Resolve once and pin the approved address to the TLS connection. Never follow redirects.
export const publicHttpsJson:ModelTransport=async(url,headers,body)=>{
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||isIP(u.hostname)||u.hostname.startsWith('[')||u.hostname==='localhost'||u.hostname.endsWith('.localhost'))throw new Error('只允许公网 HTTPS 域名');
  let dnsTimer:ReturnType<typeof setTimeout>|undefined;
  let addresses:string[];
  try{addresses=await Promise.race([resolve4(u.hostname),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('服务域名解析超时')),5000);})]);}
  finally{clearTimeout(dnsTimer);}
  if(!addresses.length||addresses.some(ip=>blocked.check(ip)))throw new Error('禁止访问内网或保留地址');
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?'':Buffer.isBuffer(body)?body:JSON.stringify(body);
    const req=request({protocol:'https:',hostname:addresses[0],servername:u.hostname,port:u.port||443,path:u.pathname,method:body===undefined?'GET':'POST',agent:false,
      headers:{'Content-Type':'application/json',...headers,Host:u.host,'Content-Length':String(Buffer.byteLength(payload))}},res=>{
      if(!res.statusCode||res.statusCode<200||res.statusCode>=300){res.resume();const status=res.statusCode;const reason=status===503?'服务商暂不可用，请核对当前模型是否仍可用':status===429?'调用频率或额度受限':status===401?'密钥无效或已过期':status===402?'服务商余额不足':status===404?'接口或模型不存在':'请核对模型配置或稍后重试';reject(new ModelRequestError(`模型服务返回 HTTP ${status}：${reason}`,'HTTP',status));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>(/\/images\/(generations|edits)$/.test(u.pathname)?24:1)*1024*1024){const error=new ModelRequestError('模型响应超过大小限制','SIZE_LIMIT');reject(error);req.destroy(error);return;}chunks.push(chunk);});
      res.on('error',e=>reject(networkFailure(e,'模型响应读取失败')));
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('模型服务未返回有效 JSON'));}});
    });
    const seconds=/\/images\/(generations|edits)$/.test(u.pathname)?180:120;
    const timer=setTimeout(()=>{const error=new ModelRequestError(`模型在 ${seconds} 秒内未完成响应；未自动重复扣费，请核对服务商记录后重试`,'TIMEOUT');reject(error);req.destroy(error);},seconds*1000);
    req.on('close',()=>clearTimeout(timer));req.on('error',e=>reject(networkFailure(e,'模型连接失败')));
    req.end(payload);
  });
};

export async function callModel(input:ModelSettings,prompt:string,transport:ModelTransport=publicHttpsJson,maxTokens=512){
  const settings=modelSettingsSchema.parse(input);
  const text=z.string().trim().min(1).max(8000).parse(prompt);
  const base=settings.baseUrl.replace(/\/+$/,'');
  const anthropic=settings.protocol==='anthropic-messages';
  const url=anthropic?(base.endsWith('/messages')?base:base+(base.endsWith('/v1')?'/messages':'/v1/messages')):(base.endsWith('/chat/completions')?base:base+'/chat/completions');
  const headers:Record<string,string>=anthropic?{'x-api-key':settings.apiKey,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+settings.apiKey};
  const raw=await transport(url,headers,{model:settings.model,messages:[{role:'user',content:text}],max_tokens:maxTokens,stream:false});
  const answer=anthropic?z.object({content:z.array(z.object({type:z.string(),text:z.string().optional()}))}).parse(raw).content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n'):z.object({choices:z.array(z.object({message:z.object({content:z.string().nullable()})})).min(1)}).parse(raw).choices[0].message.content;
  if(!answer?.trim())throw new Error('模型未返回文本；可能需要调整模型或输出限制');
  return {text:answer,model:settings.model,provider:settings.label};
}

export async function editImages(settings:ModelSettings,prompt:string,reference:string,strength:number,size:string,transport:ModelTransport=publicHttpsJson){
  if(!/^gpt-image-/i.test(settings.imageModel??''))throw Error('当前生图服务尚未接入参考图编辑，请切换兼容图片编辑接口的 GPT Image 服务');
  if(strength<0.5||strength>0.7)throw Error('二创强度必须在 0.5–0.7 之间');
  const match=/^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(reference);
  if(!match)throw Error('参考图读取失败');
  const boundary='matrix-'+randomUUID(),chunks:Buffer[]=[];
  // The compatible edits API has no numeric strength parameter; this is prompt guidance.
  const fields={model:settings.imageModel!,prompt:`${prompt}\n参考图二次创作。变化意愿 ${strength}（0.5 偏保留，0.7 偏变化）。保留主体身份和关键产品细节，调整场景、光线与构图。`,n:'1',size};
  for(const [key,value] of Object.entries(fields))chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.${match[1]==='jpeg'?'jpg':match[1]}"\r\nContent-Type: image/${match[1]}\r\n\r\n`),Buffer.from(match[2],'base64'),Buffer.from(`\r\n--${boundary}--\r\n`));
  const base=(settings.imageBaseUrl||settings.baseUrl).replace(/\/+$/,'').replace(/\/(images\/(generations|edits)|chat\/completions)$/,'');
  const raw=await transport(base+'/images/edits',{Authorization:'Bearer '+(settings.imageApiKey||settings.apiKey),'Content-Type':`multipart/form-data; boundary=${boundary}`},Buffer.concat(chunks));
  const result=z.object({data:z.array(z.object({url:z.string().url().optional(),b64_json:z.string().optional()})).min(1)}).parse(raw).data[0];
  if(!result.url&&!result.b64_json)throw Error('图片编辑未返回图片');
  return result.b64_json?'data:image/png;base64,'+result.b64_json:result.url!;
}

/** OpenAI-compatible image generation. The provider may be Tongyi, SiliconFlow,
 * Doubao, Zhipu or another service exposing /images/generations. */
export async function generateImages(input:ModelSettings,prompt:string,count=1,transport:ModelTransport=publicHttpsJson,size='1024x1024'){
  const settings=modelSettingsSchema.parse(input);
  if(!settings.imageModel) throw new Error('尚未配置生图模型名，请在模型设置中填写 imageModel');
  const base=(settings.imageBaseUrl||settings.baseUrl).replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
  const url=base.endsWith('/images/generations')?base:base+'/images/generations';
  const agnes=new URL(url).hostname==='api.agnes-ai.cn';
  const payload=agnes?{model:settings.imageModel,prompt,size,extra_body:{response_format:'url'}}:{model:settings.imageModel,prompt,n:Math.min(Math.max(count,1),12),size,response_format:'url'};
  const raw=await transport(url,{Authorization:'Bearer '+(settings.imageApiKey||settings.apiKey)},payload);
  const parsed=z.object({data:z.array(z.object({url:z.string().url().nullish(),b64_json:z.string().nullish()})).min(1)}).parse(raw);
  const urls=parsed.data.map(x=>x.url).filter((x):x is string=>!!x);
  if(!urls.length) throw new Error('生图服务未返回可访问图片地址');
  return {images:urls,model:settings.imageModel,provider:settings.label};
}
