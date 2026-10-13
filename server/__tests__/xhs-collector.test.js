import {extractContent} from '../../scripts/xhs-content.mjs';

test('creator posted response preserves every image, video cover and actual counts',()=>{
 const result=extractContent({data:{notes:[{id:'owned',display_title:'真实图集',type:'normal',time:'2025-01-02 12:00',images_list:[{url:'https://sns.xhscdn.com/1'},{url:'https://sns.xhscdn.com/2'}],likes:3,comments_count:2,shared_count:1},{id:'video',display_title:'视频',type:'video',images_list:[{url:'https://sns.xhscdn.com/cover'}]}]}},'a');
 expect(result.notes).toHaveLength(2);
 expect(result.notes[0].images).toHaveLength(2);
 expect(result.notes[0].metrics.comments).toBe(2);
 expect(result.notes[0].publishedAt).toBe('2025-01-02 12:00');
 expect(result.notes[1].videoUrl).toBeNull();
});

test('comment list response can inherit the requested note id and retain replies',()=>{
 const result=extractContent({comments:[{id:'c1',content:'正文',user_info:{nickname:'甲'},sub_comments:[{id:'c2',content:'回复',user_info:{nickname:'乙'}}]}]},'a',{noteId:'n'});
 expect(result.comments.map(c=>[c.id,c.noteId])).toEqual([['c1','n'],['c2','n']]);
});

test('web detail camelCase image links and video stream are extracted',()=>{
 const r=extractContent({noteId:'n',title:'详情',desc:'原文',type:'video',time:1700000000000,imageList:[{urlDefault:'https://sns.xhscdn.com/a'}],video:{media:{stream:{h264:[{masterUrl:'https://sns.xhscdn.com/v.mp4'}]}}}},'a');
 expect(r.notes[0].images).toEqual(['https://sns.xhscdn.com/a']);expect(r.notes[0].publishedAt).toContain('2023');
});
test('notification comment uses comment id and owned note, not notification id',()=>{
 const r=extractContent({message_list:[{id:'notification',time:1700000000,user_info:{nickname:'reader'},comment_info:{id:'c',content:'实际评论'},item_info:{id:'n',type:'note_info'}}]},'a');
 expect(r.comments[0]).toMatchObject({id:'c',noteId:'n',body:'实际评论'});
});
test('history messages retain sender direction and ignore unrelated accounts',()=>{
 const message={id:'m',sender_id:'self',receiver_id:'peer',created_at:1700000000000,content:JSON.stringify({content:'hello',content_type:1})};
 const r=extractContent({out_message_list:[message,{...message,id:'bad',sender_id:'other'}]},'a',{selfId:'self',peers:{peer:'读者'},selfName:'作者'});
 expect(r.messages).toHaveLength(1);expect(r.messages[0]).toMatchObject({body:'hello',conversationId:'peer',direction:'outgoing',author:'作者'});
});
