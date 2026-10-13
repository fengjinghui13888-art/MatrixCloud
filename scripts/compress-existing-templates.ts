import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Postgres,databaseUrl} from '../backend/server/postgres';
import {createPostgresTemplates} from '../backend/server/postgres-tasks';
import {decodeTemplateImage} from '../backend/server/personal-templates';

const apply=process.argv.includes('--apply');
const root='/app/work/grey',tenant='owner';
const sharpPath='/tmp/matrix-image-tools/node_modules/sharp/lib/index.js';
const sharp=(await import(sharpPath)).default;
const db=new Postgres(databaseUrl()!);
const library=createPostgresTemplates(db,tenant);
const backup=join(root,'maintenance','template-compression-'+new Date().toISOString().replace(/[:.]/g,'-'));
try{
  const rows=await library.list(),report:any[]=[];
  const active=await db.rows(tenant,"SELECT id FROM generation WHERE tenant_id=$1 AND status IN ('generating','approved','filling')",[tenant]);
  if(active.length)throw Error('有任务正在运行，请等待后重试');
  if(apply){await mkdir(backup,{recursive:true,mode:0o700});await writeFile(join(backup,'templates-before.json'),JSON.stringify(rows,null,2),{mode:0o600});}
  for(const row of rows){
    if(row.published||row.draft.sourceUrl!==''||row.draft.rightsNote!=='客户本地上传'||row.draft.images.length!==1)continue;
    const originalUrl=row.draft.images[0],key=originalUrl.split('/').at(-1)!;
    if(!/^[a-f0-9]{64}\.jpg$/.test(key))continue;
    const original=await readFile(join(root,'template-uploads',tenant,key));
    if(original.length<1.5*1024*1024)continue;
    if(createHash('sha256').update(original).digest('hex')!==key.slice(0,64))throw Error('原图校验失败：'+row.id);
    const bytes=await sharp(original,{limitInputPixels:80_000_000}).rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).jpeg({quality:86,chromaSubsampling:'4:2:0'}).toBuffer();
    if(bytes.length>=original.length*0.9)continue;
    const metadata=await sharp(bytes).metadata();
    if(!metadata.width||!metadata.height||Math.max(metadata.width,metadata.height)>2560)throw Error('压缩尺寸校验失败');
    const result=decodeTemplateImage('data:image/jpeg;base64,'+bytes.toString('base64'));
    const url='/api/templates/media/'+result.key;
    const entry={id:row.id,name:row.draft.name,originalUrl,url,before:original.length,after:bytes.length,width:metadata.width,height:metadata.height,applied:false};
    report.push(entry);
    if(apply){
      // Original hash files remain available for rollback and historical task media.
      await writeFile(join(root,'template-uploads',tenant,result.key),bytes,{mode:0o600});
      await library.update(row.id,{...row.draft,images:[url]},row.revision);
      entry.applied=true;
      await writeFile(join(backup,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
    }
    console.log(JSON.stringify(entry));
  }
  if(apply){
    const after=await library.list();
    for(const entry of report){if(!after.some(row=>row.id===entry.id&&row.draft.images[0]===entry.url))throw Error('模板引用校验失败');}
    await db.audit(tenant,'maintenance','template.compress',backup,`${report.length} images; originals retained`);
  }
  console.log(JSON.stringify({apply,backup:apply?backup:undefined,count:report.length,before:report.reduce((n,r)=>n+r.before,0),after:report.reduce((n,r)=>n+r.after,0)}));
}finally{await db.close();}
