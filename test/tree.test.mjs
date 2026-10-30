import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme,TreeSelectorComponent} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import {createTree,treeNodes,pinLabel} from '../src/tree.ts';
import {createBrowser,readingMemory,pinItems} from '../src/browser.ts';
import {sourcesOnBranch} from '../src/state.ts';
import {nativeFixture} from './native-fixtures.mjs';
initTheme('dark',false);const keys=getKeybindings(),theme={fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s};
function large(){
 const entries=Array.from({length:2400},(_,i)=>({id:`e${i}`,parentId:i?`e${i-1}`:null,type:'message',timestamp:'2026-10-21T00:00:00Z',message:{role:'assistant',content:[
  {type:'thinking',get thinking(){throw Error('Do not inspect thinking for the message row');}},
  {type:'image',get data(){throw Error('Do not inspect image data for the message row');}},
  {type:'text',text:`Row ${i} early text `+'reference '.repeat(250)+' LATE_TOKEN'},
 ],stopReason:'stop'}}));
 return {id:'large',pins:sourcesOnBranch(entries)};
}
test('2400-row native viewport and paging remain bounded at 1/2/10/40 rows, with exact counters and no wrap',()=>{
 const group=large(),items=pinItems(group,group.pins);
 const tree=createTree(items,'default','',items.at(-1).key);
 for(const capacity of [10,1,40,2,10]){
  const before=tree.render(75,capacity).map(clean);assert.equal(before.length,capacity+1);assert(before.some(line=>line.startsWith('› ')));
  const position=Number(before.at(-1).match(/\((\d+)\/2400\)/)[1]);
  tree.move(-1);assert.match(clean(tree.render(75,capacity).at(-1)),new RegExp(`\\(${position-capacity}/2400\\)`));
  tree.move(1);assert.match(clean(tree.render(75,capacity).at(-1)),new RegExp(`\\(${position}/2400\\)`));
  tree.move(1);assert.match(clean(tree.render(75,capacity).at(-1)),/\(2400\/2400\)/);
 }
 const source=group.pins[0];const display=treeNodes(pinItems(group,[source]))[0].entry;
 assert.equal(display.message,source.entry.message);
 assert(source.text.includes('LATE_TOKEN'));assert(!createTree(items,'default','LATE_TOKEN').selected());
});
test('incompatible TreeList internals fail explicitly before applying the query',()=>{
 const original=TreeSelectorComponent.prototype.getTreeList,group=nativeFixture().group,items=pinItems(group,group.pins);
 try{
  for(const incompatible of [{applyFilter:undefined},{selectedIndex:'0'},{getEntryDisplayText:undefined}]){
   TreeSelectorComponent.prototype.getTreeList=function(){return Object.assign(original.call(this),incompatible);};
   assert.throws(()=>createTree(items,'default','release'),/Pins: unsupported Pi TreeList internals/);
   assert.throws(()=>pinLabel(group.pins[0]),/Pins: unsupported Pi TreeList internals/);
  }
 }finally{TreeSelectorComponent.prototype.getTreeList=original;}
 assert(createTree(items,'default','release').selected());
});
test('browser left/right page by visible choices, even with Up/Down unbound; PgUp/PgDn scroll only the selected answer',()=>{
 const original=keys.getUserBindings();
 try{
  keys.setUserBindings({...original,'tui.select.up':[],'tui.select.down':[]});
  const group=large(),messages=group.pins.slice(0,2000),memory=readingMemory();
  const tui={terminal:{columns:40,rows:18},requestRender(){}};
  const c=createBrowser({tui,theme,keys,view:{session:{...group,pins:messages.slice(0,3)},messages,all:[]},memory,scope:'current',initial:'e1999@2026-10-21T00:00:00Z',signal:new AbortController().signal,done(){}});
  c.focused=true;
  const render=()=>c.render(40).map(clean),counter=()=>render().find(line=>/\(\d+\/2000\)/.test(line));
  const capacity=render().filter(line=>line.startsWith('› ')||line.startsWith('  assistant:')).length;
  assert(capacity>=2);assert.match(counter(),/\(2000\/2000\)/);c.handleInput('\x1b[D');assert.match(counter(),new RegExp(`\\(${2000-capacity}/2000\\)`));
  const selected=memory.selected.get('current');c.handleInput('\x1b[6~');assert.equal(memory.selected.get('current'),selected);assert(!render().at(-1).includes('lines 1–'));
  c.handleInput('\x1b[C');assert.match(counter(),/\(2000\/2000\)/);c.handleInput('\x1b[C');assert.match(counter(),/\(2000\/2000\)/);c.dispose();
 }finally{keys.setUserBindings(original);}
});
