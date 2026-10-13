"""Normalize only content actually returned by the authenticated website."""
from __future__ import annotations
import json
import math
from datetime import datetime,timezone

def needs_note_detail(note):
    return not note or not str(note.get('summary') or '').strip() or (not note.get('videoUrl') if note.get('mediaType')=='video' else not note.get('images'))

def verified_incremental_note_ownership(mode,target,known_notes,creator,web):
    if mode!='incremental' or not target.get('id') or not target.get('handle') or not creator.get('userId') or str(creator.get('redId'))!=str(target['handle']) or web.get('guest') is True or not web.get('user_id') or not web.get('red_id') or str(web['user_id'])!=str(creator['userId']) or str(web['red_id'])!=str(target['handle']): return set()
    return {n['id'] for n in known_notes if n.get('accountId')==target['id'] and isinstance(n.get('id'),str) and n['id']}

def extract_content(input,account_id,context=None):
    context=context or {}; notes={}; comments={}; messages={}; followers=None; seen={}
    def text(v):return v if isinstance(v,str) else ''
    def count(v):
        if v is None or v=='':return None
        try:n=float(str(v).replace(',','')); return int(n) if math.isfinite(n) and n>=0 and n.is_integer() else n if math.isfinite(n) and n>=0 else None
        except ValueError:return None
    def url(v):return v if isinstance(v,str) and v.startswith(('http://','https://')) else None
    def date(v):
        if isinstance(v,(int,float)) and not isinstance(v,bool):
            try:return datetime.fromtimestamp(v/1000 if v>=1e12 else v,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            except (ValueError,OverflowError,OSError):return ''
        return text(v)
    def media(v):
        if not isinstance(v,dict):return url(v)
        for key in ('urlDefault','urlPre','url_default','url','url_pre'):
            if url(v.get(key)):return v[key]
        return next((url(i.get('url')) for i in v.get('info_list',[]) if isinstance(i,dict) and i.get('image_scene')=='WB_DFT' and url(i.get('url'))),None)
    def walk(o,depth=0):
        nonlocal followers
        if not isinstance(o,(dict,list)) or depth>18 or id(o) in seen:return
        # Retain references: synthetic notification dicts otherwise get recycled IDs.
        seen[id(o)]=o
        if isinstance(o,list):
            for item in o:walk(item,depth+1)
            return
        if isinstance(o.get('comment_info'),dict) and o['comment_info'].get('id') and isinstance(o.get('item_info'),dict) and o['item_info'].get('id') and o.get('user_info'):
            walk(dict(comment_id=o['comment_info']['id'],note_id=o['item_info']['id'],content=o['comment_info'].get('content'),user_info=o['user_info'],time=o.get('time')),depth+1)
        if o.get('id') and o.get('sender_id') and o.get('receiver_id') and context.get('selfId') in (o['sender_id'],o['receiver_id']) and not o.get('group_chat'):
            try:payload=json.loads(o.get('content',''))
            except (ValueError,TypeError):payload=dict(content=text(o.get('content')))
            if isinstance(payload,dict):
                body=payload.get('content')
                try:
                    nested=json.loads(body)
                    if isinstance(nested,dict):body=nested.get('content') or nested.get('title') or payload.get('front_chain')
                except (ValueError,TypeError):pass
                if not isinstance(body,str) or not body.strip():body=payload.get('front_chain')
                if isinstance(body,str) and body.strip():
                    outgoing=o['sender_id']==context['selfId']; peer=o['receiver_id'] if outgoing else o['sender_id']
                    messages[o['id']]=dict(id=o['id'],accountId=account_id,conversationId=peer,author=(context.get('selfName') or context['selfId']) if outgoing else context.get('peers',{}).get(peer,peer),body='[消息已撤回]' if o.get('revoked') else body,createdAt=date(o.get('created_at')),direction='outgoing' if outgoing else 'incoming')
        if 'fans_count' in o or 'fansCount' in o:followers=count(o.get('fans_count',o.get('fansCount')))
        note_id=text(o.get('note_id') or o.get('noteId') or (o.get('id') if o.get('image_list') or o.get('imageList') or o.get('images_list') or o.get('video') or o.get('type')=='video' else ''))
        title=text(o.get('display_title') or o.get('displayTitle') or o.get('title')); image_list=o.get('image_list',o.get('imageList',o.get('images_list',o.get('images'))))
        if note_id and title and (isinstance(image_list,list) or o.get('video') or o.get('type') in ('video','normal')):
            images=[m for i in image_list or [] if (m:=media(i))]; video=o.get('video') or {}; streams=video.get('media',{}).get('stream',{})
            stream=next((s for v in streams.values() for s in v if isinstance(s,dict) and (s.get('master_url') or s.get('masterUrl'))),{})
            metrics=o.get('interact_info') or o.get('interactInfo') or o
            notes[note_id]=dict(id=note_id,accountId=account_id,title=title,summary=text(o.get('desc') or o.get('description') or o.get('content')) or None,cover=media(o.get('cover')) or (images[0] if images else None),url=url(o.get('url')) or 'https://www.xiaohongshu.com/explore/'+note_id,publishedAt=date(o.get('publish_time') or o.get('publishTime') or o.get('time')),mediaType='video' if o.get('type')=='video' or video else 'image',images=images,videoUrl=url(video.get('url')) or url(stream.get('master_url') or stream.get('masterUrl')),metrics=dict(likes=count(metrics.get('liked_count',metrics.get('likedCount',metrics.get('likes')))),collects=count(metrics.get('collected_count',metrics.get('collectedCount'))),comments=count(metrics.get('comment_count',metrics.get('commentCount',metrics.get('comments_count')))),shares=count(metrics.get('share_count',metrics.get('shareCount',metrics.get('shared_count'))))))
        comment_id=text(o.get('comment_id') or o.get('commentId') or (o.get('id') if o.get('user_info') and o.get('content') and (o.get('note_id') or context.get('noteId')) else ''))
        body=text(o.get('content') or o.get('comment_content') or o.get('commentContent') or o.get('text')); user=o.get('user_info') or o.get('userInfo') or o.get('author') or o.get('user')
        note=text(o.get('note_id') or o.get('noteId') or o.get('note',{}).get('id') or context.get('noteId'))
        if comment_id and note and body and isinstance(user,dict):comments[comment_id]=dict(id=comment_id,accountId=account_id,noteId=note,author=text(user.get('nickname') or user.get('nick_name') or user.get('name')) or '未提供昵称',avatar=media(user.get('image') or user.get('avatar')) or '',body=body,createdAt=date(o.get('create_time') or o.get('createTime') or o.get('time')),status='pending',tags=[])
        message_id=text(o.get('message_id') or o.get('messageId') or o.get('msg_id') or o.get('msgId')); conversation=text(o.get('conversation_id') or o.get('conversationId') or o.get('chat_id') or o.get('chatId') or o.get('session_id'))
        sender=o.get('sender') or o.get('from_user') or o.get('user') or o.get('author'); message_body=text(o.get('content') or o.get('message') or o.get('text'))
        if message_id and conversation and message_body and isinstance(sender,dict):messages[message_id]=dict(id=message_id,accountId=account_id,conversationId=conversation,author=text(sender.get('nickname') or sender.get('nick_name') or sender.get('name')) or '未提供昵称',body=message_body,createdAt=date(o.get('create_time') or o.get('createTime') or o.get('time')),direction='outgoing' if o.get('is_self',o.get('direction')=='outgoing' or o.get('send_type')=='1') else 'incoming')
        for value in o.values():walk(value,depth+1)
    walk(input)
    return dict(notes=list(notes.values()),comments=list(comments.values()),messages=list(messages.values()),followers=followers)
