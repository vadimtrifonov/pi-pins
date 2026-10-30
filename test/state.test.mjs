import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {addPin,identity,pinnedCopy,removePin,renameOrigin,sessionSources} from '../src/state.ts';

const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const messages=sm=>sm.getEntries().filter(entry=>entry.type==='message');

test('a message keeps its identity in every kind of fork and after compaction',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'pins-state-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const sm=SessionManager.create(dir,dir),ids=[];
 for(let i=1;i<=3;i++){
  sm.appendMessage({role:'user',content:`Question ${i}`,timestamp:Date.now()});
  ids.push(sm.appendMessage({role:'assistant',content:[{type:'text',text:`Answer ${i}`}],api:'fixture',provider:'fixture',model:'fixture',stopReason:'stop',usage,timestamp:Date.now()}));
 }
 sm.appendCompaction('Summary',ids.at(-1),1000);
 const original=messages(sm).map(identity);
 assert.equal(original.length,6,'Compaction keeps the summarized messages');
 await sleep(2);
 const branched=SessionManager.open(sm.getSessionFile(),dir);branched.createBranchedSession(ids.at(-1)); // /fork, /clone, /fork-out
 const forked=SessionManager.forkFrom(sm.getSessionFile(),dir,dir);                                     // pi --fork
 for(const copy of [branched,forked]){
  assert.deepEqual(messages(copy).map(identity),original);
  assert.notEqual(copy.getSessionId(),sm.getSessionId());
  assert(copy.getHeader().parentSession);
 }
});

test('Session rows keep branch order and place pinned messages of other branches by time',()=>{
 const entry=(id,parentId,second)=>({type:'message',id,parentId,timestamp:`2026-10-21T00:00:0${second}Z`,message:{role:'user',content:`Message ${id}`}});
 // IDs sort against the branch order, which equal timestamps must keep.
 const branch=[entry('ffffffff',null,1),entry('00000000','ffffffff',1),entry('b3','00000000',5)];
 const other=[entry('o2','ffffffff',3),entry('o1','ffffffff',3),entry('o9','ffffffff',4)];
 const pinned=new Set([other[0],other[1],branch[2]].map(identity));
 assert.deepEqual(sessionSources([...branch,...other],branch,pinned).map(source=>source.id),['ffffffff','00000000','o1','o2','b3']);
});

test('pin changes return their input when nothing changes, and an already pinned message replaces nothing',()=>{
 const pin=id=>({entry:{type:'message',id,parentId:null,timestamp:'2026-10-21T00:00:00Z',message:{role:'user',content:id}},origin:{id:'session'}});
 const pins=[pin('a'),pin('b')],ids=list=>list.map(pin=>pin.entry.id);
 assert.equal(addPin(pins,pin('a')),pins);
 assert.equal(addPin(pins,pin('a'),identity(pins[1].entry)),pins);
 assert.deepEqual(ids(addPin(pins,pin('c'),identity(pins[0].entry))),['b','c']);
 assert.equal(removePin(pins,'missing'),pins);
 assert.deepEqual(ids(removePin(pins,identity(pins[0].entry))),['b']);
 assert.equal(renameOrigin(pins,'session',undefined),pins);
 assert.equal(renameOrigin(pins,'other','Name'),pins);
 assert.deepEqual(renameOrigin(pins,'session','Name').map(pin=>pin.origin),[{id:'session',name:'Name'},{id:'session',name:'Name'}]);
});

test('a pinned copy keeps text blocks and leaves images and thinking in the session',()=>{
 const entry=message=>({type:'message',id:'m',parentId:null,timestamp:'2026-10-21T00:00:00Z',message});
 const full=entry({role:'assistant',content:[{type:'thinking',thinking:'Hidden'},{type:'text',text:'Kept'},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],stopReason:'stop'});
 assert.deepEqual(pinnedCopy(full).message,{role:'assistant',content:[{type:'text',text:'Kept'}],stopReason:'stop'});
 assert.equal(full.message.content.length,3);
 for(const unchanged of [entry({role:'user',content:'Plain'}),entry({role:'bashExecution',command:'ls',output:'a',exitCode:0,cancelled:false,truncated:false})])
  assert.equal(pinnedCopy(unchanged),unchanged);
});
