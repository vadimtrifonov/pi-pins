import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import {createBrowser,readingMemory} from '../src/browser.ts';
import {savedPins} from '../src/sessions.ts';
import {PIN_STATE,snapshot} from '../src/state.ts';
import {freeze} from './native-fixtures.mjs';
initTheme('dark',false);
const keys=getKeybindings(),theme={fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s};
const up='\x1b[A',esc='\x1b';
function group(id,rows,ids){
 const entries=rows.map(([id,time],i)=>({type:'message',id,parentId:rows[i-1]?.[0]??null,timestamp:time,
  message:{role:'assistant',content:[{type:'text',text:`# Note ${id}\n\nOriginal message ${id}.`}],stopReason:'stop'}}));
 return savedPins([{type:'session',version:3,id,cwd:'/fixture',timestamp:'2026-10-21T00:00:00Z'},...entries,
  {type:'custom',id:'pins',parentId:entries.at(-1).id,timestamp:'2026-10-22T00:00:00Z',customType:PIN_STATE,data:snapshot(ids)}].map(entry=>JSON.stringify(entry)).join('\n'));
}
function fixture(){
 const time=hour=>`2026-10-21T${hour}:00:00Z`;
 const current={...group('session-c',[['c0',time(10)],['shared',time(12)],['c2',time(14)]],['c0','shared','c2']),current:true};
 const other=group('session-a',[['old',time('09')],['shared',time(11)],['new',time(15)]],['new','old','shared']);
 const fork={...other,id:'session-b',pins:[other.pins.find(pin=>pin.id==='shared')]};
 const groups=[current,other,fork];freeze(groups);
 return {groups,current,other,fork,order:['session-a:old','session-c:c0','session-a:shared','session-b:shared','session-c:shared','session-c:c2','session-a:new']};
}
function browser(f,extra={}){
 const memory=extra.memory??readingMemory();
 const c=createBrowser({tui:{terminal:{columns:75,rows:32},requestRender(){}},theme,keys,groups:f.groups,messages:f.current.pins,
  scope:'all',memory,signal:new AbortController().signal,done(){},...extra});
 c.focused=true;
 const screen=()=>c.render(75).map(clean).join('\n'),key=(...values)=>{for(const value of values){c.handleInput(value);screen();}};
 const selected=(expected,scope='all')=>{assert.equal(memory.selected.get(scope),expected);if(scope==='all')assert(screen().includes(`Session ID: ${expected.split(':')[0]}`));};
 screen();return {c,memory,screen,key,selected};
}

test('All orders messages across sessions, starts at newest after discovery, and remembers selection on return and reopen',async()=>{
 for(const background of [false,true]){
  const f=fixture(),before=JSON.stringify(f.groups);let resolve;
  const b=browser(f,{groups:[f.current],scope:'current',initial:'session-c:c0',loadSaved:()=>new Promise(r=>resolve=r)});
  b.selected('session-c:c0','current');b.key('\t');await settle();assert(b.screen().includes('Loading saved pins'));
  if(background)b.key('\t');
  resolve([f.fork,f.other]);await settle(); // Reverse arrival must not decide equal-time fork copies.
  if(background){b.selected('session-c:c0','current');b.key('\t');}
  b.selected(f.order.at(-1));assert(b.screen().includes('(7/7)'));
  b.key('\r');
  for(let i=f.order.length-1;i>=0;i--){b.selected(f.order[i]);if(i)b.key(up);}
  const boundary=b.screen();b.key(up);assert.equal(b.screen(),boundary);
  b.key(esc,'\t');b.selected('session-c:c0','current');b.key('\t');b.selected(f.order[0]);
  b.key(esc);b.c.dispose();
  const reopened=browser(f,{groups:[f.current],scope:'current',memory:b.memory,loadSaved:async()=>[f.fork,f.other]});
  reopened.key('\t');await settle();reopened.selected(f.order[0]);
  reopened.c.dispose();
  assert.equal(JSON.stringify(f.groups),before,'Ordering and navigation must not alter original groups or entries');
 }
});

test('All unpin navigation and repinning follow chronological positions across sessions, including the row revealed by Escape',async()=>{
 const original=keys.getUserBindings();
 try{
  keys.setUserBindings({...original,'tui.select.up':'k','tui.select.down':'j'}); // Fully remapped selection keys.
  for(const [direction,expected] of [['k','session-a:old'],['j','session-a:shared'],[undefined,'session-c:c0']]){
   const f=fixture();let current=f.current,toggles=0;
   const view=browser(f,{initial:'session-c:c0',togglePin:async item=>{
    toggles++;const retained=current.pins.some(pin=>pin.id===item.source.id);
    return current={...current,pins:retained?current.pins.filter(pin=>pin.id!==item.source.id):[...current.pins,item.source]};
   }});
   view.key('\r','p');await settle();assert(view.screen().includes('p pin · c copy'));
   if(direction)view.key(direction);else{view.key('p');await settle();}
   view.selected(expected);view.key(esc);view.selected(expected);
   assert.match(view.screen(),direction==='k'?/\(1\/6\)/:/\(2\/\d\)/);
   if(!direction){assert.equal(toggles,2);assert.deepEqual(current.pins.map(pin=>pin.id),['shared','c2','c0']);}
   view.c.dispose();
  }
 }finally{keys.setUserBindings(original);}
});
