// @vitest-environment node
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import express from 'express';
import request from 'supertest';
import {it,expect} from 'vitest';
import {connectorDownloadRoutes} from '../connector-downloads';
it('returns a real ZIP attachment with its exact extension and rejects unknown platforms',async()=>{
 const root=mkdtempSync(join(tmpdir(),'connector-downloads-'));
 try{
  const bytes=Buffer.from([0x50,0x4b,0x03,0x04,0,0]);writeFileSync(join(root,'matrix-cloud-windows-connector.zip'),bytes);
  const app=express();connectorDownloadRoutes(app,root);
  const listed=await request(app).get('/api/connector/downloads');expect(listed.body.downloads).toHaveLength(1);
  const download=await request(app).get('/api/connector/download/windows').buffer(true).parse((res,callback)=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>callback(null,Buffer.concat(chunks)));});
  expect(download.headers['content-type']).toBe('application/zip');
  expect(download.headers['content-disposition']).toContain('filename="matrix-cloud-windows-connector.zip"');
  expect(download.body).toEqual(bytes);
  expect((await request(app).get('/api/connector/download/unknown')).status).toBe(404);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('lists distinct architecture packages only when present in the published directory',async()=>{
 const root=mkdtempSync(join(tmpdir(),'connector-architectures-'));
 try{
  const names=['matrix-cloud-windows-arm64-connector.zip','matrix-cloud-windows-x86-connector.zip','matrix-cloud-linux-x64-connector.zip','matrix-cloud-linux-arm64-connector.zip'];
  for(const name of names)writeFileSync(join(root,name),Buffer.from('PK fixture'));
  const app=express();connectorDownloadRoutes(app,root);
  const result=await request(app).get('/api/connector/downloads');
  expect(result.body.downloads.map((p:any)=>p.id)).toEqual(['windows-arm64','windows-x86','linux-x64','linux-arm64']);
  for(const item of result.body.downloads){
   const download=await request(app).get(item.url);expect(download.status).toBe(200);
   expect(download.headers['content-disposition']).toContain(item.filename);
  }
  expect((await request(app).get('/api/connector/download/mac-arm64')).status).toBe(404);
 }finally{rmSync(root,{recursive:true,force:true});}
});
