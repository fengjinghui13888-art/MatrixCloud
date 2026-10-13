import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, Check, X, Search, RefreshCw } from 'lucide-react';
import { templateCategories, type LibraryTemplate } from '../../shared/templates';
import './styles/template-library.css';

type Props = {request:(path:string,body?:unknown)=>Promise<any>;onUse:(items:LibraryTemplate[])=>void};
type UploadRow = {name:string;state:'waiting'|'uploading'|'saved'|'failed';message?:string};
const mb=(bytes:number)=>(bytes/1024/1024).toFixed(bytes>=1024*1024?1:2)+' MB';
const asDataUrl=(file:Blob)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('文件读取失败'));reader.onabort=()=>reject(Error('文件读取已取消'));reader.readAsDataURL(file);});
export async function prepareTemplateImage(file:File){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('仅支持 JPG、PNG、WebP');
  if(file.size>30*1024*1024)throw Error('原图超过 30 MB，请先导出较小版本');
  if(file.type!=='image/jpeg'||file.size<1.5*1024*1024)return {data:await asDataUrl(file),bytes:file.size,compressed:false};
  let bitmap:ImageBitmap|undefined;
  try{
    bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    const scale=Math.min(1,2560/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');if(!context)throw Error('浏览器无法压缩图片');
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片压缩失败')),'image/jpeg',0.86));
    // Keep the original when compression provides little benefit.
    if(blob.size>=file.size*0.9)return {data:await asDataUrl(file),bytes:file.size,compressed:false};
    return {data:await asDataUrl(blob),bytes:blob.size,compressed:true};
  }catch(e){
    if(file.size<=8*1024*1024)return {data:await asDataUrl(file),bytes:file.size,compressed:false};
    throw e;
  }finally{bitmap?.close();}
}
export function TemplateLibrary({request,onUse}:Props) {
  const [items,setItems]=useState<LibraryTemplate[]>([]);
  const [selected,setSelected]=useState<string[]>([]);
  const [query,setQuery]=useState(''),[category,setCategory]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [uploads,setUploads]=useState<UploadRow[]>([]),[preview,setPreview]=useState<LibraryTemplate|null>(null);
  const [page,setPage]=useState(1);
  const input=useRef<HTMLInputElement>(null),requester=useRef(request),uploading=useRef(false);
  requester.current=request;
  async function refresh(){setLoading(true);try{const result=await requester.current('templates/mine');setItems(Array.isArray(result)?result:(result?.items??[]));setError('');}catch(e){setError(e instanceof Error?e.message:'读取素材失败');}finally{setLoading(false);}}
  useEffect(()=>{void refresh();},[]);
  async function upload(files:File[]) {
    if(uploading.current||!files.length)return;
    if(files.length>30){setError('每批最多上传 30 张图片');return;}
    uploading.current=true;setBusy(true);setError('');setUploads(files.map(f=>({name:f.name,state:'waiting'})));
    for(let i=0;i<files.length;i++){
      const file=files[i];
      const mark=(row:Partial<UploadRow>)=>setUploads(rows=>rows.map((r,j)=>j===i?{...r,...row}:r));
      try{
        mark({state:'uploading',message:'正在优化图片…'});
        const prepared=await prepareTemplateImage(file);
        if(prepared.bytes>8*1024*1024)throw Error('优化后仍超过 8 MB，请先导出较小版本');
        mark({message:prepared.compressed?`已从 ${mb(file.size)} 压缩至 ${mb(prepared.bytes)}，正在上传…`:'正在上传…'});
        const result=await requester.current('templates/upload',{fileName:file.name,data:prepared.data,category:category||'生活方式'});
        setItems(old=>[result.item,...old.filter(t=>t.id!==result.item.id)]);
        mark({state:'saved',message:(result.duplicate?'已在素材库':'已保存')+(prepared.compressed?` · ${mb(file.size)} → ${mb(prepared.bytes)}`:'')});
      }catch(e){mark({state:'failed',message:e instanceof Error?e.message:'上传失败，请重新选择'});}
    }
    setPage(1);setBusy(false);uploading.current=false;
  }
  async function remove(ids:string[]) {
    if(!window.confirm(`从素材库删除 ${ids.length} 张图片？已生成的内容不会被删除。`))return;
    setBusy(true);
    try{await requester.current('templates/bulk-delete',{ids});setItems(old=>old.filter(t=>!ids.includes(t.id)));setSelected(old=>old.filter(id=>!ids.includes(id)));setPreview(null);setError('');}
    catch(e){setError(e instanceof Error?e.message:'删除失败');}finally{setBusy(false);}
  }
  const filtered=items.filter(t=>(!category||t.category===category)&&t.name.toLowerCase().includes(query.toLowerCase()));
  const pages=Math.max(1,Math.ceil(filtered.length/12)),current=Math.min(page,pages);
  const chosen=items.filter(t=>selected.includes(t.id));
  const toggle=(id:string)=>setSelected(old=>old.includes(id)?old.filter(x=>x!==id):old.length<9?[...old,id]:old);
  return <section className="personal-library" aria-label="我的图片素材">
    <header className="asset-heading"><div><h2>模板素材库</h2><span>我的图片 · {items.length} 张</span></div>
      <button type="button" className="primary asset-upload" disabled={busy} onClick={()=>input.current?.click()}><Upload size={18}/>{busy?'正在处理…':'上传图片'}</button>
      <input ref={input} type="file" aria-label="本地图片文件" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e=>{const files=Array.from(e.currentTarget.files??[]);e.currentTarget.value='';void upload(files);}}/>
    </header>
    <div className="asset-filters"><label className="asset-search"><Search size={18}/><input aria-label="搜索素材" placeholder="搜索素材名称" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/></label>
      <select aria-label="素材分类" value={category} onChange={e=>{setCategory(e.target.value);setPage(1);}}><option value="">全部分类</option>{templateCategories.map(c=><option key={c}>{c}</option>)}</select>
      <button type="button" className="ghost asset-icon" title="刷新素材" aria-label="刷新素材" disabled={busy||loading} onClick={()=>void refresh()}><RefreshCw size={18}/></button>
    </div>
    {error&&<p role="alert" className="asset-error">{error}</p>}
    {!!uploads.length&&<div className="asset-progress" aria-live="polite"><div><strong>已保存 {uploads.filter(r=>r.state==='saved').length}/{uploads.length}</strong>{!busy&&<button className="ghost asset-icon" title="关闭上传记录" aria-label="关闭上传记录" onClick={()=>setUploads([])}><X size={16}/></button>}</div>{uploads.map((r,i)=><p key={i} className={r.state==='failed'?'asset-error':''}><span>{r.name}</span><span>{r.message??(r.state==='uploading'?'上传中…':'等待上传')}</span></p>)}</div>}
    {loading?<p role="status">正在读取素材…</p>:!filtered.length?<div className="asset-empty" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(Array.from(e.dataTransfer.files));}}><Upload size={30}/><h3>{items.length?'没有匹配的素材':'还没有图片素材'}</h3><button type="button" className="primary" disabled={busy} onClick={()=>input.current?.click()}>选择本地图片</button><small>JPG / PNG / WebP · 大尺寸实拍 JPG 自动优化后上传</small></div>:<div className="asset-grid">{filtered.slice((current-1)*12,current*12).map((item,index)=><article className={'asset-card'+(selected.includes(item.id)?' selected':'')} key={item.id}>
      <button type="button" className="asset-preview" onClick={()=>setPreview(item)} aria-label={`预览 ${item.name}`}><img src={item.images[0]+'?size=thumb'} alt={item.name} loading={index<4?'eager':'lazy'} decoding="async"/></button>
      <div className="asset-info"><label><input type="checkbox" aria-label={`选择 ${item.name}`} checked={selected.includes(item.id)} disabled={!selected.includes(item.id)&&selected.length>=9} onChange={()=>toggle(item.id)}/><span title={item.name}>{item.name}</span></label><button type="button" className="ghost asset-icon" title={`删除 ${item.name}`} aria-label={`删除 ${item.name}`} disabled={busy} onClick={()=>void remove([item.id])}><Trash2 size={16}/></button></div>
      <small>{item.category}</small>
    </article>)}</div>}
    <footer className="asset-footer"><span>已选 {chosen.length}/9 张</span><button type="button" className="primary" disabled={!chosen.length||busy} onClick={()=>onUse(chosen)}><Check size={16}/>使用所选图片</button><button type="button" className="ghost" disabled={!chosen.length||busy} onClick={()=>void remove(chosen.map(t=>t.id))}><Trash2 size={16}/>删除所选</button>{pages>1&&<div className="asset-pages"><button className="ghost" disabled={current===1} onClick={()=>setPage(current-1)}>上一页</button><span>{current}/{pages}</span><button className="ghost" disabled={current===pages} onClick={()=>setPage(current+1)}>下一页</button></div>}</footer>
    {preview&&<div className="asset-modal-backdrop" onClick={()=>setPreview(null)}><section role="dialog" aria-modal="true" aria-label="图片预览" className="asset-modal" onClick={e=>e.stopPropagation()}><header><h3>{preview.name}</h3><button className="ghost asset-icon" aria-label="关闭预览" onClick={()=>setPreview(null)}><X/></button></header><img src={preview.images[0]} alt={preview.name}/><button className="primary" disabled={!selected.includes(preview.id)&&selected.length>=9} onClick={()=>{toggle(preview.id);setPreview(null);}}>{selected.includes(preview.id)?'取消选择':'选择这张图片'}</button></section></div>}
  </section>;
}
