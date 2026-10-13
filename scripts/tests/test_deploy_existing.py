import importlib.util,pathlib,sys,tempfile,unittest,io
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
spec=importlib.util.spec_from_file_location('deploy_existing',pathlib.Path(__file__).resolve().parents[1]/'deploy-existing.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DeployTests(unittest.TestCase):
 def test_cloud_server_health_does_not_require_an_online_developer_desktop(self):
  config={'Env':['CUSTOMER_PUBLIC_ORIGIN=https://example.test','LOCAL_CONNECTOR_URL=http://127.0.0.1:47822','LOCAL_CONNECTOR_TOKEN=fixture']}
  with patch.object(module.urllib.request,'urlopen',return_value=io.BytesIO(b'{"ok":true,"storage":"postgresql","schema":2}')) as get:
   self.assertTrue(module.healthy(config));self.assertEqual(get.call_count,1)
 def test_legacy_installation_still_checks_its_required_connector(self):
  config={'Env':['LOCAL_CONNECTOR_URL=http://127.0.0.1:47822','LOCAL_CONNECTOR_TOKEN=fixture']}
  with patch.object(module.urllib.request,'urlopen',side_effect=[io.BytesIO(b'{"ok":true,"storage":"sqlite"}'),OSError('desktop offline')]):
   self.assertFalse(module.healthy(config))
 def fixture(self,root):
  data=root/'data';data.mkdir();(data/'access-token').write_text('private-fixture')
  return {'Config':{'Image':'old','Env':['LOCAL_CONNECTOR_URL=http://127.0.0.1:47822','LOCAL_CONNECTOR_TOKEN=private-fixture','PUBLIC_ORIGIN=https://example.test'],'Cmd':['node','server.js']},'HostConfig':{'NetworkMode':'host','Binds':[str(data)+':/app/work/grey'],'RestartPolicy':{'Name':'unless-stopped'},'Memory':1234},'Mounts':[{'Source':str(data),'Destination':'/app/work/grey','RW':True,'Type':'bind'}]}
 def test_preserves_runtime_fields_and_caps_json_logs(self):
  with tempfile.TemporaryDirectory() as d:
   old=self.fixture(pathlib.Path(d));payload,data=module.replacement(old,'new');self.assertEqual({k:v for k,v in payload['HostConfig'].items() if k!='LogConfig'},old['HostConfig']);self.assertEqual(payload['HostConfig']['LogConfig']['Config'],{'max-size':'20m','max-file':'3'});self.assertEqual(payload['Env'],old['Config']['Env']);self.assertEqual(old['Config']['Image'],'old');self.assertEqual(payload['Image'],'new')
 def test_failure_restores_old_container_without_overwriting_data(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);old=self.fixture(root);calls=[]
   class FakeDocker:
    def inspect(self,n):return old
    def command(self,*args):calls.append(args)
    def create(self,n,payload):calls.append(('create',n))
   with patch.object(module.time,'sleep'),self.assertRaisesRegex(RuntimeError,'健康'):
    module.deploy(FakeDocker(),'matrix-cloud','new',root/'backup',check=lambda _:False)
   self.assertIn(('rm','--force','matrix-cloud'),calls);self.assertEqual(calls[-1],('start','matrix-cloud'));self.assertEqual((root/'data/access-token').read_text(),'private-fixture');module.verify(root/'backup')
 def test_existing_backup_rejected_before_downtime(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);old=self.fixture(root);dest=root/'backup';dest.mkdir();calls=[]
   class FakeDocker:
    def inspect(self,n):return old
    def command(self,*args):calls.append(args)
   with self.assertRaises(ValueError):module.deploy(FakeDocker(),'matrix-cloud','new',dest)
   self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
