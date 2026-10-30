import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {getMarkdownTheme,initTheme} from '@earendil-works/pi-coding-agent';
import {getKeybindings,Markdown} from '@earendil-works/pi-tui';
import {createBrowser,readingMemory} from '../src/browser.ts';
import {panelLine} from '../src/panel.ts';
import {nativeFixture,key as keyOf} from './native-fixtures.mjs';
import {sourceFromEntry} from '../src/state.ts';
initTheme('dark',false);
const T13='2026-10-21T13:00:00Z',T14='2026-10-21T14:00:00Z';
function reader(extra={}){
 const f=nativeFixture(),tui={terminal:{columns:75,rows:32},requestRender(){}},memory=readingMemory();let action;
 const c=createBrowser({tui,theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s},keys:getKeybindings(),view:f.view,memory,scope:'current',initial:keyOf('a4'),signal:new AbortController().signal,done:value=>action=value,...extra});
 c.focused=true;
 const lines=()=>c.render(tui.terminal.columns).map(clean),text=()=>lines().join('\n'),key=(...data)=>{for(const value of data){c.handleInput(value);lines();}};
 const search=query=>{key('/','\x15');for(const char of query)key(char);key('\x1b');};
 const wheel=delta=>{c.handleMouse({type:'wheel',x:10,y:8,wheelDelta:delta});lines();};
 return {wheel,c,f,tui,memory,lines,text,key,search,action:()=>action,selected:scope=>memory.selected.get(scope??'current'),position:()=>Number(lines().at(-1).match(/lines (\d+)/)[1])};
}
const left='\x1b[D',right='\x1b[C',up='\x1b[A',down='\x1b[B',pgdn='\x1b[6~',pgup='\x1b[5~',esc='\x1b';
test('reader moves one filtered entry, opens each entry at its top, keeps wheel/page scrolling and returns to the current tree row',async()=>{
 let resolveCopy,copied;const b=reader({copy:text=>{copied=text;return new Promise(resolve=>resolveCopy=resolve);}});
 b.search('assistant');assert(b.text().includes('(5/8)'));b.key('\r',pgdn);const a4=b.position();assert(a4>1);
 const rendered=new Markdown(b.f.messages.find(source=>source.id==='a4').text,0,0,getMarkdownTheme()).render(73).map(line=>clean(panelLine(line,75)));
 const expected=rendered.slice(a4-1,a4+2);assert.equal(expected.length,3);
 assert(b.text().includes(expected.join('\n')),'The visible body must match the reported scroll range');
 const before=b.lines();b.key(left);assert.deepEqual(b.lines(),before);b.key(right);assert.deepEqual(b.lines(),before);
 b.wheel(1);assert.equal(b.position(),a4+1);b.wheel(-1);assert.equal(b.position(),a4);assert.equal(b.selected(),keyOf('a4'));
 b.key(down);assert.equal(b.lines()[0].trim(),'Pin');assert.equal(b.selected(),keyOf('a5'));assert.equal(b.position(),1);
 b.key(pgdn,pgdn);assert(b.position()>a4);b.key(up);assert.equal(b.selected(),keyOf('a4'));assert.equal(b.position(),1);
 for(const [columns,rows] of [[40,18],[75,32]]){Object.assign(b.tui.terminal,{columns,rows});assert.equal(b.lines()[0].trim(),'Pin');assert(b.text().includes('↑/↓ previous/next'));}
 b.key(down);assert.equal(b.position(),1);b.key('c',up);resolveCopy();await settle();assert(!b.text().includes('Copied:'));assert.equal(copied,b.f.messages.find(source=>source.id==='a5').text);
 b.key(down);
 assert(b.text().includes('Copied:'));
 b.key(pgdn);const a5=b.position();assert(a5>1);
 b.key(esc);
 assert(b.lines().find(line=>line.startsWith('› ')).includes('Retry policy'));
 assert(b.text().includes('Search: assistant'));
 assert.equal(b.position(),a5);
 b.key('\r','i');assert.equal(b.action().text,b.f.messages.find(source=>source.id==='a5').text);assert.equal(b.action().kind,'insert');b.c.dispose();
});
test('reader boundaries do not wrap; single results stay put and rapid short-to-long paging uses the new answer',()=>{
 const b=reader({pinnedOnly:true});b.lines();b.key('\r',down);assert.equal(b.selected(),keyOf('bash-pinned'));assert.equal(b.position(),1);
 const atEnd=b.lines();b.key(down);assert.deepEqual(b.lines(),atEnd);
 b.c.handleInput(up);b.c.handleInput(pgdn);assert.equal(b.selected(),keyOf('a4'));assert(b.position()>1);
 b.key(up);assert.equal(b.selected(),keyOf('a0'));const atStart=b.lines();b.key(up);assert.deepEqual(b.lines(),atStart);
 b.key(esc);
 b.search('release gate');
 b.key('\r');
 const previousPage=b.position();
 b.key(pgdn);
 const only=b.lines();
 b.key(up,down);
 assert.deepEqual(b.lines(),only);
 b.key(pgup);
 assert.equal(b.position(),previousPage);
 b.c.dispose();
});
test('All reader follows filtered rows across sessions with reused source IDs and correct insertion identity',()=>{
 const f=nativeFixture();f.fork.pins=f.fork.pins.map(source=>({...source,text:source.text+'\n\nThis copy belongs to the fork.'}));
 const b=reader({view:f.view,scope:'all',initial:keyOf('a1',T13)});b.search('import diagnostics');assert(b.text().includes('(1/2)'));b.key('\r',pgdn);assert(b.position()>1);
 assert.equal(b.selected('all'),keyOf('a1',T13));
 b.key(down);
 assert.equal(b.selected('all'),keyOf('a1',T14));
 assert.equal(b.position(),1);
 assert(b.text().includes(b.f.fork.id));
 assert(!b.text().includes('Session name:'));
 b.wheel(2);assert.equal(b.position(),3);b.key(up);assert.equal(b.position(),1);assert(b.text().includes('Session name: Recovery review'));
 b.key(down,esc);
 assert(b.text().includes('Search: import diagnostics'));
 assert(b.text().includes('(2/2)'));
 b.key('\r','i');
 assert.equal(b.action().text,f.fork.pins.find(source=>source.id==='a1').text);
 b.c.dispose();
});
test('replacement reader navigation changes only the outgoing target; heading stays fixed and r replaces the displayed candidate',()=>{
 const f=nativeFixture(),incoming=sourceFromEntry({id:'incoming',parentId:null,timestamp:'2026-10-21T13:00:00Z',type:'message',message:{role:'assistant',content:[{type:'text',text:'The incoming answer'}],stopReason:'stop'}}),b=reader({view:{session:f.group,messages:f.group.pins,all:[]},replacementFor:incoming,initial:keyOf('a0')});
 const title=b.lines()[0];b.key('\r',down,pgdn);assert.equal(b.selected(),keyOf('a4'));assert.equal(b.lines()[0],title);assert(b.position()>1);assert.equal(b.action(),undefined);
 const before=b.lines(),position=b.position();
 b.key(left);
 assert.deepEqual(b.lines(),before);
 b.key(right);
 assert.deepEqual(b.lines(),before);
 b.wheel(1);
 assert.equal(b.position(),position+1);
 b.wheel(-1);
 assert.deepEqual(b.lines(),before);
 b.key(down);
 assert.equal(b.selected(),keyOf('bash-pinned'));
 assert(b.text().includes('Pinned diagnostic output'));
 b.key(up,esc);
 assert(b.text().includes('(2/3)'));
 assert(b.lines().find(line=>line.startsWith('› ')).includes('Release gate'));
 b.key('\r','r');assert.deepEqual(b.action(),{kind:'replace',id:'a4'});b.c.dispose();
});
test('after unpin, previous/next follow source order in Session and All',async()=>{
 const f=nativeFixture();
 for(const [scope,id,direction,expectedGroup,expectedId,query] of [
  ['all','a4',down,f.foreign.id,'a4','release gate'],['all','a4',up,f.group.id,'a4','release gate'],
  ['current','a4',up,f.group.id,'a0'],['current','a4',down,f.group.id,'bash-pinned'],
  ['current','a0',up,f.group.id,'a0'],['current','a0',down,f.group.id,'a4'],['current','bash-pinned',down,f.group.id,'bash-pinned'],
  ['all','a4',up,f.group.id,'a0'],['all','a4',down,f.group.id,'bash-pinned'],
  ['all','a0',down,f.group.id,'a4'],['all','bash-pinned',down,f.foreign.id,'a0'],
 ]){
  let group={...f.group};
  const b=reader({view:{session:group,messages:f.messages,all:[group,f.foreign,f.fork]},scope,initial:keyOf(id),pinnedOnly:true,togglePin:async item=>{
   group={...group,pins:group.pins.filter(pin=>pin.id!==item.source.id)};
   return {session:group,messages:f.messages,all:[group,f.foreign,f.fork]};
  }});
  b.lines();if(query)b.search(query);b.key('\r','p');await settle();assert(b.text().includes('p pin · c copy'));b.key(direction);
  if(scope==='all')assert(b.text().includes(`Session ID: ${expectedGroup}`),`${scope} ${id} ${JSON.stringify(direction)} must show session ${expectedGroup}`);
  b.key('i');assert.equal(b.action().text,f.view.all.find(group=>group.id===expectedGroup).pins.find(source=>source.id===expectedId).text,`${scope} ${id} ${JSON.stringify(direction)}`);b.c.dispose();
 }
 let group={...f.group,pins:[f.group.pins[1]]};const b=reader({view:{session:group,messages:f.messages,all:[group]},pinnedOnly:true,togglePin:async()=>{group={...group,pins:[]};return {session:group,messages:f.messages,all:[group]};}});
 b.lines();b.key('\r','p');await settle();const only=b.lines();b.key(up,down);assert.deepEqual(b.lines(),only);b.key(esc);assert(b.text().includes('(0/0)'));b.c.dispose();
});
test('reader uses native Markdown and keeps original text for copy and insertion',async()=>{
 const message=(id,text)=>sourceFromEntry({id,type:'message',parentId:null,timestamp:'2026-10-26T00:00:00Z',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});
 const raw='Before\x1b[2J\x1b[H after\x1b]52;c;YWJj\x07 end',text='Steps:\r\n\n- one\r- two\n\n```\n\tindented\r\n```';
 const hostile=message('hostile',raw),ordinary=message('ordinary',text);
 const own={id:'own',pins:[ordinary]},saved={id:'saved',pins:[hostile]},view={session:own,messages:[ordinary],all:[saved]};
 const read=(scope,initial)=>{
  let action,copied;
  const c=createBrowser({tui:{terminal:{columns:100,rows:32},requestRender(){}},theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s},keys:getKeybindings(),
   view,memory:readingMemory(),scope,initial,signal:new AbortController().signal,done:value=>action=value,copy:async value=>{copied=value;}});
  c.focused=true;c.handleInput('\r');
  return {c,action:()=>action,copied:()=>copied};
 };
 const all=read('all',keyOf('hostile','2026-10-26T00:00:00Z')),frame=all.c.render(100).join('\n');
 assert.equal(clean(frame).split('\n')[0].trim(),'Pin');
 assert(clean(frame).includes('Before after end'));
 assert(clean(frame).includes('Session ID: saved'));
 for(const line of new Markdown(raw,0,0,getMarkdownTheme()).render(98))assert(frame.includes(line));
 // Copy and insert keep the original text.
 all.c.handleInput('c');await settle();assert.equal(all.copied(),raw);
 all.c.handleInput('i');assert.equal(all.action().text,raw);
 const ownReader=read('current',keyOf('ordinary','2026-10-26T00:00:00Z')),lines=ownReader.c.render(100);ownReader.c.dispose();
 const expected=new Markdown(text,0,0,getMarkdownTheme()).render(98).map(line=>panelLine(line,100));
 const start=lines.indexOf(expected[0]);
 assert(start>0);assert.deepEqual(lines.slice(start,start+expected.length),expected);
 assert.equal(ordinary.text,text);
});
