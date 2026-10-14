import {useEffect,useRef} from 'react';
import {createPortal} from 'react-dom';

export function ImagePreview({images,index,onIndex,onClose}:{images:string[];index:number;onIndex:(index:number)=>void;onClose:()=>void}){
 const panel=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null),actions=useRef({onClose,onIndex,index});actions.current={onClose,onIndex,index};
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;document.body.style.overflow='hidden';close.current?.focus();
  const key=(e:KeyboardEvent)=>{
   if(e.key==='Escape'){e.preventDefault();actions.current.onClose();}
   if(e.key==='ArrowLeft'&&actions.current.index>0)actions.current.onIndex(actions.current.index-1);
   if(e.key==='ArrowRight'&&actions.current.index<images.length-1)actions.current.onIndex(actions.current.index+1);
   if(e.key==='Tab'){const items=[...panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]],first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };
  window.addEventListener('keydown',key);return()=>{window.removeEventListener('keydown',key);document.body.style.overflow=overflow;previous?.focus();};
 },[images.length]);
 return createPortal(<div className="image-preview-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="image-preview" ref={panel} role="dialog" aria-modal="true" aria-label="图片预览"><header><strong>图片预览 · 第 {index+1}/{images.length} 张</strong><button ref={close} onClick={onClose} aria-label="关闭图片预览">关闭</button></header><img src={images[index]} alt={`放大配图 ${index+1}`}/><footer><button disabled={index===0} onClick={()=>onIndex(index-1)}>上一张</button><span>可用左右方向键切换，Esc 关闭</span><button disabled={index===images.length-1} onClick={()=>onIndex(index+1)}>下一张</button></footer></div></div>,document.body);
}
