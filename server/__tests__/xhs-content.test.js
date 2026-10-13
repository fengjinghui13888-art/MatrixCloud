import {extractContent} from '../../scripts/xhs-content.mjs';
test('rich media and comments retain account ownership and source order; empty menus are not data',()=>{
 expect(extractContent({text:'评论 私信 粉丝'},'a')).toEqual({notes:[],comments:[],messages:[],followers:null});
 const data=extractContent({notes:[{note_id:'note1',title:'图集',type:'normal',desc:'原文',image_list:[{url_default:'https://example.com/2.jpg'},{url_default:'https://example.com/1.jpg'}]},{note_id:'note2',title:'视频',type:'video',video:{media:{stream:{h264:[{master_url:'https://example.com/video.mp4'}]}}}}],comments:[{comment_id:'c1',note_id:'note1',user_info:{nickname:'reader'},content:'评论'}]},'account1');
 expect(data.notes[0].images).toEqual(['https://example.com/2.jpg','https://example.com/1.jpg']);expect(data.notes[1].videoUrl).toBe('https://example.com/video.mp4');expect(data.comments[0].accountId).toBe('account1');expect(data.notes[0].metrics.likes).toBeNull();
});
