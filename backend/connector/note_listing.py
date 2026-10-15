"""Read the whole visible creator list without confusing page size with total."""

async def collect_note_pages(owned,read_state,advance,drain,report,max_pages=100):
    stalls=0;largest_total=0;last={}
    for turn in range(max_pages):
        last=await read_state()
        total=last.get('total')
        if isinstance(total,int) and total>0:largest_total=max(largest_total,total)
        await report(f'已读取 {len(owned)}'+(f'/{largest_total}' if largest_total else '')+' 篇，正在继续加载笔记列表')
        # Always attempt another load after the first batch, even if all ten
        # notes are known or an endpoint's per-page field happens to be -1.
        if turn and largest_total and len(owned)>=largest_total:
            return dict(complete=True,total=largest_total,loaded=len(owned),state=last)
        before=len(owned)
        await advance();await drain()
        if len(owned)>before:
            stalls=0
        else:
            stalls+=1
            if stalls>=3:
                complete=bool(last.get('atEnd') and (not largest_total or len(owned)>=largest_total))
                return dict(complete=complete,total=largest_total or None,loaded=len(owned),state=last)
    return dict(complete=False,total=largest_total or None,loaded=len(owned),state=last)


LIST_STATE = r'''() => {
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const cards=[...document.querySelectorAll('.note-card')];
 const texts=[...document.querySelectorAll('[class*="pagination"], [class*="total"], [class*="count"], [class*="tab"]')].filter(visible).map(e=>e.innerText||'');
 const totals=texts.flatMap(t=>[...t.matchAll(/(?:共|全部笔记|笔记总数|全部作品)\s*[（(]?\s*(\d+)\s*(?:[）)]|篇|条)?/g)].map(m=>Number(m[1])));
 const next=[...document.querySelectorAll('button[aria-label*="下一页"],button[aria-label*="Next"],.el-pagination .btn-next,.ant-pagination-next,[class*="pagination"] [class*="next"]')].filter(visible);
 const nextDisabled=next.length>0&&next.every(e=>e.disabled||e.getAttribute('aria-disabled')==='true'||/disabled/.test(e.className));
 let scroller=cards[0]?.parentElement;
 while(scroller&&!(scroller.scrollHeight>scroller.clientHeight+10&&/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)))scroller=scroller.parentElement;
 scroller=scroller||document.scrollingElement;
 const bottom=!!scroller&&scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-8;
 const ended=/没有更多|已全部加载|到底了|暂无更多/.test(document.body.innerText);
 return {visibleCards:cards.length,total:totals.length?Math.max(...totals):null,atEnd:nextDisabled||(bottom&&ended),nextButtons:next.length,nextDisabled,scrollTop:scroller?.scrollTop,scrollHeight:scroller?.scrollHeight,clientHeight:scroller?.clientHeight,pagination:texts.filter(t=>/共|页|条|篇/.test(t)).map(t=>t.slice(0,100)).slice(0,8)};
}'''

ADVANCE_LIST = r'''() => {
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const candidates=[...document.querySelectorAll('button[aria-label*="下一页"],button[aria-label*="Next"],.el-pagination .btn-next,.ant-pagination-next,[class*="pagination"] [class*="next"]')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!/disabled/.test(e.className));
 if(candidates.length===1){candidates[0].click();return {action:'next'};}
 const card=document.querySelector('.note-card');let scroller=card?.parentElement;
 while(scroller&&!(scroller.scrollHeight>scroller.clientHeight+10&&/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)))scroller=scroller.parentElement;
 scroller=scroller||document.scrollingElement;
 if(!scroller)return {action:'unavailable'};
 const before=scroller.scrollTop;scroller.scrollTop=scroller.scrollHeight;
 scroller.dispatchEvent(new Event('scroll',{bubbles:true}));
 return {action:'scroll',before,after:scroller.scrollTop};
}'''
