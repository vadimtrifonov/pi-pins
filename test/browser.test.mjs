import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme,TreeSelectorComponent} from '@earendil-works/pi-coding-agent';
import {getKeybindings,visibleWidth} from '@earendil-works/pi-tui';
import {createBrowser,readingMemory,pinItems} from '../src/browser.ts';
import {createTree,treeNodes} from '../src/tree.ts';
import {nativeFixture,freeze,key as keyOf} from './native-fixtures.mjs';
initTheme('dark',false);
const keys=getKeybindings(), theme={fg:(_color,text)=>text,bg:(_color,text)=>text,bold:text=>text};
function browser(extra={}){
 const fixture=nativeFixture(),tui={terminal:{columns:75,rows:32},requestRender(){}};
 const memory=readingMemory(),controller=new AbortController();let action,closed=false;
 const options={tui,theme,keys,view:fixture.view,memory,scope:'current',initial:keyOf('a7'),signal:controller.signal,done:value=>{action=value;closed=true;},...extra};
 const c=createBrowser(options);c.focused=true;
 const lines=()=>c.render(tui.terminal.columns).map(clean),screen=()=>lines().join('\n');
 const key=(...data)=>{for(const value of data){c.handleInput(value);lines();}return screen();};
 const search=text=>{key('/','\x15');for(const ch of text)key(ch);key('\x1b');};
 const selected=()=>lines().find(line=>line.startsWith('› '));
 return {c,tui,memory,options,fixture,controller,lines,screen,key,search,selected,input:data=>c.handleInput(data),action:()=>action,closed:()=>closed};
}

test(`real TreeList role colors, selectedBg, markers and native counter; original entries stay immutable`,()=>{
 const f=nativeFixture(),before=JSON.stringify(f.entries);freeze(f.entries);
 const items=pinItems(f.group,f.messages);
 for(const item of items){assert.equal(item.group,f.group);assert.equal(item.source.entry,f.entries.find(entry=>entry.id===item.source.id));assert.equal(item.pinned,f.group.pins.some(pin=>pin.id===item.source.id));}
 const nodes=treeNodes(items),selected=keyOf('a4');
 const reference=new TreeSelectorComponent(nodes.slice(0,1),null,1000,()=>{},()=>{},undefined,selected,'default').getTreeList();

 const tree=createTree(items,'default','',selected),actual=tree.render(114,1000);
 assert.deepEqual(actual,reference.render(114));assert(actual.some(line=>clean(line).includes('user:')));assert(actual.some(line=>clean(line).includes('assistant:')));
 const chosen=actual.find(line=>clean(line).startsWith('› '));assert.match(chosen,/\x1b\[/);assert(chosen.includes('[pinned]'));assert.match(clean(actual.at(-1)),/\(\d+\/\d+\)/);
 tree.render(40,1);tree.render(75,4);assert.equal(JSON.stringify(f.entries),before);
});
test(`search treats action letters as text; Ctrl+U edits the query across resize; Enter opens the reader`,()=>{
 let toggles=0;const b=browser({togglePin:async()=>{toggles++;return nativeFixture().view;}});
 const original=b.selected();b.key('z','a');assert.equal(b.selected(),original);assert.equal(b.memory.localQuery,'');
 b.key('/');for(const ch of 'pci')b.key(ch);assert.equal(b.memory.localQuery,'pci');assert.equal(toggles,0);
 for(const size of [[40,18],[60,24],[114,65],[75,32]]){Object.assign(b.tui.terminal,{columns:size[0],rows:size[1]});assert(b.screen().includes('pci'));}
 b.key('\x15');for(const ch of 'rollout')b.key(ch);b.key('\r');assert.equal(b.lines()[0].trim(),'Pin');assert.equal(toggles,0);
 b.key('\x1b');assert(b.screen().includes('Search: rollout'));b.key('\x1b');assert(b.closed());b.c.dispose();
});
test(`Session/All preserve independent queries; messages sharing an ID across sessions stay distinct; Escape keeps the reading position`,async()=>{
 let copied;const b=browser({copy:async text=>copied=text});b.search('release gate');const source=b.selected();
 b.key('\x1b[6~');const first=b.lines().at(-1).match(/lines (\d+)/)[1];assert(Number(first)>1);
 b.key('\r','\x1b[6~');const readerFirst=b.lines().at(-1).match(/lines (\d+)/)[1];b.key('\x1b');assert.equal(b.lines().at(-1).match(/lines (\d+)/)[1],readerFirst);
 b.key('\t');assert(b.lines()[0].includes('◉ All'));b.search('import diagnostics');assert.equal(b.memory.query,'import diagnostics');
 const firstKey=b.memory.selected.get('all');
 b.key('\r');
 assert.equal(b.lines()[0].trim(),'Pin');
 b.key('\x1b');
 b.key('c');
 await settle();
 assert.equal(copied,b.fixture.foreign.pins.find(pin=>pin.id==='a1').text);
 b.key('\x1b[B');const secondKey=b.memory.selected.get('all');assert.notEqual(firstKey,secondKey);assert.equal(firstKey.split('@')[0],secondKey.split('@')[0]);
 b.key('\t');assert.equal(b.memory.localQuery,'release gate');assert.equal(b.selected(),source);
 b.key('\t');assert.equal(b.memory.selected.get('all'),secondKey);assert(b.screen().includes('Search: import diagnostics'));b.c.dispose();
});
test(`full original copy/insert, unpadded ordered actions; All unpins another session's pin and can pin it again`,async()=>{
 const f=nativeFixture(),toggled=[];let copied,view=f.view;
 const togglePin=async item=>{
  toggled.push([item.key,item.pinned]);
  const all=view.all.map(group=>group.id!==item.group.id?group:{...group,pins:item.pinned?group.pins.filter(pin=>pin!==item.source):[...group.pins,item.source]});
  return view={...view,all};
 };
 const b=browser({view,copy:async text=>copied=text,togglePin});
 const pinRow=b.lines().find(line=>line.includes('c copy'));assert.match(pinRow.trim(),/^p pin · c copy · i insert/);b.search('migration plan');
 const next=b.lines().find(line=>line.includes('c copy'));
 assert.match(next.trim(),/^p unpin · c copy · i insert/);
 assert.equal(next.indexOf('c copy'),pinRow.indexOf('c copy')+2);
 assert.equal(next.indexOf('i insert'),pinRow.indexOf('i insert')+2);
 b.key('c');await settle();assert.equal(copied,b.fixture.group.pins[0].text);assert(b.screen().includes('Copied:'));
 b.key('\t');
 b.search('import diagnostics');
 assert.match(b.lines().find(line=>line.includes('c copy')).trim(),/^p unpin · c copy · i insert/);
 const row=b.memory.selected.get('all');
 b.key('\r','p');await settle();
 assert.deepEqual(toggled,[[row,true]]);
 assert(b.screen().includes('p pin · c copy'),'The reader stays on the unpinned message');
 assert(b.screen().includes('Step 1: verify the import diagnostics'));
 b.key('p');await settle();
 assert.deepEqual(toggled,[[row,true],[row,false]]);
 assert(b.screen().includes('p unpin · c copy'));
 b.key('i');assert.equal(b.action().kind,'insert');assert.equal(b.action().text,f.foreign.pins.find(source=>source.id==='a1').text);b.c.dispose();
});
test(`a failed pin change shows its error until the next attempt`,async()=>{
 const f=nativeFixture();let fail=true;
 const b=browser({view:f.view,togglePin:async()=>{if(fail){fail=false;throw new Error('Lock file is already being held');}return {...f.view,session:{...f.group,pins:f.group.pins.slice(1)}};}});
 b.search('migration plan');b.key('p');await settle();assert(b.screen().includes('Lock file is already being held'));
 b.key('p');await settle();assert(!b.screen().includes('Lock file'));assert.match(b.lines().find(line=>line.includes('c copy')).trim(),/^p pin/);
 b.c.dispose();
});
test(`40×18 geometry, counter/selection remain visible, closing lines survive reading/filter/no-match/resizes`,async()=>{
 const b=browser({copy:async()=>{throw new Error('Clipboard unavailable');}});
 for(const [columns,rows] of [[114,65],[75,32],[40,18],[60,24],[40,18]]){
  Object.assign(b.tui.terminal,{columns,rows});for(const mode of ['local','query','reader','all','all-query','none']){
   if(mode==='query')b.search('release gate');
   if(mode==='reader')b.key('\r');
   if(mode==='all'){b.key('\x1b','\t');b.search('');}
   if(mode==='all-query')b.search('migration');
   if(mode==='none')b.search('unfindable');
   const lines=b.lines();
   assert(lines.length<=rows-2,`${mode} ${columns}x${rows}: ${lines.length}`);
   assert(lines.every(line=>visibleWidth(line)<=columns));
   assert(!b.screen().includes('More room'),`${mode}\n${b.screen()}`);
   assert.match(lines.at(-1),/[─]/);
   if(mode==='reader')assert.equal(lines[0].trim(),'Pin');
   if(mode!=='none')assert.match(lines.at(-1),/lines \d+–\d+\/\d+/);if(!['reader','none'].includes(mode))assert(b.selected(),mode);
  }
  b.key('\t');b.search('');
 }
 b.search('release gate');b.key('c');await settle();assert(b.screen().includes('Copy failed'));assert(!b.screen().includes('More room'));b.c.dispose();
});

test('shortcut hints wrap intact and filtering preserves selection and reading position',()=>{
 const b=browser();Object.assign(b.tui.terminal,{columns:130,rows:32});
 const expected='p pin · c copy · i insert · Ctrl+P pins · / search · ↑/↓ move · PgUp/PgDn scroll · Enter read · Tab scope · Esc close';
 assert.equal(b.lines()[1].trim(),expected);assert.match(b.lines()[2],/^─+$/);
 for(const columns of [114,75,40]){
  b.tui.terminal.columns=columns;const header=b.lines().slice(1,b.lines().findIndex(line=>/^─+$/.test(line))).map(line=>line.trim()).join(' · ');
  assert.equal(header,expected);
 }
 b.tui.terminal.columns=130;
 b.key('\x15');assert(b.lines().some(line=>/\(8\/8\) \[user\]/.test(line)));
 b.key('\x15');assert(!b.screen().includes('[user]'));
 b.key('\x10');assert(b.screen().includes('Ctrl+P all'));assert(b.lines().some(line=>/\(\d+\/3\) \[pinned\]/.test(line)));
 b.search('release gate');const selected=b.memory.selected.get('current');b.key('\x1b[6~');const position=b.lines().at(-1);
 b.key('\x10');assert(b.screen().includes('Ctrl+P pins'));assert.equal(b.memory.selected.get('current'),selected);assert.equal(b.lines().at(-1),position);
 b.key('\x10');assert(b.screen().includes('Search: release gate'));assert.equal(b.memory.selected.get('current'),selected);
 b.key('\t');assert(!b.screen().includes('Ctrl+P'));b.key('\x10');assert(b.lines()[0].includes('◉ All'));b.key('\t');assert(b.screen().includes('Ctrl+P all'));
 b.key('\x0f');assert(b.screen().includes('Ctrl+P pins'));b.key('\x10');assert(b.screen().includes('Ctrl+P all'));
 b.key('/');assert(b.screen().includes('↑/↓ move'));assert(b.screen().includes('PgUp/PgDn scroll'));assert(!b.screen().includes('c copy'));b.key('\x1b');
 b.key('\r');assert(b.screen().includes('↑/↓ previous/next'));assert(b.screen().includes('PgUp/PgDn scroll'));assert(!b.screen().includes('Ctrl+P'));b.c.dispose();
});
test('all shortcut text stays muted with the real Pi theme, including wrapped rows and foreign pins',async()=>{
 const themes=await import(new URL('./modes/interactive/theme/theme.js',import.meta.resolve('@earendil-works/pi-coding-agent')));
 initTheme('dark',false);const realTheme=themes.theme,b=browser({theme:realTheme});
 for(const columns of [130,40]){
  b.tui.terminal.columns=columns;
  for(const mode of ['messages','pinned','reader','all','search']){
   if(mode==='pinned')b.key('\x10');if(mode==='reader')b.key('\r');if(mode==='all'){b.key('\x1b','\t');b.search('import diagnostics');}if(mode==='search')b.key('/');
   const raw=b.c.render(columns),rule=raw.findIndex(line=>/^─+$/.test(clean(line)));
   const first=mode==='search'||mode==='all'?2:1;
   assert(rule>first,`${mode} ${columns}: missing hints`);
   for(const row of raw.slice(first,rule))assert(row.includes(realTheme.fg('muted',clean(row).trim())),`${mode} ${columns}: ${JSON.stringify(row)}`);
  }
  b.key('\x1b');b.search('');b.key('\t','\x10');
 }
 b.c.dispose();
});
test('an empty pin subset keeps the way back and selected message',()=>{
 const f=nativeFixture(),b=browser({view:{...f.view,session:{...f.group,pins:[]}}});
 const selected=b.memory.selected.get('current');b.key('\x10');assert(b.screen().includes('(0/0) [pinned]'));assert(b.screen().includes('Ctrl+P all'));
 b.key('\x10');assert.equal(b.memory.selected.get('current'),selected);b.c.dispose();
});
test('empty Session stays open and can reach pins of other sessions',()=>{
 const f=nativeFixture(),b=browser({view:{session:{...f.group,pins:[]},messages:[],all:[f.foreign]}});
 assert(b.screen().includes('No messages'));
 b.key('\t');assert(b.selected().includes('# Release gate'),'All opens at the newest pin');
 b.c.dispose();
});
test('All without pins says so',()=>{
 const f=nativeFixture(),b=browser({view:{session:{...f.group,pins:[]},messages:f.messages,all:[]}});
 b.key('\t');assert(b.screen().includes('No pins.'));assert(b.screen().includes('(0/0)'));b.c.dispose();
});
test('40×18 All keeps two actual sources plus counter and three answer rows with named UUID attribution; action band disappears only while editing',()=>{
 const f=nativeFixture(),tui={terminal:{columns:40,rows:18},requestRender(){}};
 const c=createBrowser({tui,theme,keys,view:f.view,memory:readingMemory(),scope:'all',initial:keyOf('a4','2026-10-21T13:00:00Z'),signal:new AbortController().signal,done(){}});
 c.focused=true;
 const render=()=>c.render(40).map(clean),text=()=>render().join('\n'),key=data=>{c.handleInput(data);render();};
 function verify(){const lines=render();assert.equal(lines.length,16);assert(!text().includes('More room'));
  const counter=lines.findIndex(line=>/\(\d+\/\d+\)/.test(line));assert(counter>1);assert(lines[counter-1].includes('assistant:'));assert(lines[counter-2].includes('assistant:'));
  assert(text().includes('Session name: Recovery review'));assert(text().replace(/\s/g,'').includes(f.foreign.id));assert.match(lines.at(-1),/lines 1–[3-9]/);
 }
 verify();key('/');assert(!text().includes('c copy'));assert(!text().includes('p unpin'));
 for(const char of 'release gate')key(char);key('\x1b');assert(text().includes('p unpin · c copy · i insert'));verify();c.dispose();
});
