import {existsSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Express} from 'express';
import {CONNECTOR_PLATFORMS} from '../../shared/connector-platforms.mjs';

const packages=CONNECTOR_PLATFORMS.map(({source,...item})=>item);

export function connectorDownloadRoutes(app:Express,directory:string){
  const available=()=>packages.flatMap(item=>{
    const file=resolve(directory,item.filename);
    return existsSync(file)&&statSync(file).isFile()?[{...item,bytes:statSync(file).size,url:'/api/connector/download/'+item.id}]:[];
  });
  app.get('/api/connector/downloads',(_req,res)=>res.json({downloads:available()}));
  app.get('/api/connector/download/:platform',(req,res)=>{
    const item=available().find(p=>p.id===req.params.platform);
    if(!item)return res.status(404).json({message:'此平台安装包尚未发布，请联系管理员'});
    res.set({'Content-Type':'application/zip','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});
    return res.download(resolve(directory,item.filename),item.filename,error=>{
      if(error&&!res.headersSent)res.status(500).json({message:'安装包下载失败，请重试'});
    });
  });
}
