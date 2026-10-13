import type { Account, Note, Comment, Lead } from '../server/domain';

type Props={accounts:Account[];notes:Note[];comments:Comment[];leads:Lead[];onAccount:(id:string)=>void;onNavigate:(page:string)=>void};
export function Overview({accounts,notes,comments,leads,onAccount,onNavigate}:Props){
  const counts=new Map<string,number>();
  for(const note of notes)counts.set(note.accountId,(counts.get(note.accountId)??0)+1);
  const rows=accounts.map(account=>({...account,count:counts.get(account.id)??0})).sort((a,b)=>b.count-a.count);
  const max=Math.max(1,...rows.map(row=>row.count));
  const textCount=notes.filter(n=>n.summary?.trim()).length;
  const coverCount=notes.filter(n=>n.cover?.trim()).length;
  const metricCount=notes.filter(n=>Object.values(n.metrics).every(value=>value!==null)).length;
  const anyMetrics=notes.some(n=>Object.values(n.metrics).some(value=>value!==null));
  const totalFields=notes.length*3,knownFields=textCount+coverCount+metricCount;
  const percent=totalFields?Math.round(knownFields/totalFields*100):0;
  return <>
    <div className="overview-welcome"><div><h2>一眼掌握账号与内容</h2><p>查看已保存数据，开始今天的运营。</p></div><div className="overview-actions"><button className="ghost" onClick={()=>onNavigate('连接设置')}>同步账号</button><button className="ghost" onClick={()=>onNavigate('内容管理')}>查看内容</button><button className="primary" onClick={()=>onNavigate('发布中心')}>创作图文</button></div></div>
    <div className="metric-grid">{[['已同步账号',accounts.length],['已收录内容',notes.length],['已同步评论',comments.length],['已创建线索',leads.length]].map(([label,value])=><section className="metric" key={label}><span>{label}</span><strong>{value}</strong></section>)}</div>
    <p className="media-caption">统计范围与上方账号选择一致。记录数为工作台已收录数量，不代表小红书全部数据。</p>
    <div className="overview-charts"><section className="grey-panel"><div className="creation-heading"><h2>账号内容分布</h2><span className="creation-badge">已收录笔记</span></div><p>点击账号查看内容；接入更多账号后自动对比。</p>
      {rows.length?<><svg className="account-chart" role="img" aria-label="各账号已收录内容数量" viewBox={`0 0 560 ${Math.min(rows.length,8)*54+24}`}><title>各账号已收录内容数量</title>{rows.slice(0,8).map((row,index)=><g key={row.id} transform={`translate(0 ${index*54+12})`}><text x="0" y="17" fill="#bac7df" fontSize="12">{row.name.slice(0,10)}</text><rect x="140" y="0" width="365" height="24" rx="7" fill="#ffffff0b"/><rect x="140" y="0" width={row.count/max*365} height="24" rx="7" fill="#a9c7ff"/><text x="520" y="17" fill="#eef4ff" fontSize="13">{row.count}</text></g>)}</svg><div className="account-chart-links">{rows.slice(0,8).map(row=><button className="ghost" key={row.id} aria-label={`查看 ${row.name} · ${row.handle} 的内容：${row.count} 篇`} onClick={()=>onAccount(row.id)}>{row.name} · {row.handle}<span>{row.count} 篇 ↗</span></button>)}</div>{rows.length>8&&<button className="ghost" onClick={()=>onNavigate('账号矩阵')}>查看全部 {rows.length} 个账号</button>}</>:<div className="empty">同步第一个账号后显示图表。</div>}
    </section><section className="grey-panel"><h2>内容数据完整度</h2><p>按正文、封面和完整互动指标三项计算。</p><div className="coverage-layout"><svg role="img" aria-label={notes.length?`内容数据完整度 ${percent}%`:'尚无内容可计算完整度'} viewBox="0 0 180 180"><circle cx="90" cy="90" r="66" fill="none" stroke="#ffffff10" strokeWidth="13"/><circle cx="90" cy="90" r="66" fill="none" stroke="#a9c7ff" strokeWidth="13" strokeDasharray={`${percent*4.147} 414.7`} transform="rotate(-90 90 90)"/><text x="90" y="94" textAnchor="middle" fill="#f0f4fc" fontSize="31">{notes.length?`${percent}%`:'—'}</text><text x="90" y="117" textAnchor="middle" fill="#acb4c7" fontSize="11">{notes.length?'已采集':'尚无内容'}</text></svg><dl>{[['正文',textCount],['封面',coverCount],['完整互动指标',metricCount]].map(([label,count])=><div key={label}><dt>{label}</dt><dd>{count} / {notes.length} 篇</dd></div>)}</dl></div>
    {!anyMetrics&&<p className="coverage-notice">互动数据尚未采集</p>}<p className="media-caption">未知指标不计为零。完整互动指标要求点赞、收藏、评论、分享均已获取；此图不是账号表现评分。</p><button className="ghost" onClick={()=>onNavigate('连接设置')}>去补全数据</button></section></div>
  </>;
}
