import { publicHttpsJson } from '../model-gateway';

test.each(['http://api.example.com/v1','https://127.0.0.1/','https://169.254.169.254/','https://[::1]/','https://localhost/','https://a.localhost/','https://user:password@api.example.com/','https://api.example.com/?key=secret'])('refuses unsafe model destination %s before sending credentials',async(url)=>{
  await expect(publicHttpsJson(url,{Authorization:'Bearer fixture-only'},{})).rejects.toThrow();
});
