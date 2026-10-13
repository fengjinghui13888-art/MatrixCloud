import express, { type Express } from 'express';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import type { Templates } from './postgres-tasks';
import { templateCategories } from '../shared/templates';

export const maxTemplateBytes = 8 * 1024 * 1024;
const maxLibraryBytes = 512 * 1024 * 1024;
const keyPattern = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
// Bound native decoder memory during simultaneous first-time thumbnail requests.
let thumbnailQueue:Promise<unknown>=Promise.resolve();
const thumbnailJobs=new Map<string,Promise<Buffer>>();
function thumbnailBytes(folder:string,key:string){
  const path=join(folder,'thumbnails',key+'.webp');
  const pending=thumbnailJobs.get(path);if(pending)return pending;
  const job=thumbnailQueue.then(async()=>{
    try{return await readFile(path);}catch{
      const bytes=await sharp(join(folder,key),{limitInputPixels:80_000_000}).rotate().resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).webp({quality:75}).toBuffer();
      await mkdir(join(folder,'thumbnails'),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600});return bytes;
    }
  });
  thumbnailQueue=job.catch(()=>{});thumbnailJobs.set(path,job);
  void job.finally(()=>thumbnailJobs.delete(path)).catch(()=>{});return job;
}
export function templateFiles(root:string,workspace:()=>string,library:Templates){
  const folder=()=>resolve(root,'template-uploads',workspace());
  return {
    async references(ids:string[]){
      const all=await library.list();
      return Promise.all(ids.map(async id=>{const row=all.find(t=>t.id===id&&t.draft.sourceUrl==='');if(!row)throw Error('所选图片已删除或不可访问，请重新选择');const key=row.draft.images[0].split('/').at(-1)!;if(!keyPattern.test(key))throw Error('参考图格式无效');const bytes=await readFile(join(folder(),key));return 'data:image/'+(key.endsWith('.jpg')?'jpeg':key.split('.').at(-1))+';base64,'+bytes.toString('base64');}));
    },
    async save(data:string,name:string){
      const {bytes,key}=decodeTemplateImage(data);await mkdir(folder(),{recursive:true,mode:0o700});await writeFile(join(folder(),key),bytes,{mode:0o600});
      const url='/api/templates/media/'+key;
      await library.create({name:name.slice(0,100),category:'生活方式',title:name.slice(0,20),body:'',images:[url],sourceUrl:'',usage:'owned',rightsNote:'模型二次创作'});return url;
    },
    file(key:string){if(!keyPattern.test(key))throw Error('素材地址无效');return join(folder(),key);}
  };
}
export function decodeTemplateImage(data: string) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw Error('仅支持 PNG、JPG、WebP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > maxTemplateBytes) throw Error('单张图片不能超过 8 MB');
  if (bytes.toString('base64') !== match[2]) throw Error('图片编码不完整，请重新选择文件');
  const png = bytes.length > 45 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0 && bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND';
  const jpg = bytes.length > 32 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217;
  const webp = bytes.length > 20 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' && bytes.readUInt32LE(4)+8===bytes.length;
  const ext = match[1]==='png'&&png?'png':match[1]==='jpeg'&&jpg?'jpg':match[1]==='webp'&&webp?'webp':null;
  if (!ext) throw Error('文件内容与图片格式不匹配或已损坏');
  return { bytes, key: createHash('sha256').update(bytes).digest('hex')+'.'+ext };
}

export function personalTemplateRoutes(app: Express, library: Templates, root: string, workspace: ()=>string) {
  const folder = () => resolve(root, 'template-uploads', workspace());
  const personal = async () => (await library.list()).filter(t=>t.draft.sourceUrl==='');
  const busy = new Set<string>();
  app.get('/api/templates/mine', async (_req,res)=>{
    try { res.json({items:(await personal()).map(t=>({...t.draft,id:t.id,revision:t.revision,updatedAt:t.updatedAt}))}); }
    catch { res.status(500).json({message:'素材读取失败，请重试'}); }
  });
  app.post('/api/templates/upload', express.json({limit:'12mb'}), async (req,res)=>{
    const tenant=workspace();
    if(busy.has(tenant))return res.status(409).json({message:'正在保存上一张图片，请稍后重试'});
    busy.add(tenant);
    try {
      const parsed=z.object({fileName:z.string().trim().min(1).max(240),data:z.string(),category:z.enum(templateCategories).default('生活方式')}).strict().safeParse(req.body);
      if(!parsed.success)return res.status(400).json({message:'请提供图片文件、文件名和有效分类'});
      const {bytes,key}=decodeTemplateImage(parsed.data.data), url='/api/templates/media/'+key;
      const existing=(await personal()).find(t=>t.draft.images.includes(url));
      if(existing)return res.json({item:{...existing.draft,id:existing.id,revision:existing.revision,updatedAt:existing.updatedAt},duplicate:true});
      await mkdir(folder(),{recursive:true,mode:0o700});
      let used=0;
      for(const name of await readdir(folder()))if(keyPattern.test(name))used+=(await stat(join(folder(),name))).size;
      const already=await stat(join(folder(),key)).catch(()=>null);
      if(used+(already?0:bytes.length)>maxLibraryBytes)return res.status(413).json({message:'素材空间已达 512 MB，请联系管理员扩容'});
      await writeFile(join(folder(),key),bytes,{mode:0o600});
      const name=parsed.data.fileName.replace(/\.[^.]+$/,'').slice(0,100)||'未命名素材';
      const item=await library.create({name,category:parsed.data.category,title:name.slice(0,20),body:'',images:[url],sourceUrl:'',usage:'owned',rightsNote:'客户本地上传'});
      return res.status(201).json({item:{...item.draft,id:item.id,revision:item.revision,updatedAt:item.updatedAt},duplicate:false});
    } catch(e) { return res.status(400).json({message:e instanceof Error?e.message:'上传失败，请重试'}); }
    finally {busy.delete(tenant);}
  });
  app.get('/api/templates/media/:key', async (req,res)=>{
    const key=String(req.params.key);
    if(!keyPattern.test(key))return res.sendStatus(404);
    try {
      const url='/api/templates/media/'+key;
      if(!(await personal()).some(t=>t.draft.images.includes(url)))return res.sendStatus(404);
      const thumbnail=req.query.size==='thumb';
      const etag='"'+key+(thumbnail?'-thumb-v1':'')+'"';
      // Revalidate after authentication and ownership checks, including after deletion.
      res.set('Cache-Control','private, no-cache').set('ETag',etag).vary('Cookie').vary('Authorization');
      if(req.fresh)return res.status(304).end();
      let bytes:Buffer;
      if(thumbnail){
        bytes=await thumbnailBytes(folder(),key);
      }else bytes=await readFile(join(folder(),key));
      return res.set('X-Content-Type-Options','nosniff').type(thumbnail?'image/webp':key.endsWith('.jpg')?'image/jpeg':key.endsWith('.png')?'image/png':'image/webp').send(bytes);
    } catch {return res.sendStatus(404);}
  });
  app.post('/api/templates/bulk-delete', async (req,res)=>{
    const parsed=z.object({ids:z.array(z.string().uuid()).min(1).max(100)}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({message:'请选择要删除的素材'});
    try {
      const all=await personal();
      if(parsed.data.ids.some(id=>!all.some(t=>t.id===id)))return res.status(404).json({message:'素材不存在，请刷新列表'});
      await library.deleteMany(parsed.data.ids);
      return res.json({deleted:parsed.data.ids.length});
    } catch {return res.status(500).json({message:'删除失败，请重试'});}
  });
}
