import fs from 'node:fs/promises';
import sharp from 'sharp';
const token=(await fs.readFile('/app/work/grey/access-token','utf8')).trim();
const base=process.env.VERIFY_ORIGIN||process.env.PUBLIC_ORIGIN;if(!base)throw new Error('请设置 VERIFY_ORIGIN 或 PUBLIC_ORIGIN');
const headers={Authorization:'Bearer '+token};
const response=await fetch(base+'/api/templates/mine',{headers});
if(!response.ok)throw Error('Library HTTP '+response.status);
const {items}=await response.json();
const report=[];
for(const item of items){
  const path=item.images[0];if(!path.startsWith('/api/templates/media/'))continue;
  const start=Date.now(),r=await fetch(base+path+'?size=thumb',{headers});
  if(!r.ok)throw Error(item.name+' thumbnail HTTP '+r.status);
  const bytes=Buffer.from(await r.arrayBuffer()),meta=await sharp(bytes).metadata();
  if(Math.max(meta.width,meta.height)>480)throw Error('Thumbnail dimensions');
  const cached=await fetch(base+path+'?size=thumb',{headers:{...headers,'If-None-Match':r.headers.get('etag'),'Cache-Control':'max-age=0'}});
  if(cached.status!==304)throw Error('Cache revalidation HTTP '+cached.status);
  const original=await fetch(base+path,{headers});if(!original.ok)throw Error('Preview missing');
  const originalBytes=Buffer.from(await original.arrayBuffer());await sharp(originalBytes).metadata();
  report.push({id:item.id,name:item.name,thumbnailBytes:bytes.length,previewBytes:originalBytes.length,width:meta.width,height:meta.height,firstReadMs:Date.now()-start,cacheStatus:cached.status});
}
const health=await (await fetch(base+'/api/health')).json();
console.log(JSON.stringify({origin:base,health,items:items.length,verified:report.length,thumbnailTotal:report.reduce((n,r)=>n+r.thumbnailBytes,0),previewTotal:report.reduce((n,r)=>n+r.previewBytes,0),report},null,2));
