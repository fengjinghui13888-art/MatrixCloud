/**
 * Safari private browsing and locked-down enterprise profiles can expose
 * sessionStorage while throwing SecurityError on access.  The workbench must
 * keep operating in that case; pairing is still confirmed by the server and
 * the connector heartbeat, while this storage is only a resume hint.
 */
export function readSessionValue(key:string):string|null{
  try{return window.sessionStorage.getItem(key);}catch{return null;}
}

export function writeSessionValue(key:string,value:string):boolean{
  try{window.sessionStorage.setItem(key,value);return true;}catch{return false;}
}

export function removeSessionValue(key:string):void{
  try{window.sessionStorage.removeItem(key);}catch{}
}
