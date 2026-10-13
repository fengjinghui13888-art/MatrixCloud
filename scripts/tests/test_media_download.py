import importlib.util, pathlib, tempfile, unittest
from unittest.mock import patch
SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'xhs_media_download.py'

class MediaDownloadTests(unittest.TestCase):
 def load(self):
  self.assertTrue(SCRIPT.exists(), 'media download worker must exist')
  spec=importlib.util.spec_from_file_location('media_worker',SCRIPT);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def test_account_path_is_portable_and_cannot_escape(self):
  m=self.load()
  with tempfile.TemporaryDirectory() as root:
   p=m.destination(pathlib.Path(root),'xhs:123','2025-02-03','image','note/../../id','abc','.jpg')
   self.assertTrue(p.is_relative_to(pathlib.Path(root)))
   self.assertEqual(p.parts[-5:-2],('xhs%3A123','2025-02-03','image'))
   self.assertNotIn('..',p.parts)
 def test_rejects_non_media_and_does_not_leave_partial_file(self):
  m=self.load()
  class Response:
   headers={'Content-Type':'text/html'};status_code=200
   def raise_for_status(self):pass
   def close(self):pass
  with tempfile.TemporaryDirectory() as root, patch.object(m.requests.Session,'get',return_value=Response()):
   r=m.download_one({'root':root,'accountId':'a'}, {'noteId':'n','date':'2025-02-03','kind':'image','url':'https://sns.xhscdn.com/test','index':0})
   self.assertEqual(r['status'],'failed');self.assertFalse(list(pathlib.Path(root).rglob('*.jpg')))
 def test_rejects_untrusted_media_host(self):
  m=self.load()
  with self.assertRaises(ValueError):m.validate_url('http://127.0.0.1/private')
 def test_valid_image_is_saved_atomically_and_reused(self):
  m=self.load()
  class Response:
   headers={'Content-Type':'image/png'};status_code=200
   def raise_for_status(self):pass
   def close(self):pass
   def iter_content(self,chunk_size):yield b'\x89PNG\r\n\x1a\n'+b'fixture'
  with tempfile.TemporaryDirectory() as root, patch.object(m.requests.Session,'get',return_value=Response()) as get:
   config={'root':root,'accountId':'a'};item={'noteId':'n','date':'2025-02-03','kind':'image','url':'https://sns.xhscdn.com/test','index':0}
   one=m.download_one(config,item);two=m.download_one(config,item)
   self.assertEqual(one['status'],'saved');self.assertEqual(two['status'],'cached');self.assertEqual(get.call_count,1)
   self.assertTrue((pathlib.Path(root)/one['asset']['path']).is_file())
 def test_rotating_signed_url_reuses_the_same_saved_asset(self):
  m=self.load()
  class Response:
   headers={'Content-Type':'image/png'};status_code=200
   def raise_for_status(self):pass
   def close(self):pass
   def iter_content(self,chunk_size):yield b'\x89PNG\r\n\x1a\n'+b'fixture'
  with tempfile.TemporaryDirectory() as root, patch.object(m.requests.Session,'get',return_value=Response()) as get:
   config={'root':root,'accountId':'a'};item={'noteId':'n','date':'2025-02-03','kind':'image','url':'https://sns-webpic-qc.xhscdn.com/20260101/oldhash/file!webp?sign=old&t=1','index':0}
   first=m.download_one(config,item)
   item['url']='https://sns-webpic-qc.xhscdn.com/20260102/newhash/file!webp?sign=new&t=2'
   second=m.download_one(config,item)
   self.assertEqual(second['status'],'cached');self.assertEqual(first['asset']['id'],second['asset']['id']);self.assertEqual(get.call_count,1)
   self.assertEqual(second['asset']['sourceUrl'],item['url'])
if __name__=='__main__':unittest.main()
