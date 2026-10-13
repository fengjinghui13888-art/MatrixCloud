/** Copy text on secure and older browser contexts without making clipboard
 * support a prerequisite for the customer flow. */
export async function copyText(value:string):Promise<boolean>{
  try{
    if(typeof navigator!=='undefined'&&navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(value);return true;
    }
  }catch{}
  try{
    if(typeof document==='undefined')return false;
    const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';
    document.body.append(area);area.select();const copied=document.execCommand?.('copy')===true;area.remove();return copied;
  }catch{return false;}
}
