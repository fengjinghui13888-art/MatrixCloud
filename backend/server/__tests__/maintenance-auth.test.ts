// @vitest-environment node
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {MaintenanceAuth,passwordHash} from '../maintenance-auth';
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const path=mkdtempSync(join(tmpdir(),'matrix-oauth-'));roots.push(path);const client:any={client_id:'codex',redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']};const provider=new MaintenanceAuth({root:path,resource:'https://matrix.example/maintenance/mcp',adminHash:passwordHash('owner-password-123'),clients:[client]});return {provider,client};}
it('requires the administrator, PKCE and exact resource, then revokes the whole grant',async()=>{
 const {provider,client}=fixture();const verifier='v'.repeat(48),challenge=createHash('sha256').update(verifier).digest('base64url');
 const pending=provider.begin(client,{codeChallenge:challenge,redirectUri:client.redirect_uris[0],scopes:['maintenance:read'],resource:new URL('https://matrix.example/maintenance/mcp')});
 expect(()=>provider.consent(pending.id,'wrong')).toThrow(/验证失败/);
 const next=new URL(provider.consent(pending.id,'owner-password-123'));const code=next.searchParams.get('code')!;
 await expect(provider.exchangeAuthorizationCode(client,code,'bad',client.redirect_uris[0],new URL('https://matrix.example/maintenance/mcp'))).rejects.toThrow();
 const tokens=await provider.exchangeAuthorizationCode(client,code,verifier,client.redirect_uris[0],new URL('https://matrix.example/maintenance/mcp'));
 expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(['maintenance:read']);
 await expect(provider.exchangeRefreshToken(client,tokens.refresh_token!,['maintenance:write'],new URL('https://matrix.example/maintenance/mcp'))).rejects.toThrow();
 await provider.revokeToken(client,{token:tokens.refresh_token!});
 await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
});
it('refuses arbitrary redirect, unknown client and elevated scopes',()=>{
 const {provider,client}=fixture();
 for(const patch of [{redirectUri:'https://evil.invalid/callback'},{scopes:['root']},{resource:new URL('https://other.invalid/mcp')}])expect(()=>provider.begin(client,{codeChallenge:'x'.repeat(43),redirectUri:client.redirect_uris[0],scopes:['maintenance:read'],resource:new URL('https://matrix.example/maintenance/mcp'),...patch})).toThrow();
});
it('removes expired public authorization forms without deleting live credentials',()=>{
 const {provider,client}=fixture();
 provider.state.put('pending','expired',{expires:Date.now()-1});
 provider.state.put('approval-form','expired',{expires:Date.now()-1});
 provider.state.put('refresh','live',{expires:Date.now()+60000});
 provider.begin(client,{codeChallenge:'x'.repeat(43),redirectUri:client.redirect_uris[0],resource:new URL('https://matrix.example/maintenance/mcp')});
 expect(provider.state.get('pending','expired')).toBeUndefined();
 expect(provider.state.list('approval-form')).toHaveLength(0);
 expect(provider.state.get('refresh','live')).toBeDefined();
});
