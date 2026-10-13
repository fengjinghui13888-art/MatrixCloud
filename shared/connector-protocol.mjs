// The cloud channel only carries existing account, sync and draft operations.
// It never accepts shell commands, arbitrary URLs or browser evaluation scripts.
export function validConnectorCommand(method,path,body){
  if(method==='GET'&&path==='/verify')return true;
  if(method==='POST'&&path==='/cleanup')return !!body&&Object.keys(body).every(k=>k==='manifestId')&&(body.manifestId===undefined||/^[a-f0-9-]{36}$/.test(body.manifestId));
  const account=/^\/accounts\/([a-zA-Z0-9_-]{1,100})\/(login|state|image|remove|cancel|resume|safety)$/.exec(path);
  if(account)return account[2]==='resume'?method==='POST'&&body?.confirmed===true:method===(['state','image','safety'].includes(account[2])?'GET':'POST')&&body===undefined;
  if(path==='/studio'&&method==='POST')return body&&/^[a-f0-9-]{36}$/i.test(body.runId)&&/^[a-f0-9-]{36}$/i.test(body.taskId)&&/^local:[\w-]{1,100}$/.test(body.profile);
  if(/^\/studio\/[a-f0-9-]{36}\/cancel$/i.test(path))return method==='POST';
  if(/^\/studio\/[a-f0-9-]{36}$/i.test(path))return method==='GET';
  const sync=/^\/sync\/([a-f0-9-]{36})(?:\/(result|cancel|media)(?:\/([a-f0-9]{32}))?)?$/.exec(path);
  if(!sync)return false;
  if(sync[2]==='media')return method==='GET'&&!!sync[3];
  if(sync[2]==='cancel')return method==='POST';
  if(sync[2]==='result')return method==='GET';
  return method==='GET'||(method==='POST'&&body&&/^local:[\w-]{1,100}$/.test(body.target?.profile)&&typeof body.target?.id==='string'&&Array.isArray(body.knownNotes));
}
