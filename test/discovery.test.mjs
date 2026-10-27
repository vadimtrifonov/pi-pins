import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CURRENT_SESSION_VERSION,SessionManager} from '@earendil-works/pi-coding-agent';
import {containsPinState,listSavedPins,savedPins} from '../src/sessions.ts';
import {PIN_STATE,pinnedSources,snapshot} from '../src/state.ts';

const header=id=>({type:'session',version:CURRENT_SESSION_VERSION,id,timestamp:'2026-10-20T00:00:00.000Z',cwd:'/project'});
const answer=(id,text,parentId)=>({type:'message',id,parentId,timestamp:'2026-10-20T00:00:01.000Z',message:{role:'assistant',content:[{type:'text',text}]}});
const pin=(id,parentId,...ids)=>({type:'custom',id,parentId,timestamp:'2026-10-20T00:00:02.000Z',customType:PIN_STATE,data:snapshot(ids)});
const named=(id,parentId,name)=>({type:'session_info',id,parentId,timestamp:'2026-10-20T00:00:03.000Z',name});
const jsonl=entries=>entries.map(entry=>typeof entry==='string'?entry:JSON.stringify(entry)).join('\n')+'\n';
const pinned=(id,text,name)=>jsonl([header(id),answer('a',text,null),pin('p','a','a'),...name?[named('n','p',name)]:[]]);
const legacy=readFileSync(new URL('./fixtures/legacy-pins.jsonl',import.meta.url),'utf8');
const legacyTexts=['# Migration plan\n\nKeep reads stable.','# Other path\n\nUse a snapshot.'];
function scratch(t){const dir=mkdtempSync(join(tmpdir(),'pi-pins-discovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function* chunkings(bytes){
 for(let at=0;at<=bytes.length;at++)yield [bytes.subarray(0,at),bytes.subarray(at)];
 yield [...bytes].map(byte=>Buffer.from([byte]));
}

test('the prefilter finds a pin snapshot member across every chunk seam but not text that mentions it',async()=>{
 const compact=pinned('s','Reference');
 const cases=[
  [compact,true],
  [jsonl([header('s'),answer('a','Write {"customType":"pins-review-state"} into the entry.',null)]),false],
  [jsonl([header('s'),{type:'custom',id:'c',parentId:null,customType:'pins-review-state-v2',data:{kind:'customType',value:PIN_STATE}}]),false],
 ];
 for(const [content,expected] of cases)for(const chunks of chunkings(Buffer.from(content)))
  assert.equal(await containsPinState(chunks),expected,`${JSON.stringify(content.slice(0,160))} split ${chunks.map(c=>c.length)}`);
});

test('saved parsing matches Pi on irregular and migrated histories, and rejects unknown snapshots and cycles',t=>{
 // Raw U+2028/U+2029 in message text occurs in real sessions; only "\n" ends a JSONL line.
 const separated='Replacement\u2028line separator\u2029paragraph separator';
 const cases=[
  [jsonl([
   header('irregular'),answer('e1','Root',null),named('n1','e1','Earlier name'),answer('e2','First text','n1'),
   '{"type":"message","id":"broken",',
   answer('e2',separated,'n1'),pin('p','e2','e2'),named('n2','p','  Trimmed name  '),
  ]),[separated],'Trimmed name'],
  [jsonl([header('gap'),answer('e1','Before the gap',null),answer('e2','After the gap','gone'),pin('p','e2','e1','e2'),named('n','p','   ')]),['After the gap'],undefined],
  [legacy,legacyTexts,undefined],
  [legacy.replace('"version":3','"version":2'),legacyTexts,undefined],
  [legacy+'{unparseable session line',legacyTexts,undefined],
 ];
 const dir=scratch(t);
 for(const [content,texts,name] of cases){
  const path=join(dir,'session.jsonl');writeFileSync(path,content);
  const manager=SessionManager.open(path),group=savedPins(content);
  assert.deepEqual(group,{id:manager.getSessionId(),name:manager.getSessionName(),current:false,pins:pinnedSources(manager.getBranch())});
  assert.deepEqual(group.pins.map(pin=>pin.text),texts);assert.equal(group.name,name);
 }
 const entries=legacy.trim().split('\n').map(line=>JSON.parse(line)),content=()=>entries.map(entry=>JSON.stringify(entry)).join('\n');
 entries.findLast(entry=>entry.type==='custom'&&entry.customType===PIN_STATE).data={version:99,ids:[]};
 assert.throws(()=>savedPins(content()),/Invalid pin snapshot/);
 const tip=entries.at(-1);tip.parentId=tip.id;
 assert.throws(()=>savedPins(content()),/Cyclic/);
});

test('discovery scans the default root and current directory newest first, isolates failures, writes nothing, and stops when aborted',async t=>{
 const dir=scratch(t),agent=join(dir,'agent'),project=join(agent,'sessions','--project--'),other=join(agent,'sessions','--other--'),custom=join(dir,'custom');
 for(const path of [project,other,custom])mkdirSync(path,{recursive:true});
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agent;
 t.after(()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;});
 const cyclic=id=>jsonl([header(id),answer('a','Loop','p'),pin('p','a','a')]);
 const files={
  [join(project,'newer.jsonl')]:[pinned('shared','Newer copy'),5],
  [join(other,'older.jsonl')]:[pinned('shared','Older copy'),1],          // Same session ID: the newest file wins.
  // Version 2 without a final newline: SessionManager.open() would rewrite both.
  [join(custom,'custom.jsonl')]:[pinned('custom','Custom answer',' Custom ').replace(`"version":${CURRENT_SESSION_VERSION}`,'"version":2').trimEnd(),4],
  [join(custom,'current.jsonl')]:[cyclic('current'),6],                   // Current file: never read.
  [join(other,'current-copy.jsonl')]:[pinned('current','Current copy'),3],// Current owner in another file.
  [join(project,'cyclic.jsonl')]:[cyclic('cyclic'),2],                    // Unreadable: one warning, others survive.
  [join(project,'mention.jsonl')]:['{"type":"message"}\n'+jsonl([answer('a','"customType":"pins-review-state"',null)]),7],
  [join(project,'plain.jsonl')]:[jsonl([header('plain'),answer('a','No pins',null)]),8],
 };
 for(const [path,[content,age]] of Object.entries(files)){writeFileSync(path,content);utimesSync(path,1_800_000_000+age,1_800_000_000+age);}
 const notices=[],ctx={sessionManager:{getSessionDir:()=>custom,getSessionId:()=> 'current',getSessionFile:()=>join(custom,'current.jsonl')},ui:{notify:(...args)=>notices.push(args)}};
 const groups=await listSavedPins(ctx,new AbortController().signal);
 assert.deepEqual(groups.map(group=>[group.id,group.name,group.current,group.pins.map(pin=>pin.text)]),
  [['shared',undefined,false,['Newer copy']],['custom','Custom',false,['Custom answer']]]);
 assert.deepEqual(notices,[['Could not read pins from 1 saved session.','warning']]);
 for(const [path,[content]] of Object.entries(files))assert.equal(readFileSync(path,'utf8'),content);
 const aborted=new AbortController();aborted.abort();
 await assert.rejects(()=>listSavedPins(ctx,aborted.signal),{name:'AbortError'});
 await assert.rejects(()=>listSavedPins({sessionManager:{getSessionFile(){assert.fail('A pre-aborted scan must not start discovery');}}},aborted.signal),{name:'AbortError'});
 // Cancel after the last successful read (older.jsonl): no late warning.
 const late=new AbortController(),readFile=fsp.readFile;
 fsp.readFile=async(path,...rest)=>{const content=await readFile(path,...rest);if(path.endsWith('older.jsonl'))late.abort();return content;};
 syncBuiltinESMExports();
 try{await assert.rejects(()=>listSavedPins(ctx,late.signal),{name:'AbortError'});}
 finally{fsp.readFile=readFile;syncBuiltinESMExports();}
 assert.equal(late.signal.aborted,true);assert.equal(notices.length,1);
});
