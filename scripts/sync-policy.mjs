export function needsNoteDetail(note){
 if(!note||!note.summary?.trim())return true;
 return note.mediaType==='video'?!note.videoUrl:!note.images?.length;
}
