import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const modelSettingsSchema=z.object({
  label:z.string().trim().min(1).max(80),
  protocol:z.enum(['chat-completions','anthropic-messages']),
  baseUrl:z.string().url().max(2048).refine(value=>{
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;
  }),
  model:z.string().trim().min(1).max(200),
  imageModel:z.string().trim().max(200).optional(),
  imageBaseUrl:z.string().url().max(2048).refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}).optional(),
  imageApiKey:z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional(),
  apiKey:z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
}).strict().refine(value=>!!value.imageBaseUrl===!!value.imageApiKey,{message:'独立生图服务必须同时填写地址和密钥',path:['imageApiKey']});
export type ModelSettings=z.infer<typeof modelSettingsSchema>;

export function createModelSettings(dir:string){
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=join(dir,'model-settings.enc');
  const keyPath=join(dir,'model-encryption-key');
  // Never generate a replacement key when encrypted settings already exist.
  if(!existsSync(keyPath)&&existsSync(path))throw new Error('模型配置加密密钥缺失，请恢复备份');
  if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
  const key=readFileSync(keyPath);
  if(key.length!==32)throw new Error('模型配置加密密钥无效');
  type Collection={activeId:string;profiles:Array<{id:string;settings:ModelSettings}>};
  function collection():Collection{
    if(!existsSync(path))return {activeId:'',profiles:[]};
    const bytes=Buffer.from(readFileSync(path,'utf8'),'base64');
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28));
    const raw=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
    if(raw.profiles)return z.object({activeId:z.string(),profiles:z.array(z.object({id:z.string(),settings:modelSettingsSchema}))}).parse(raw);
    return {activeId:'default',profiles:[{id:'default',settings:modelSettingsSchema.parse(raw)}]};
  }
  function read():ModelSettings|null{const all=collection();return all.profiles.find(p=>p.id===all.activeId)?.settings??null;}
  function write(value:Collection){
    const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    const temporary=path+'.'+randomBytes(8).toString('hex');
    writeFileSync(temporary,Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64'),{mode:0o600,flag:'wx'});
    renameSync(temporary,path);
  }
  function profiles(){const all=collection();return {activeId:all.activeId,profiles:all.profiles.map(p=>({id:p.id,label:p.settings.label,model:p.settings.model,imageModel:p.settings.imageModel}))};}
  function activate(id:string){const all=collection();if(!all.profiles.some(p=>p.id===id))throw Error('模型配置不存在');all.activeId=id;write(all);return summary();}
  function summary(){const value=read();if(!value)return null;const {apiKey,imageApiKey,...publicFields}=value;return {...publicFields,hasKey:!!apiKey,hasImageKey:!!imageApiKey};}
  function save(input:unknown,asNew=false){
    const incoming=z.record(z.string(),z.unknown()).parse(input);
    const all=collection();const previous=asNew?null:read();
    const normalize=(v:unknown)=>typeof v==='string'?v.replace(/\/+$/,''):v;
    const value=modelSettingsSchema.parse({...incoming,
      apiKey:incoming.apiKey??(normalize(incoming.baseUrl)===normalize(previous?.baseUrl)?previous?.apiKey:undefined),
      imageApiKey:incoming.imageApiKey??(incoming.imageBaseUrl&&normalize(incoming.imageBaseUrl)===normalize(previous?.imageBaseUrl)?previous?.imageApiKey:undefined),
    });
    value.baseUrl=value.baseUrl.replace(/\/+$/,'');
    const existing=asNew?undefined:all.profiles.find(p=>p.id===all.activeId);
    if(existing)existing.settings=value;
    else{if(all.profiles.length>=50)throw Error('最多保存 50 组模型配置');const id=randomUUID();all.profiles.push({id,settings:value});all.activeId=id;}
    write(all);
    return summary();
  }
  return {read,summary,save,profiles,activate};
}
