type RecordId={accountId:string;id:string};
type Snapshot={notes?:RecordId[];comments?:RecordId[];messages?:RecordId[]};
export function newSyncRecords(before:Snapshot|null,after:Snapshot){
 const result={notes:0,comments:0,messages:0};if(!before)return result;
 for(const kind of ['notes','comments','messages'] as const){
  const known=new Set((before[kind]??[]).map(row=>JSON.stringify([row.accountId,row.id])));
  const current=new Set((after[kind]??[]).map(row=>JSON.stringify([row.accountId,row.id])));
  result[kind]=[...current].filter(id=>!known.has(id)).length;
 }
 return result;
}
