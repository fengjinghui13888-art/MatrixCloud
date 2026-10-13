import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Note, Comment } from '../contracts/domain';

const archivedUrl=(note:Note,id:string)=>`/api/accounts/${encodeURIComponent(note.accountId)}/media/${encodeURIComponent(note.id)}/${encodeURIComponent(id)}`;
const safeMedia=(value:string|null|undefined)=>!!value&&(/^https?:\/\//i.test(value)||/^\/api\/accounts\/[^/]+\/media\/[^/]+\/[a-f0-9]+$/.test(value));
function NoteMedia({note}:{note:Note}){
  const [index,setIndex]=useState(0);const [failed,setFailed]=useState(false);
  const safe=safeMedia;
  const assets=note.mediaAssets??[];
  const images=(note.images??[]).map((url,index)=>{const asset=assets.find(a=>a.kind==='image'&&a.index===index&&a.sourceUrl===url);return asset?archivedUrl(note,asset.id):url;}).filter(safe);
  const video=assets.find(a=>a.kind==='video'&&a.sourceUrl===note.videoUrl);
  const videoUrl=video?archivedUrl(note,video.id):note.videoUrl;
  if(note.mediaType==='video'||note.videoUrl)return <div className="note-media">
    {safe(videoUrl)&&!failed?<video aria-label="笔记视频" src={videoUrl!} poster={safe(note.cover)?note.cover!:undefined} controls playsInline preload="metadata" onError={()=>setFailed(true)}/>:<div className="content-missing"><h3>{failed?'视频加载失败':'视频尚未同步'}</h3><p>{failed?'原地址可能已过期或限制访问，请重新采集。':'需要采集真实视频地址，封面不能代替视频。'}</p></div>}
  </div>;
  if(!images.length)return <NoteCover note={note} large/>;
  return <div className="note-media">
    {failed?<p role="status">图片加载失败，请重新同步此笔记。</p>:<img src={images[index]} alt={`笔记图片 ${index+1} / ${images.length}`} referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>}
    <div className="gallery-controls"><button className="ghost" disabled={index===0} onClick={()=>{setIndex(i=>i-1);setFailed(false);}}>上一张</button><span>{index+1} / {images.length}</span><button className="ghost" disabled={index===images.length-1} onClick={()=>{setIndex(i=>i+1);setFailed(false);}}>下一张</button></div>
  </div>;
}

export function NoteCover({note,large=false}:{note:Note;large?:boolean}){
  const [failed,setFailed]=useState(false);
  const asset=note.mediaAssets?.find(a=>a.sourceUrl===note.cover);
  const source=asset?archivedUrl(note,asset.id):safeMedia(note.cover)?note.cover:null;
  useEffect(()=>setFailed(false),[source]);
  return <div className={'note-cover'+(large?' note-cover-large':'')}>
    {source&&!failed?<img src={source} alt={`${note.title} 的封面`} loading={large?'eager':'lazy'} referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<div className="cover-empty"><span aria-hidden="true">▧</span><p>{failed?'封面暂时无法加载':'尚未获取封面'}</p></div>}
  </div>;
}

export function NoteCard({note,account,onOpen,onDelete}:{note:Note;account:string;onOpen:()=>void;onDelete?:()=>void}){
  return <article className="library-card">
    <NoteCover note={note}/>
    <button className="library-card-open" aria-label={`阅读 ${note.title}`} onClick={onOpen}><div className="library-card-body"><div className="note-byline"><span>{account}</span><time>{note.publishedAt.split(' ')[0]}</time></div>
      <h2>{note.title}</h2><p className="note-excerpt">{note.summary?.trim()||'正文尚未同步，可先查看已获取的封面。'}</p>
      <div className="note-footer"><span>查看内容 ↗</span><span>{note.metrics.likes===null?'数据待补全':`${note.metrics.likes} 次点赞`}</span></div>
    </div></button>
    {onDelete&&<button className="card-delete" onClick={e=>{e.stopPropagation();onDelete();}}>删除</button>}
  </article>;
}

export function NoteDetail({note,account,onClose,comments=[]}:{note:Note;account:string;onClose:()=>void;comments?:Comment[]}){
  const discussion=comments.filter(c=>c.noteId===note.id&&c.accountId===note.accountId);
  const panel=useRef<HTMLDivElement>(null);
  const close=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const shell=document.querySelector('.app-shell');
    const wasInert=shell?.hasAttribute('inert');shell?.setAttribute('inert','');close.current?.focus();
    return()=>{if(!wasInert)shell?.removeAttribute('inert');previous?.focus();};
  },[]);
  return createPortal(<div className="note-detail-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div ref={panel} className="note-detail" role="dialog" aria-modal="true" aria-label={note.title} onKeyDown={e=>{
      if(e.key==='Escape'){e.stopPropagation();onClose();}
      if(e.key==='Tab'){
        const items=panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,video[controls]');
        if(!items?.length)return;
        const first=items[0],last=items[items.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    }}>
      <header className="note-detail-header"><span>内容详情</span><button ref={close} className="ghost" onClick={onClose} aria-label="关闭详情">关闭 <kbd>Esc</kbd></button></header>
      <div className="note-detail-scroll"><div className="note-reading-layout"><NoteMedia key={note.id} note={note}/>
        <article className="note-article"><div className="note-byline"><span>{account}</span><time>{note.publishedAt}</time></div><h1>{note.title}</h1>
          {note.summary?.trim()?<p className="note-full-text">{note.summary}</p>:<div className="content-missing"><h3>正文还没有同步</h3><p>当前仅采集到笔记列表信息。这里不会用 AI 生成文字代替你的原文。</p></div>}
          {!note.mediaType&&!note.images?.length&&!note.videoUrl&&<p className="media-caption">当前仅有封面，完整媒体尚未同步。</p>}
          <dl className="note-metrics">{Object.entries({点赞:note.metrics.likes,收藏:note.metrics.collects,评论:note.metrics.comments,分享:note.metrics.shares}).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??'未获取'}</dd></div>)}</dl>
          {note.url&&/^https:\/\/(www\.)?xiaohongshu\.com\//.test(note.url)?<a className="note-original" href={note.url} target="_blank" rel="noreferrer">在小红书查看原文 ↗</a>:<p className="media-caption">原文链接尚未获取</p>}
          <details className="note-source"><summary>采集信息</summary><p>笔记编号：{note.id}</p><p>本地已保存 {note.mediaAssets?.length??0} 个媒体文件。</p><p>未获取的字段不代表数据为零。</p></details>
          <section className="note-discussion" aria-label="笔记评论"><h2>评论 · 已收录 {discussion.length} 条</h2>{discussion.map(c=><article key={c.id}><strong>{c.author}</strong><p>{c.body}</p><time>{c.createdAt}</time></article>)}<p className="media-caption">{discussion.length?'以上为已采集评论，尚未核验是否到达评论列表末尾。':'尚未采集评论，不代表原笔记没有评论。'}</p></section>
        </article></div></div>
    </div>
  </div>,document.body);
}
