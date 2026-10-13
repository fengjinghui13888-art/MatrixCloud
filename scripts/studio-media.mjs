import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Only repeat read-only downloads. Uploads and saves have separate evidence gates.
export async function fetchImageBytes(url,fetchImage=fetch,sleep=delay){
 for(let attempt=0;attempt<3;attempt++){
  let response;
  try{response=await fetchImage(url,{signal:AbortSignal.timeout(20000)});}
  catch(error){if(attempt===2)throw Error('素材服务连接失败，请稍后重试；已生成的文案和图片记录仍保留',{cause:error});await sleep(500*(attempt+1));continue;}
  if(!response.ok){
   await response.body?.cancel().catch(()=>{});
   if(attempt<2&&(response.status>=500||[408,429].includes(response.status))){await sleep(500*(attempt+1));continue;}
   throw Error(`素材下载失败 HTTP ${response.status}`);
  }
  try{return Buffer.from(await response.arrayBuffer());}
  catch(error){if(attempt===2)throw Error('素材下载中断，请稍后重试',{cause:error});await sleep(500*(attempt+1));}
 }
}
export async function downloadImages(urls,dir,fetchImage=fetch){await mkdir(dir,{recursive:true});return Promise.all(urls.map(async(value,i)=>{const url=new URL(value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&(url.hostname==='xhscdn.com'||url.hostname.endsWith('.xhscdn.com'))))throw Error('图片地址不是允许的 HTTPS 或小红书同步素材地址');const bytes=await fetchImageBytes(url,fetchImage);const type=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':null;if(!type)throw Error(`第 ${i+1} 张素材不是支持的 PNG/JPEG/WebP 图片`);const name=`${i+1}.${type==='jpeg'?'jpg':type}`,path=join(dir,name);await writeFile(path,bytes,{mode:0o600});return {path,name,mime:`image/${type}`,bytes:bytes.length};}));}
