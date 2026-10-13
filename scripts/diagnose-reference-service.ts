import { readFileSync } from 'node:fs';
import { Postgres, databaseUrl } from '../backend/server/postgres';
import { createPostgresModels } from '../backend/server/postgres-models';
import { publicHttpsJson } from '../backend/server/model-gateway';

const db = new Postgres(databaseUrl()!);
try {
  const settings = (await createPostgresModels(db, 'owner', '/app/work/grey').read())!;
  console.log(JSON.stringify({model:settings.model,baseUrl:settings.baseUrl,imageModel:settings.imageModel,imageBaseUrl:settings.imageBaseUrl}));
  const started=Date.now();
  try {
    const result:any=await publicHttpsJson(settings.baseUrl.replace(/\/$/,'')+'/models',{Authorization:'Bearer '+settings.apiKey},undefined);
    console.log(JSON.stringify({stage:'model-list',elapsedMs:Date.now()-started,models:result.data?.map((m:any)=>m.id)}));
  } catch(e) { console.log(JSON.stringify({stage:'model-list',elapsedMs:Date.now()-started,message:(e as Error).message})); }
  const token=readFileSync('/app/work/grey/access-token','utf8').trim();
  const response=await fetch('http://127.0.0.1:4174/api/templates/media/cc7f371bc117be39d6b0b5e54aa3c447adb53fd549653d98a55cdf8bd6ea15d7.jpg',{headers:{Authorization:'Bearer '+token}});
  const bytes=Buffer.from(await response.arrayBuffer());
  console.log(JSON.stringify({stage:'original-photo',status:response.status,bytes:bytes.length,jpeg:bytes[0]===255&&bytes[1]===216,endMarker:bytes.at(-2)===255&&bytes.at(-1)===217}));
  for(const model of [settings.model,'deepseek-flash']) {
    const started=Date.now();
    try {
      const r=await fetch(settings.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+settings.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'只回复：连接正常'}],max_tokens:30,stream:false}),signal:AbortSignal.timeout(120000)});
      const v:any=await r.json();
      console.log(JSON.stringify({stage:'text-probe',model,elapsedMs:Date.now()-started,status:r.status,hasText:!!v.choices?.[0]?.message?.content,errorCode:typeof v.error?.code==='string'&&/^[a-z0-9_ -]{1,80}$/i.test(v.error.code)?v.error.code:undefined}));
    } catch(e) {console.log(JSON.stringify({stage:'text-probe',model,elapsedMs:Date.now()-started,errorName:(e as Error).name}));}
  }
} finally { await db.close(); }
