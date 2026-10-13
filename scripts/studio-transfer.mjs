import {randomUUID} from 'node:crypto';
import {Script} from 'node:vm';
// The bridge receives small ASCII-only chunks. Verify length before evaluating.
export async function evaluateScript(send,source,{batchSize=1}={}){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>4)throw Error('传输批次必须为 1–4');
 new Script(source);
 if(Buffer.byteLength(source)<24000)return send(source);
 const key='__matrixScript_'+randomUUID().replaceAll('-','');
 const encoded=Buffer.from(source,'utf8').toString('base64');
 await send(`(()=>{window[${JSON.stringify(key)}]='';return true;})()`);
 try{
  for(let offset=0;offset<encoded.length;offset+=12000*batchSize){
   if(batchSize>1){
    const operations=[],expected=[];
    for(let start=offset;start<Math.min(offset+12000*batchSize,encoded.length);start+=12000){
     operations.push(`window[${JSON.stringify(key)}]+=${JSON.stringify(encoded.slice(start,start+12000))};lengths.push(window[${JSON.stringify(key)}].length);`);
     expected.push(Math.min(start+12000,encoded.length));
    }
    const lengths=await send(`(()=>{const lengths=[];${operations.join('')}return lengths;})()`);
    if(!Array.isArray(lengths)||lengths.length!==expected.length||lengths.some((length,i)=>length!==expected[i]))throw Error('素材脚本传输不完整，请检查浏览器连接');
    continue;
   }
   const chunk=encoded.slice(offset,offset+12000);
   const length=await send(`(()=>{window[${JSON.stringify(key)}]+=${JSON.stringify(chunk)};return window[${JSON.stringify(key)}].length;})()`);
   if(length!==Math.min(offset+12000,encoded.length))throw Error('素材脚本传输不完整，请检查浏览器连接');
  }
  return await send(`(async()=>{const bytes=Uint8Array.from(atob(window[${JSON.stringify(key)}]),c=>c.charCodeAt(0));return await (0,eval)(new TextDecoder().decode(bytes));})()`);
 }finally{await send(`(()=>{delete window[${JSON.stringify(key)}];return true;})()`).catch(()=>{});}
}
