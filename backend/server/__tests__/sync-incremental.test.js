import {needsNoteDetail} from '../../../scripts/sync-policy.mjs';
test('existing incomplete notes are repaired; complete notes can use incremental sync',()=>{
 expect(needsNoteDetail({id:'n',summary:null,images:[]})).toBe(true);
 expect(needsNoteDetail({id:'n',summary:'text',mediaType:'video',videoUrl:null})).toBe(true);
 expect(needsNoteDetail({id:'n',summary:'text',mediaType:'image',images:['https://example.test/a.jpg']})).toBe(false);
});
