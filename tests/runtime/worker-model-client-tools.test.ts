import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveContainerRunnerProvider} from '@luna/executor/providers';
import {codexPtyAdapter} from '@luna/executor/pty/codex-pty-adapter';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test('Worker client-tools mode removes native web search for new/resumed stdio and PTY Codex runs',async()=>{
 const provider=resolveContainerRunnerProvider('codex');const root=mkdtempSync(join(tmpdir(),'luna-client-tools-'));roots.push(root);
 const gateway={CODEX_PROVIDER_MODE:'gateway',OPENAI_BASE_URL:'http://gateway.test/v1',OPENAI_API_KEY:'private-key'};
 for(const mode of [undefined,'disabled'])for(const session of [undefined,'session']){
  const env={...gateway,...(mode?{CODEX_WEB_SEARCH_MODE:mode}:{})};
  const args=provider.buildCliArgs({runnerType:'codex',prompt:'hello',model:'deepseek-v4.1-flash',env},session);
  const pty=await codexPtyAdapter.prepareSpawn({runnerType:'codex',cwd:root,home:root,baseEnv:env,controlDir:root,turnEnvFile:join(root,'turn.json'),...(session?{resumeSessionId:session}:{})});
  for(const argv of [args,pty.args]){expect(argv.includes('web_search="disabled"')).toBe(mode==='disabled');expect(argv.join(' ')).not.toContain('private-key');}
 }
});
