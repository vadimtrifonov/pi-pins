import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {getKeybindings,truncateToWidth,visibleWidth} from '@earendil-works/pi-tui';
import {createBrowser,readingMemory} from '../src/browser.ts';
import {identity,sourceFromEntry} from '../src/state.ts';
import {pinLabel} from '../src/tree.ts';
import {nativeFixture} from './native-fixtures.mjs';
const themes=await import(new URL('./modes/interactive/theme/theme.js',import.meta.resolve('@earendil-works/pi-coding-agent')));
const incoming=sourceFromEntry({id:'incoming',parentId:null,timestamp:'2026-10-21T13:00:00Z',type:'message',message:{role:'assistant',content:[{type:'text',text:'## Incoming answer — a deliberately long identifying snippet that must remain on a single line even at forty columns\n\nOriginal full answer.'}],stopReason:'stop'}});
function setup(){
 const f=nativeFixture(),tui={terminal:{columns:75,rows:32},requestRender(){}},controller=new AbortController();let result,closed=false;
 const c=createBrowser({tui,theme:themes.theme,keys:getKeybindings(),view:{session:f.group,messages:f.group.pins,all:[]},memory:readingMemory(),signal:controller.signal,scope:'current',replacementFor:incoming,initial:identity(f.group.pins[0].entry),done:action=>{result=action;closed=true;}});
 c.focused=true;
 const lines=()=>c.render(tui.terminal.columns),plain=()=>lines().map(clean),key=data=>{c.handleInput(data);return plain();};
 return {c,tui,f,controller,lines,plain,key,result:()=>result,closed:()=>closed};
}
test('replacement uses one accent heading, muted controls, native pin rows and the same closing range in list and reader',()=>{
 initTheme('dark',false);const b=setup(),theme=themes.theme;
 for(const [columns,rows] of [[75,32],[40,18]]){
  Object.assign(b.tui.terminal,{columns,rows});
  for(const reading of [false,true]){
   if(reading)b.key('\r');
   const raw=b.lines(),plain=raw.map(clean),title=clean(truncateToWidth(`Replace with: ${pinLabel(incoming)}`,columns-2,'…'));
   assert.equal(plain[0].trim(),title);assert(raw[0].includes(theme.fg('accent',theme.bold(title))));
   assert.equal(raw.length,rows-2);assert(raw.every(line=>visibleWidth(line)<=columns));assert(!plain.some(line=>line.includes('More room')));
   const rule=plain.findIndex(line=>/^─+$/.test(line));assert(rule>1);
   for(const line of raw.slice(1,rule))assert(line.includes(theme.fg('muted',clean(line).trim())));
   const hints=plain.slice(1,rule).map(line=>line.trim()).join(' · ');
   assert.equal(hints,reading?'r replace · ↑/↓ previous/next · PgUp/PgDn scroll · Esc back':'r replace · ↑/↓ move · PgUp/PgDn scroll · Enter read · Esc cancel');
   assert.match(plain.at(-1),/lines \d+–\d+\/\d+/);
   if(!reading){assert(plain.some(line=>line.startsWith('› [pinned]')));assert(plain.some(line=>/\(1\/3\)/.test(line)));}
   else b.key('\x1b');
  }
 }
 b.c.dispose();
});
test('only replacement/read/navigation/cancel actions are enabled; candidate inspection never commits',()=>{
 initTheme('dark',false);const b=setup(),before=b.plain();
 for(const key of ['p','p','c','i','/','\t','\x0c','\x0f','\x10','\x04','\x14','\x15','\x01']){b.key(key);assert.deepEqual(b.plain(),before);assert(!b.closed());}
 b.key('\x1b[B');const chosen=b.plain().find(line=>line.startsWith('› '));b.key('\r');assert(!b.closed());
 b.key('\x1b[6~');assert(Number(b.plain().at(-1).match(/lines (\d+)/)[1])>1);
 b.key('\x1b');
 assert.equal(b.plain().find(line=>line.startsWith('› ')),chosen);
 b.key('r');
 assert(b.closed());
 assert.equal(b.result().kind,'replace');
 assert.equal(b.result().id,b.f.group.pins[1].id);
 b.c.dispose();
});
test('Escape, Ctrl+C and owner invalidation cancel without returning a replacement',()=>{
 for(const cancel of ['\x1b','\x03','abort']){
  initTheme('dark',false);const b=setup();b.lines();if(cancel==='abort')b.controller.abort();else b.key(cancel);
  assert(b.closed());assert.equal(b.result(),undefined);b.c.dispose();
 }
});
