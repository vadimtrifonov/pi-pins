import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme,TreeSelectorComponent} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import {registerPins} from '../src/index.ts';
import extension from '../src/extension.ts';
import {LIMIT,identity} from '../src/state.ts';
import {nativeFixture} from './native-fixtures.mjs';
initTheme('dark',false);
const theme={fg:(_color,text)=>text,bg:(_color,text)=>text,bold:text=>text},keys=getKeybindings();
const body=i=>`# Answer ${i}\n\n`+`Paragraph ${i} explains the restore step. `.repeat(60);
const HEADER={type:'session',version:3,id:'owner',timestamp:'2026-10-20T00:00:00Z',cwd:'/project'};
const stored=(entry,origin={id:'owner'})=>({entry,origin});
const answer=(id,text,timestamp)=>({id,parentId:null,timestamp,type:'message',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});

/** The pins file of all Pi processes, in memory. Like the file store, it resolves after the caller yields. */
function memoryStore(pins=[]){
 const watchers=new Set();
 const store={pins,writes:[],invalid:undefined,
  async read(){if(store.invalid)throw new Error(store.invalid);return store.pins;},
  async update(change){
   const current=await store.read(),next=change(current);
   if(next!==current){store.pins=next;store.writes.push(next.map(pin=>pin.entry.id));}
   return next;
  },
  watch(onChange){watchers.add(onChange);return()=>watchers.delete(onChange);},
  watching:()=>watchers.size,
  /** Another Pi replaced the file. */
  changed(next=store.pins){store.pins=next;for(const watcher of watchers)watcher();},
 };
 return store;
}

async function session({answers=4,replies=true,pinned=[],elsewhere=[],tools=[],extra=[],tail=true,onDone}={}){
 const branch=[],add=entry=>branch.push({parentId:branch.at(-1)?.id??null,timestamp:'2026-10-20T12:00:00Z',...entry});
 for(let i=0;i<answers;i++){
  add({id:'u'+i,type:'message',message:{role:'user',content:`Question ${i}`}});
  if(tools.includes(i))add({id:'t'+i,type:'message',message:{role:'toolResult',toolName:'read',content:[{type:'text',text:`file contents ${i}`}]}});
  if(replies)add({id:'a'+i,type:'message',message:{role:'assistant',content:[{type:'text',text:body(i)}],stopReason:'stop'}});
 }
 for(const entry of extra)add(entry);
 if(answers&&tail)add({id:'tail',type:'message',message:{role:'user',content:'A follow-up question'}});
 const store=memoryStore([...pinned.map(id=>stored(branch.find(entry=>entry.id===id))),...elsewhere]);
 const overlays=[],stack=[],notices=[],inserted=[],hooks=new Map(),widgets=new Map();let command,shelf;
 registerPins({registerCommand:(_name,definition)=>command=definition,on:(event,handler)=>hooks.set(event,handler),getSessionName:()=> 'Entry'},store);
 const tui={terminal:{columns:75,rows:32},requestRender(){}};
 const ctx={mode:'tui',sessionManager:{getSessionId:()=> 'owner',getHeader:()=>HEADER,getBranch:()=>[...branch],getEntries:()=>[...branch]},ui:{
  notify:(...args)=>notices.push(args),pasteToEditor:text=>inserted.push(text),setEditorText(){assert.fail('Must not replace editor');},
  setWidget:(key,factory)=>{widgets.delete(key);if(factory)widgets.set(key,factory({requestRender(){}},theme));shelf=widgets.get('pins:shelf');},
  custom:(factory,options)=>new Promise(resolve=>{
   assert.equal(options?.overlay,true);assert.equal(options.overlayOptions.margin.bottom,2);
   if(stack.length)stack.at(-1).focused=false;
   const c=factory(tui,theme,keys,value=>{c.dispose();stack.splice(stack.indexOf(c),1);if(stack.length)stack.at(-1).focused=true;resolve(value);onDone?.(value);});
   c.focused=true;
   overlays.push(c);
   stack.push(c);
  }),
 }};
 await hooks.get('session_start')({},ctx);
 const lines=()=>stack.at(-1).render(tui.terminal.columns).map(clean),screen=()=>lines().join('\n'),row=()=>lines().find(line=>line.startsWith('› '))?.trim();
 const press=async(...data)=>{for(const key of data){stack.at(-1).handleInput(key);await settle();if(stack.length)lines();}};
 const search=async text=>{await press('/','\x15',...text,'\x1b');};
 const track=promise=>{const run={finished:false,promise};promise.then(()=>run.finished=true);return run;};
 const after=async promise=>{const run=track(promise);await settle();if(stack.length)lines();return run;};
 return {store,writes:store.writes,overlays,notices,inserted,lines,screen,row,press,search,tui,widgets,hooks,ctx,branch,
  shelfLabels:()=>widgets.get('pins:shelf')?.render(400).slice(1).map(line=>clean(line).slice(5).trimEnd())??[],
  shutdown:()=>hooks.get('session_shutdown')({},ctx),
  start:args=>after(command.handler(args,ctx)),
  shelfClick:y=>{shelf.render(75);return after(Promise.resolve(shelf.handleMouse({type:'click',button:'left',x:5,y})));}};
}
test(`/pins opens Session at latest answer; Enter reads; p toggles in-place; copy/insert remain ordered`,async()=>{
 const s=await session();const run=await s.start('');assert(s.lines()[0].includes('◉ Session'));assert(s.row().includes('assistant: # Answer 3'));
 await s.press('\r');assert.equal(s.lines()[0].trim(),'Pin');assert.deepEqual(s.writes,[]);
 await s.press('p');assert(!run.finished);assert.deepEqual(s.writes,[['a3']]);assert.equal(s.overlays.length,1);assert(s.lines()[1].includes('p unpin · c copy · i insert'));
 await s.press('p');assert.deepEqual(s.writes,[['a3'],[]]);assert(s.lines()[1].includes('p pin · c copy · i insert'));
 await s.press('\x1b','i');await run.promise;assert.deepEqual(s.inserted,[body(3)]);
});
test(`a new pin records this session and its name, and keeps only the text the reader uses`,async()=>{
 const image={type:'image',data:'aGVsbG8=',mimeType:'image/png'};
 const s=await session({answers:1,extra:[{id:'pic',type:'message',message:{role:'user',content:[{type:'text',text:'See the screenshot'},image]}}],tail:false});
 const run=await s.start('');await s.search('screenshot');await s.press('p','\x1b');await run.promise;
 assert.deepEqual(s.store.pins.map(pin=>[pin.entry.id,pin.origin]),[['pic',{id:'owner',name:'Entry'}]]);
 assert.deepEqual(s.store.pins[0].entry.message.content,[{type:'text',text:'See the screenshot'}]);
 assert.deepEqual(s.branch.find(entry=>entry.id==='pic').message.content.at(-1),image,'The session entry keeps its image');
});
test(`without an assistant answer, /pins opens at the newest listed message`,async()=>{
 const s=await session({answers:3,replies:false,tools:[2],tail:false});const run=await s.start('');
 assert(s.row().includes('user: Question 2'));await s.press('\x1b');await run.promise;
});
test(`shelf opens Session pinned-only; Tab switches Session/All; p in All unpins a pin of another session`,async()=>{
 const foreign=stored(answer('x','Saved response','2026-10-20T13:00:00Z'),{id:'foreign',name:'Other'});
 const s=await session({pinned:['a0','a2'],elsewhere:[foreign]});
 assert.equal(s.shelfLabels().length,2,'The shelf lists only messages this session contains');
 await s.shelfClick(2);assert(s.lines()[0].includes('◉ Session'));assert.match(s.screen(),/\(\d\/2\) \[pinned\]/);
 await s.press('\t');assert(s.lines()[0].includes('◉ All'));await s.search('Saved response');assert(s.screen().includes('Session name: Other'));
 await s.press('p');assert.deepEqual(s.writes,[['a0','a2']]);
 await s.press('\t');assert(s.lines()[0].includes('◉ Session'));assert(!s.screen().includes('Search:'));await s.press('\x1b');
});
test(`unpinning and pinning again from All keeps the Session selection`,async()=>{
 const foreign=stored(answer('x','Saved response','2026-10-20T13:00:00Z'),{id:'foreign',name:'Other'});
 const s=await session({elsewhere:[foreign]});const run=await s.start('');const selected=s.row();
 await s.press('\t');await s.search('Saved response');await s.press('\r','p','p','\x1b','\t');
 assert.deepEqual(s.writes,[[],['x']]);assert.equal(s.row(),selected);
 await s.press('\x1b');await run.promise;
});
test(`replacement cancel retains same browser/reader, query and offset; replacement succeeds without closing`,async()=>{
 const pinned=Array.from({length:LIMIT},(_,i)=>'a'+i),s=await session({answers:LIMIT+1,pinned});const run=await s.start('');
 await s.search('Answer 3');
 let before=s.lines();
 await s.press('p');
 assert(s.lines()[0].trim().startsWith('Replace with: assistant: # Answer 3 '));
 assert(s.screen().includes('(1/3)'));
 assert(!s.screen().includes('Search:'));
 assert.equal(s.lines().length,30);
 const choosing=s.lines();await s.press('p','p','\t','\x0c','\x0f','\x10','c','i','/');assert.deepEqual(s.lines(),choosing);assert.deepEqual(s.writes,[]);assert.deepEqual(s.inserted,[]);
 await s.press('\r','\x1b[6~');assert(s.lines()[0].trim().startsWith('Replace with: assistant: # Answer 3 '));assert(s.screen().includes('↑/↓ previous/next'));assert.deepEqual(s.writes,[]);
 await s.press('\x1b','\x1b');assert.deepEqual(s.lines(),before);assert.deepEqual(s.writes,[]);
 await s.press('\r','\x1b[6~');before=s.lines();await s.press('p');
 Object.assign(s.tui.terminal,{columns:40,rows:18});assert.equal(s.lines().length,16);assert(!s.screen().includes('More room'));
 Object.assign(s.tui.terminal,{columns:75,rows:32});await s.press('\x1b');assert.deepEqual(s.lines(),before);assert(!run.finished);
 await s.press('p','\x1b[B','\r','r');assert(!run.finished);assert.equal(s.lines()[0].trim(),'Pin');assert.deepEqual(s.writes,[['a0','a2','a3']]);
 assert.equal(s.lines().at(-1),before.at(-1));assert(s.lines()[1].includes('p unpin · c copy · i insert'));
 await s.press('\x1b');assert(s.screen().includes('Search: Answer 3'));await s.press('\x1b');await run.promise;
});
test(`the limit counts only pins this session contains, and a replacement chooses among them`,async()=>{
 const elsewhere=['x','y','z'].map((id,i)=>stored(answer(id,`Other session answer ${id}`,`2026-10-20T13:0${i}:00Z`),{id:'foreign'}));
 const s=await session({answers:4,pinned:['a0','a1'],elsewhere});let run=await s.start('');
 await s.search('Answer 2');await s.press('p');
 assert(!s.screen().includes('Replace with:'),'Pins of other sessions do not fill this shelf');
 assert.deepEqual(s.writes,[['a0','a1','x','y','z','a2']]);
 await s.search('Answer 3');await s.press('p');
 assert(s.screen().includes('Replace with:'));assert(s.screen().includes('(1/3)'),'Only this session\'s pins can be replaced');
 await s.press('\x1b','\x1b');await run.promise;
});
test(`a message pinned elsewhere while the replacement dialog is open unpins nothing`,async()=>{
 const s=await session({answers:4,pinned:['a0','a1','a2']});const run=await s.start('');
 await s.press('p');assert(s.screen().includes('Replace with: assistant: # Answer 3'));
 s.store.pins=[...s.store.pins,stored(s.branch.find(entry=>entry.id==='a3'),{id:'twin'})]; // Another Pi pinned the same message.
 await s.press('r');
 assert.deepEqual(s.writes,[]);assert.deepEqual(s.store.pins.map(pin=>pin.entry.id),['a0','a1','a2','a3']);
 assert.equal(s.shelfLabels().length,4,'A shelf can exceed the limit through other sessions');
 await s.press('\x1b');await run.promise;
});
test(`widget omits author prefixes while Session and All retain them`,async()=>{
 const s=await session({pinned:['u0','a0','b0'],extra:[{id:'b0',type:'message',message:{role:'bashExecution',command:'npm test',output:'ok',exitCode:0,cancelled:false,truncated:false}}]});
 s.tui.terminal.columns=400;
 const labels=s.shelfLabels();
 assert.equal(labels.length,3);assert.equal(labels[0],'Question 0');assert(labels[1].startsWith('# Answer 0 '));assert.equal(labels[2],'[bash]: npm test');
 const expected=[`user: ${labels[0]}`,`assistant: ${labels[1]}`,labels[2]];
 for(let i=0;i<labels.length;i++){
  await s.shelfClick(i+1);assert.equal(s.row().replace(/^› \[pinned\] /,''),expected[i]);
  await s.press('\t');const rows=[];
  for(let j=0;j<labels.length;j++){rows.push(s.row().replace(/^› \[pinned\] /,''));await s.press('\x1b[B');}
  assert.deepEqual(rows.sort(),[...expected].sort());await s.press('\x1b');
 }
});
test(`shelf refresh updates the mounted component without moving it below another widget`,async()=>{
 const s=await session({pinned:['a0','a2']}),shelf=s.widgets.get('pins:shelf');
 s.widgets.set('other',{render:()=>['Other widget']});
 const run=await s.start('');await s.press('p');
 assert.equal(s.widgets.get('pins:shelf'),shelf);assert.deepEqual([...s.widgets.keys()],['pins:shelf','other']);
 assert(shelf.render(75).map(clean).some(line=>line.includes('Answer 3')));
 await s.press('p');assert.equal(s.widgets.get('pins:shelf'),shelf);assert.deepEqual([...s.widgets.keys()],['pins:shelf','other']);
 assert(!shelf.render(75).map(clean).some(line=>line.includes('Answer 3')));
 await s.press('\x1b');await run.promise;
});
test(`pins changed by another Pi update the shelf, and an older read cannot overwrite a newer save`,async()=>{
 const s=await session({pinned:['a0']});assert.equal(s.store.watching(),1);
 s.store.changed([...s.store.pins,stored(s.branch.find(entry=>entry.id==='a1'))]);await settle();
 assert.equal(s.shelfLabels().length,2);
 // A read started before this Pi's save finishes after it with the file as it was.
 let finish;const read=s.store.read,old=s.store.pins;
 s.store.read=()=>{s.store.read=read;return new Promise(resolve=>finish=()=>resolve(old));};
 s.store.changed(old);
 const run=await s.start('');await s.search('Answer 3');await s.press('p','\x1b');await run.promise;
 assert.equal(s.shelfLabels().length,3);
 finish();await settle();
 assert.equal(s.shelfLabels().length,3);
 s.hooks.get('session_shutdown')({},s.ctx);assert.equal(s.store.watching(),0);
});
test(`a replacement chosen before the session ends is still saved`,async()=>{
 let s;
 s=await session({pinned:['a0','a1','a2'],onDone:value=>{if(value?.kind==='replace')queueMicrotask(()=>s.shutdown());}});
 const run=await s.start('');
 await s.press('p','r');await run.promise;
 assert.deepEqual(s.writes,[['a1','a2','a3']]);
});
test(`list replacement commits once, while ending the session before choosing saves nothing`,async()=>{
 const s=await session({answers:4,pinned:['a0','a1','a2']});let run=await s.start('');const selected=s.row();
 await s.press('p','r');
 assert(!run.finished);
 assert(selected.includes('assistant: # Answer 3'));
 assert(s.row().includes('[pinned] assistant: # Answer 3'));
 assert.deepEqual(s.writes,[['a1','a2','a3']]);
 await s.press('\x1b');await run.promise;
 run=await s.start('');await s.search('Answer 0');await s.press('p');assert(s.screen().includes('Replace with:'));
 s.shutdown();await run.promise;assert.deepEqual(s.writes,[['a1','a2','a3']]);
});
test(`renaming the session renames pins written in it`,async()=>{
 const s=await session({pinned:['a0'],elsewhere:[stored(answer('x','Elsewhere','2026-10-20T13:00:00Z'),{id:'foreign',name:'Other'})]});
 await s.hooks.get('session_info_changed')({type:'session_info_changed',name:'Renamed'},s.ctx);
 assert.deepEqual(s.store.pins.map(pin=>pin.origin),[{id:'owner',name:'Renamed'},{id:'foreign',name:'Other'}]);
 await s.hooks.get('session_info_changed')({type:'session_info_changed',name:'Renamed'},s.ctx);
 assert.equal(s.writes.length,1,'An unchanged name writes nothing');
});
test('extension registers only the bare /pins command and stays inert outside the TUI',async()=>{
 const commands=new Map(),hooks=[],notices=[];
 extension({registerCommand:(name,command)=>commands.set(name,command),registerShortcut(){assert.fail('/pins is the only entry point');},on:(event,handler)=>{if(event==='session_start')hooks.push(handler);}});
 const ctx={mode:'rpc',hasUI:true,ui:{notify:(...args)=>notices.push(args)}};for(const hook of hooks)await hook({},ctx);
 await commands.get('pins').handler('',ctx);
 assert.deepEqual([...commands.keys()],['pins']);assert.deepEqual(notices,[]);
 assert.equal(commands.get('pins').getArgumentCompletions,undefined);
});
test('Session lists only user messages, assistant answers and user-run commands; pins of other entries disappear',async()=>{
 const f=nativeFixture(),branch=[...f.entries];
 const add=(id,entry)=>branch.push({id,parentId:branch.at(-1).id,timestamp:'2026-10-21T12:00:00Z',...entry});
 add('branch-summary',{type:'branch_summary',summary:'Branch summary sentinel',fromId:'a0'});
 add('extension-role',{type:'message',message:{role:'custom',customType:'extension',content:'Extension role sentinel',display:true}});
 add('command',{type:'message',message:{role:'bashExecution',command:'echo user command',output:'User command result',exitCode:0,cancelled:false,truncated:false}});
 add('old-note',{type:'message',message:{role:'custom',customType:'old-note',content:'Previously pinned extension reference',display:true}});
 const store=memoryStore(['a0','bash-pinned','old-note'].map(id=>stored(branch.find(entry=>entry.id===id))));
 const before=JSON.stringify(branch);let command,opened=false;
 const hooks=new Map();
 registerPins({registerCommand:(_name,value)=>{command=value;},on:(event,handler)=>hooks.set(event,handler),getSessionName:()=>f.group.name},store);
 const ctx={mode:'tui',sessionManager:{getSessionId:()=>f.group.id,getHeader:()=>HEADER,getBranch:()=>branch,getEntries:()=>branch},ui:{notify:message=>assert.fail(message),setWidget(){},async custom(factory){
  opened=true;const c=factory({terminal:{columns:130,rows:65},requestRender(){}},theme,keys,()=>{});c.focused=true;
  const screen=()=>c.render(130).map(clean).join('\n');
  const search=text=>{c.handleInput('/');c.handleInput('\x05');c.handleInput('\x15');for(const ch of text)c.handleInput(ch);c.handleInput('\x1b');return screen();};
  try{
   assert.match(screen(),/\(\d+\/18\)/);
   for(const text of ['Compaction notes','ordinary extension','Branch summary sentinel','Extension role sentinel','Unpinned tool noise','Previously pinned'])assert.match(search(text),/\(0\/0\)/,text);
   assert.match(search('user command'),/\(1\/1\)/);search('');
   c.handleInput('\x10');assert.match(screen(),/\(\d+\/2\) \[pinned\]/);
   c.handleInput('\t');assert.match(screen(),/\(\d+\/2\)/);
  }finally{c.dispose();}
 }}};
 await hooks.get('session_start')({},ctx);
 await command.handler('',ctx);assert(opened);assert.equal(JSON.stringify(branch),before);assert.deepEqual(store.writes,[]);
});
test('refresh failures clear an old shelf, and an unsupported pins file is reported and never overwritten',async()=>{
 const s=await session({answers:1,pinned:['a0']});
 const widget=()=>s.widgets.get('pins:shelf');assert(widget());
 const original=TreeSelectorComponent.prototype.getTreeList;
 try{
  TreeSelectorComponent.prototype.getTreeList=function(){return Object.assign(original.call(this),{getEntryDisplayText:undefined});};
  assert.doesNotThrow(()=>widget().render(75));
  s.store.changed();await settle();
  assert.equal(widget(),undefined);assert.equal(s.notices.length,1);assert(s.notices[0][0].includes('unsupported Pi TreeList'));
 }finally{TreeSelectorComponent.prototype.getTreeList=original;}
 s.store.changed();await settle();assert(widget());
 s.store.invalid='Unsupported pins file: pins.json';s.store.changed();await settle();
 assert.equal(widget(),undefined);assert.equal(s.notices.length,2);assert(s.notices[1][0].includes('Unsupported pins file'));
 const run=await s.start('');await run.promise;
 assert.equal(s.notices.length,3,'/pins does not open over an unreadable file');assert.deepEqual(s.writes,[]);
});
