import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {pinsPath,readPins,updatePins,watchPins} from '../src/store.ts';

function agentDir(t){
 const dir=mkdtempSync(join(tmpdir(),'pins-store-')),previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 t.after(()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;rmSync(dir,{recursive:true,force:true});});
}
const pin=id=>({entry:{type:'message',id,parentId:null,timestamp:'2026-10-21T00:00:00Z',message:{role:'user',content:`Message ${id}`}},origin:{id:'session'}});
const ids=pins=>pins.map(pin=>pin.entry.id);
const leftovers=()=>readdirSync(dirname(pinsPath())).filter(name=>name!=='pins.json');
async function until(condition,ms=3000){for(const end=Date.now()+ms;!condition();){if(Date.now()>end)return false;await sleep(10);}return true;}

test('a missing file has no pins, an unchanged update writes nothing, and a change leaves no temporary files',async t=>{
 agentDir(t);
 assert.deepEqual(await readPins(),[]);
 assert.deepEqual(await updatePins(pins=>pins),[]);assert(!existsSync(pinsPath()));
 assert.deepEqual(ids(await updatePins(pins=>[...pins,pin('a')])),['a']);
 assert.deepEqual(ids(await readPins()),['a']);assert.deepEqual(leftovers(),[]);
});

test('an unsupported file is reported and never overwritten',async t=>{
 agentDir(t);mkdirSync(dirname(pinsPath()),{recursive:true});
 for(const content of ['{"version":2,"pins":[]}','{"version":1}','{"version":1,"pins":[',' ']){
  writeFileSync(pinsPath(),content);
  await assert.rejects(readPins(),/Unsupported pins file/);
  await assert.rejects(updatePins(pins=>[...pins,pin('a')]),/Unsupported pins file/);
  assert.equal(readFileSync(pinsPath(),'utf8'),content);
 }
});

test('concurrent updates from several processes all land',async t=>{
 agentDir(t);
 const store=JSON.stringify(new URL('../src/store.ts',import.meta.url).href);
 const script=`import {updatePins} from ${store};
  const process_=process.argv.at(-1);
  for(let i=0;i<10;i++)await updatePins(pins=>[...pins,{entry:{type:'message',id:process_+i,parentId:null,timestamp:'t',message:{role:'user',content:'x'}},origin:{id:process_}}]);`;
 const run=name=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import',new URL('./bootstrap.mjs',import.meta.url).href,'--input-type=module','-e',script,name],{stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',chunk=>error+=chunk);
  child.on('exit',code=>code===0?resolve():reject(new Error(error)));
 });
 await Promise.all(['p','q','r','s'].map(run));
 assert.equal((await readPins()).length,40);assert.deepEqual(leftovers(),[]);
});

test('a file held open by another reader is still replaced',async t=>{
 agentDir(t);await updatePins(()=>[pin('a')]);
 // Windows refuses to replace an open file; the update retries until the reader closes it.
 const reader=await open(pinsPath(),'r');setTimeout(()=>reader.close(),150);
 await updatePins(pins=>[...pins,pin('b')]);
 assert.deepEqual(ids(await readPins()),['a','b']);assert.deepEqual(leftovers(),[]);
});

test('a watcher is notified once per change, ignores the lock and temporary files, and stops when asked',async t=>{
 agentDir(t);let calls=0;const stop=watchPins(()=>calls++);t.after(stop);
 await updatePins(()=>[pin('a')]);
 assert(await until(()=>calls===1),'The change was not reported');
 await sleep(300);assert.equal(calls,1);
 stop();await updatePins(pins=>[...pins,pin('b')]);await sleep(300);assert.equal(calls,1);
});
