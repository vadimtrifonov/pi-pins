import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {findOrigin} from '../src/sessions.ts';

function scratch(t){const dir=mkdtempSync(join(tmpdir(),'pins-origin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
const write=(sm,text)=>sm.appendMessage({role:'user',content:text,timestamp:Date.now()});

test('the origin follows forks back to the session where the message was written',async t=>{
 const dir=scratch(t);
 const original=SessionManager.create(dir,dir);original.appendSessionInfo('Original');
 const first=write(original,'Written in the original');
 await sleep(2); // Copied messages are older than their fork; a fork in the same millisecond is not told apart.
 const child=SessionManager.open(original.getSessionFile(),dir);child.createBranchedSession(first);
 child.appendSessionInfo('Fork');const second=write(child,'Written in the fork');
 await sleep(2);
 const grandchild=SessionManager.forkFrom(child.getSessionFile(),dir,dir);const third=write(grandchild,'Written in the second fork');
 const origin=id=>findOrigin(grandchild.getHeader(),'Current',grandchild.getEntry(id).timestamp);
 assert.deepEqual(await origin(first),{id:original.getSessionId(),name:'Original'});
 assert.deepEqual(await origin(second),{id:child.getSessionId(),name:'Fork'});
 assert.deepEqual(await origin(third),{id:grandchild.getSessionId(),name:'Current'});
 rmSync(original.getSessionFile());
 assert.deepEqual(await origin(first),{id:child.getSessionId(),name:'Fork'},'A deleted parent names the earliest readable session');
});

test('the name comes from the last session_info line, including lines across read chunks and a cleared name',async t=>{
 const dir=scratch(t),MiB=1024*1024,path=join(dir,'parent.jsonl');
 const header=JSON.stringify({type:'session',version:3,id:'parent',timestamp:'2026-10-21T00:00:00.000Z',cwd:'/'});
 const info=name=>JSON.stringify({type:'session_info',id:'n',parentId:'m',timestamp:'2026-10-21T00:00:02.000Z',name});
 const message=content=>JSON.stringify({type:'message',id:'m',parentId:null,timestamp:'2026-10-21T00:00:01.000Z',message:{role:'user',content}});
 const child={type:'session',version:3,id:'child',timestamp:'2026-10-21T00:00:05.000Z',cwd:'/',parentSession:path};
 const name=async content=>{writeFileSync(path,content);return (await findOrigin(child,'Child','2026-10-21T00:00:01.000Z')).name;};
 // The final line starts `shift` bytes after the first 1 MiB chunk ends; its marker includes the preceding newline.
 for(const shift of [-200,-60,-22,-21,-10,0,1,40]){
  const lead=`${header}\n${info('Early')}\n`,pad=MiB+shift-lead.length-message('').length-1;
  assert.equal(await name(`${lead}${message('x'.repeat(pad))}\n${info('Final')}\n`),'Final',`shift ${shift}`);
 }
 assert.equal(await name(`${header}\n${info('Early')}\n${message('Text that mentions {"type":"session_info"}')}\n${info('Last')}`),'Last','A final line without a newline counts');
 assert.equal(await name(`${header}\n${info('Early')}\n${info('  ')}\n`),undefined,'An empty name clears the earlier one');
});
