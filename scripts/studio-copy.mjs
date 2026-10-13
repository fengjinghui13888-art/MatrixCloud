// Only normalize whitespace BETWEEN verified native topics, never in the body.
export function matchesNativeTopicText(text,body,tags,{persisted=false}={}){
 if(!tags.length||!text.startsWith(body+'\n'))return false;
 let remaining=text.slice(body.length).trim();
 for(const tag of tags){
  const label='#'+tag+(persisted?'[话题]#':'');
  if(!remaining.startsWith(label))return false;
  remaining=remaining.slice(label.length).trimStart();
 }
 return remaining==='';
}
