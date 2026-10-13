"""Stream verified XHS media into an account-scoped local archive.
Input/output are JSON lines over stdio; credentials never go in argv or logs.
"""
import concurrent.futures, hashlib, json, os, pathlib, re, sys, time
from urllib.parse import quote, urlparse, urljoin, parse_qsl, urlencode
import requests

EXTENSIONS={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm'}

def validate_url(value):
    u=urlparse(value)
    if u.scheme not in ('https','http') or u.username or u.password or u.port not in (None,80,443):
        raise ValueError('不支持的媒体地址')
    if not any(u.hostname and (u.hostname==h or u.hostname.endswith('.'+h)) for h in ('xhscdn.com','xiaohongshu.com')):
        raise ValueError('媒体地址不属于小红书')
    return value

def segment(value):
    if not value or len(str(value))>160: raise ValueError('无效存储编号')
    # Escape dot-only and Windows device names as well as separators and colon.
    return quote(str(value),safe='-_').replace('.', '%2E')

def destination(root,account,date,kind,note,asset,ext):
    if kind not in ('image','video','cover'):raise ValueError('无效媒体类型')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}|unknown-date',date):date='unknown-date'
    return root/segment(account)/date/kind/segment(note)/(asset+ext)

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def download_one(config,item):
    part=None;response=None;session=requests.Session()
    try:
        source=validate_url(item['url']);root=pathlib.Path(config['root']).resolve()
        u=urlparse(source)
        path=u.path
        if 'webpic' in (u.hostname or ''):path=path.rsplit('/',1)[-1]
        query=urlencode([(k,v) for k,v in parse_qsl(u.query,keep_blank_values=True) if k.lower() not in ('sign','t','expires','token')])
        identity='|'.join([item['kind'],u.hostname or '',path,query])
        asset_id=hashlib.sha256(identity.encode()).hexdigest()[:32]
        base=destination(root,config['accountId'],item['date'],item['kind'],item['noteId'],asset_id,'')
        meta=base.with_suffix('.json')
        if meta.is_file():
            asset=json.loads(meta.read_text());cached=(root/asset['path']).resolve()
            if cached.is_relative_to(root) and cached.is_file() and cached.stat().st_size==asset['bytes'] and digest(cached)==asset['sha256']:
                asset['index']=item['index'];asset['sourceUrl']=source
                return {'status':'cached','noteId':item['noteId'],'asset':asset}
        session.headers.update({'User-Agent':config.get('userAgent','Mozilla/5.0'),'Referer':'https://www.xiaohongshu.com/'})
        for c in config.get('cookies',[]):
            if c.get('domain','').lstrip('.').endswith(('xiaohongshu.com','xhscdn.com')):
                session.cookies.set(c['name'],c['value'],domain=c['domain'],path=c.get('path','/'),secure=c.get('secure',True))
        current=source
        for _ in range(5):
            response=session.get(validate_url(current),stream=True,timeout=(10,25),allow_redirects=False)
            if response.status_code in (301,302,303,307,308):
                current=urljoin(current,response.headers.get('Location',''));response.close();continue
            break
        response.raise_for_status()
        mime=response.headers.get('Content-Type','').split(';')[0].lower()
        if mime not in EXTENSIONS or (item['kind']=='video')!=mime.startswith('video/'):
            raise ValueError('响应不是预期的图片或视频：'+mime)
        dest=base.with_suffix(EXTENSIONS[mime]);dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        part=dest.with_suffix(dest.suffix+'.part');total=0;h=hashlib.sha256();start=time.monotonic()
        with part.open('wb') as f:
            os.chmod(part,0o600)
            for chunk in response.iter_content(chunk_size=256*1024):
                if not chunk:continue
                if total==0:
                    valid=(chunk.startswith((b'\xff\xd8\xff',b'\x89PNG\r\n\x1a\n',b'GIF8')) or chunk[:4]==b'RIFF') if mime.startswith('image/') else (chunk[4:8]==b'ftyp' or chunk.startswith(b'\x1aE\xdf\xa3'))
                    if not valid:raise ValueError('媒体文件头校验失败')
                total+=len(chunk)
                if total>1024*1024*1024 or time.monotonic()-start>240:raise ValueError('媒体超过本次下载大小或时间限制')
                h.update(chunk);f.write(chunk)
            if not total:raise ValueError('媒体响应为空')
            f.flush();os.fsync(f.fileno())
        part.replace(dest);part=None
        asset={'id':asset_id,'kind':item['kind'],'index':item['index'],'sourceUrl':source,'path':dest.relative_to(root).as_posix(),'bytes':total,'sha256':h.hexdigest()}
        tmp=meta.with_suffix('.json.part');tmp.write_text(json.dumps(asset),encoding='utf8');os.chmod(tmp,0o600);tmp.replace(meta)
        return {'status':'saved','noteId':item['noteId'],'asset':asset}
    except Exception as e:
        # Requests exceptions may contain signed URLs; report only their type.
        error=str(e) if isinstance(e,ValueError) else type(e).__name__
        return {'status':'failed','noteId':item.get('noteId'),'kind':item.get('kind'),'index':item.get('index'),'error':error}
    finally:
        if part and part.exists():part.unlink()
        if response is not None:response.close()
        session.close()

def main():
    config=json.load(sys.stdin)
    # Deduplicate identical tasks but preserve each asset's original image index.
    items=config.pop('items');unique={ (i['noteId'],i['kind'],i['url']):i for i in items }
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(lambda item:download_one(config,item),unique.values()):
            print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=='__main__':main()
