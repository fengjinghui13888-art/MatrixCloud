import importlib.util, pathlib, tempfile, sqlite3, unittest, json
from contextlib import closing
SPEC=importlib.util.spec_from_file_location('maintenance',pathlib.Path(__file__).parents[1]/'maintenance.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)
class MaintenanceTest(unittest.TestCase):
 def test_backup_restore_and_tamper_rejection(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);data=root/'data';data.mkdir()
   with closing(sqlite3.connect(data/'accounts.sqlite')) as db, db:
    db.execute('create table users(name text)');db.execute("insert into users values('existing')")
   (data/'model-encryption-key').write_bytes(b'secret-fixture')
   (data/'media').mkdir();(data/'media'/'fixture.webp').write_bytes(b'media')
   backup=root/'backup';m.backup(data,backup)
   restored=root/'restored';m.restore(backup,restored)
   with closing(sqlite3.connect(restored/'accounts.sqlite')) as db:self.assertEqual(db.execute('select name from users').fetchone()[0],'existing')
   self.assertEqual((restored/'model-encryption-key').read_bytes(),b'secret-fixture')
   with self.assertRaises(ValueError):m.restore(backup,restored)
   (backup/'data'/'media'/'fixture.webp').write_bytes(b'tampered')
   with self.assertRaises(ValueError):m.verify(backup)
 def test_orphan_audit_preserves_references_and_recent_files(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);media=root/'media';media.mkdir()
   (media/'keep.webp').write_bytes(b'keep');(media/'orphan.webp').write_bytes(b'orphan')
   with closing(sqlite3.connect(root/'operations.sqlite')) as db, db:
    db.execute('create table operations_state(id integer, payload text)')
    db.execute('insert into operations_state values(1,?)',(json.dumps({'notes':[{'mediaAssets':[{'path':'keep.webp'}]}]}),))
   report=m.audit_media(root,0)
   self.assertEqual([i['path'] for i in report],['media/orphan.webp'])
   self.assertTrue((media/'orphan.webp').exists())
if __name__=='__main__':unittest.main()
