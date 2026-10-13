import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {modelSettingsSchema,type ModelSettings,type createModelSettings} from './model-settings';
import {Postgres,type AsyncMethods} from './postgres';
export type Models=AsyncMethods<ReturnType<typeof createModelSettings>>;
export function modelCipher(dir:string){
  const keyPath=join(dir,'model-encryption-key');
  if(!existsSync(keyPath))throw Error('模型加密密钥缺失，请恢复备份');
  const key=readFileSync(keyPath);if(key.length!==32)throw Error('模型加密密钥无效');
  return {
    encrypt(value:unknown){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');},
    decrypt(value:string){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
  };
}
export function createPostgresModels(db:Postgres,tenant:string,dir:string):Models{
  // New tenants get a key before their first config. Migrated tenants must retain theirs.
  const keyPath=join(dir,'model-encryption-key');
  const getCipher=async()=>{
    if(!existsSync(keyPath)){
      if(existsSync(join(dir,'model-settings.enc'))||(await db.rows(tenant,'SELECT 1 FROM model_config WHERE tenant_id=$1 LIMIT 1',[tenant])).length)throw Error('模型加密密钥缺失，请恢复备份');
      try{writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    }
    return modelCipher(dir);
  };
  const collection=async()=>{const cipher=await getCipher();return (await db.rows(tenant,'SELECT id,active,ciphertext FROM model_config WHERE tenant_id=$1 ORDER BY id',[tenant])).map(r=>({id:r.id,active:r.active,settings:modelSettingsSchema.parse(cipher.decrypt(r.ciphertext))}));};
  const read=async()=>(await collection()).find(p=>p.active)?.settings??null;
  const summary=async()=>{const value=await read();if(!value)return null;const {apiKey,imageApiKey,...fields}=value;return {...fields,hasKey:!!apiKey,hasImageKey:!!imageApiKey};};
  return {read,summary,
    profiles:async()=>{const all=await collection();return {activeId:all.find(p=>p.active)?.id??'',profiles:all.map(p=>({id:p.id,label:p.settings.label,model:p.settings.model,imageModel:p.settings.imageModel}))};},
    activate:async id=>{await db.transaction(tenant,async s=>{await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':models']);if(!(await s.query('SELECT 1 FROM model_config WHERE tenant_id=$1 AND id=$2',[tenant,id])).rowCount)throw Error('模型配置不存在');await s.query('UPDATE model_config SET active=false WHERE tenant_id=$1',[tenant]);await s.query('UPDATE model_config SET active=true WHERE tenant_id=$1 AND id=$2',[tenant,id]);});return summary();},
    save:async(input,asNew=false)=>{
      const cipher=await getCipher();
      await db.transaction(tenant,async s=>{
        await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':models']);
        const all=(await s.query('SELECT id,active,ciphertext FROM model_config WHERE tenant_id=$1',[tenant])).rows;
        const old=asNew?undefined:all.find(p=>p.active),previous:ModelSettings|null=old?cipher.decrypt(old.ciphertext):null;
        const incoming=input as Record<string,unknown>;const normalize=(v:unknown)=>typeof v==='string'?v.replace(/\/+$/,''):v;
        const value=modelSettingsSchema.parse({...incoming,apiKey:incoming.apiKey??(normalize(incoming.baseUrl)===normalize(previous?.baseUrl)?previous?.apiKey:undefined),imageApiKey:incoming.imageApiKey??(incoming.imageBaseUrl&&normalize(incoming.imageBaseUrl)===normalize(previous?.imageBaseUrl)?previous?.imageApiKey:undefined)});
        value.baseUrl=value.baseUrl.replace(/\/+$/,'');if(!old&&all.length>=50)throw Error('最多保存 50 组模型配置');
        await s.query('UPDATE model_config SET active=false WHERE tenant_id=$1',[tenant]);
        await s.query('INSERT INTO model_config(tenant_id,id,label,active,ciphertext) VALUES($1,$2,$3,true,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET label=excluded.label,active=true,ciphertext=excluded.ciphertext,updated_at=now()',[tenant,old?.id??randomUUID(),value.label,cipher.encrypt(value)]);
      });return summary();
    }
  };
}
