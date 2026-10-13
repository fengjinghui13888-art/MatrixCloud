export function parseOpenCLI(stdout) {
 const raw=stdout.trim();
 if(!raw)return null;
 const unwrap=value=>value&&typeof value==='object'&&typeof value.session==='string'&&'data' in value?value.data:value;
 try{return unwrap(JSON.parse(raw));}catch{}
 const lines=raw.split('\n');
 for(let i=0;i<lines.length;i++){
  if(!/^[\[{]/.test(lines[i].trim()))continue;
  try{return unwrap(JSON.parse(lines.slice(i).join('\n')));}catch{}
 }
 if(!/[\n\r]/.test(raw)&&! /^[\[{]/.test(raw))return raw;
 throw Error(`OpenCLI 返回无法解析：${raw.slice(-500)}`);
}
