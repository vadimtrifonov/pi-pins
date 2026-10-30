import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import {createBrowser,readingMemory} from '../src/browser.ts';
import {identity,sourcesOnBranch} from '../src/state.ts';
import {freeze} from './native-fixtures.mjs';
initTheme('dark',false);
const keys=getKeybindings(),theme={fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s};
const up='\x1b[A',esc='\x1b';
const time=hour=>`2026-10-21T${hour}:00:00Z`;
function group(id,rows){
 const entries=rows.map(([id,timestamp],i)=>({type:'message',id,parentId:rows[i-1]?.[0]??null,timestamp,
  message:{role:'assistant',content:[{type:'text',text:`# Note ${id}\n\nOriginal message ${id}.`}],stopReason:'stop'}}));
 return {id,pins:sourcesOnBranch(entries)};
}
// Two sessions with a different message under the same ID ("shared").
function fixture(){
 const current=group('session-c',[['c0',time(10)],['shared',time(12)],['c2',time(14)]]);
 const other=group('session-a',[['old',time('09')],['shared',time(11)],['new',time(15)]]);
 const view={session:current,messages:current.pins,all:[current,other]};freeze(view);
 const row=(session,id)=>[identity(session.pins.find(pin=>pin.id===id).entry),session.id];
 const order=[row(other,'old'),row(current,'c0'),row(other,'shared'),row(current,'shared'),row(current,'c2'),row(other,'new')];
 return {view,current,other,order};
}
function browser(f,extra={}){
 const memory=extra.memory??readingMemory();
 const c=createBrowser({tui:{terminal:{columns:75,rows:32},requestRender(){}},theme,keys,view:f.view,
  scope:'all',memory,signal:new AbortController().signal,done(){},...extra});
 c.focused=true;
 const screen=()=>c.render(75).map(clean).join('\n'),key=(...values)=>{for(const value of values){c.handleInput(value);screen();}};
 const selected=([expected,session],scope='all')=>{assert.equal(memory.selected.get(scope),expected);if(scope==='all')assert(screen().includes(`Session ID: ${session}`));};
 screen();return {c,memory,screen,key,selected};
}

test('All orders messages across sessions by time, starts at the newest, and remembers its selection on return and reopen',()=>{
 const f=fixture(),before=JSON.stringify(f.view),c0=f.order[1];
 const b=browser(f,{scope:'current',initial:c0[0]});
 b.selected(c0,'current');b.key('\t');
 b.selected(f.order.at(-1));assert(b.screen().includes('(6/6)'));
 b.key('\r');
 for(let i=f.order.length-1;i>=0;i--){b.selected(f.order[i]);if(i)b.key(up);}
 const boundary=b.screen();b.key(up);assert.equal(b.screen(),boundary);
 b.key(esc,'\t');b.selected(c0,'current');b.key('\t');b.selected(f.order[0]);
 b.key(esc);b.c.dispose();
 const reopened=browser(f,{scope:'current',memory:b.memory});
 reopened.key('\t');reopened.selected(f.order[0]);
 reopened.c.dispose();
 assert.equal(JSON.stringify(f.view),before,'Ordering and navigation must not alter the view or its entries');
});

test('All unpin navigation and repinning follow chronological positions across sessions',async()=>{
 const original=keys.getUserBindings();
 try{
  keys.setUserBindings({...original,'tui.select.up':'k','tui.select.down':'j'}); // Fully remapped selection keys.
  for(const [direction,expected,counter] of [['k',0,/\(1\/5\)/],['j',2,/\(2\/5\)/],[undefined,1,/\(2\/6\)/]]){
   const f=fixture();let current=f.current,toggles=0;
   const view=browser(f,{initial:f.order[1][0],togglePin:async item=>{
    toggles++;
    current={...current,pins:item.pinned?current.pins.filter(pin=>pin.id!==item.source.id):[...current.pins,item.source]};
    return {session:current,messages:f.current.pins,all:[current,f.other]};
   }});
   view.key('\r','p');await settle();assert(view.screen().includes('p pin · c copy'));
   if(direction)view.key(direction);else{view.key('p');await settle();}
   view.selected(f.order[expected]);view.key(esc);view.selected(f.order[expected]);
   assert.match(view.screen(),counter);
   if(!direction){assert.equal(toggles,2);assert.deepEqual(current.pins.map(pin=>pin.id),['shared','c2','c0']);}
   view.c.dispose();
  }
 }finally{keys.setUserBindings(original);}
});
