import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme,TreeSelectorComponent} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import {registerPins} from '../src/index.ts';
import extension from '../src/extension.ts';
import {LIMIT,PIN_STATE,snapshot,sourcesOnBranch} from '../src/state.ts';
import {nativeFixture} from './native-fixtures.mjs';
initTheme('dark',false);
const theme={fg:(_color,text)=>text,bg:(_color,text)=>text,bold:text=>text},keys=getKeybindings();
const body=i=>`# Answer ${i}\n\n`+`Paragraph ${i} explains the restore step. `.repeat(60);
function session({answers=4,replies=true,pinned=[],tools=[],extra=[],tail=true,saved,onDone}={}){
 const branch=[],add=entry=>branch.push({parentId:branch.at(-1)?.id??null,timestamp:'2026-10-20T12:00:00Z',...entry});
 for(let i=0;i<answers;i++){
  add({id:'u'+i,type:'message',message:{role:'user',content:`Question ${i}`}});
  if(tools.includes(i))add({id:'t'+i,type:'message',message:{role:'toolResult',toolName:'read',content:[{type:'text',text:`file contents ${i}`}]}});
  if(replies)add({id:'a'+i,type:'message',message:{role:'assistant',content:[{type:'text',text:body(i)}],stopReason:'stop'}});
 }
 for(const entry of extra)add(entry);
 if(answers&&tail)add({id:'tail',type:'message',message:{role:'user',content:'A follow-up question'}});
 if(pinned.length)add({id:'state',type:'custom',customType:PIN_STATE,data:snapshot(pinned)});
 const writes=[],overlays=[],stack=[],notices=[],inserted=[],hooks=new Map(),widgets=new Map();let command,shelf;
 registerPins({registerCommand:(_name,definition)=>command=definition,
  on:(event,handler)=>hooks.set(event,handler),getSessionName:()=> 'Entry',
  appendEntry(customType,data){writes.push(data.ids);add({id:'state'+writes.length,type:'custom',customType,data});},
 },saved);
 const tui={terminal:{columns:75,rows:32},requestRender(){}};
 const ctx={mode:'tui',sessionManager:{getSessionId:()=> 'owner',getBranch:()=>[...branch]},ui:{
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
 hooks.get('session_start')({},ctx);
 const lines=()=>stack.at(-1).render(tui.terminal.columns).map(clean),screen=()=>lines().join('\n'),row=()=>lines().find(line=>line.startsWith('› '))?.trim();
 const press=async(...data)=>{for(const key of data){stack.at(-1).handleInput(key);await settle();if(stack.length)lines();}};
 const search=async text=>{await press('/','\x15',...text,'\x1b');};
 const track=promise=>{const run={finished:false,promise};promise.then(()=>run.finished=true);return run;};
 const after=async promise=>{const run=track(promise);await settle();if(stack.length)lines();return run;};
 return {writes,overlays,notices,inserted,lines,screen,row,press,search,tui,widgets,
  reset:()=>hooks.get('session_tree')({},ctx),
  start:args=>after(command.handler(args,ctx)),
  shelfClick:y=>{shelf.render(75);return after(Promise.resolve(shelf.handleMouse({type:'click',button:'left',x:5,y})));}};
}
test(`/pins opens Session at latest answer; Enter reads; p toggles in-place; copy/insert remain ordered`,async()=>{
 const s=session();const run=await s.start('');assert(s.lines()[0].includes('◉ Session'));assert(s.row().includes('assistant: # Answer 3'));
 await s.press('\r');assert.equal(s.lines()[0].trim(),'Pin');assert.deepEqual(s.writes,[]);
 await s.press('p');assert(!run.finished);assert.deepEqual(s.writes,[['a3']]);assert.equal(s.overlays.length,1);assert(s.lines()[1].includes('p unpin · c copy · i insert'));
 await s.press('p');assert.deepEqual(s.writes,[['a3'],[]]);assert(s.lines()[1].includes('p pin · c copy · i insert'));
 await s.press('\x1b','i');await run.promise;assert.deepEqual(s.inserted,[body(3)]);
});
test(`without an assistant answer, /pins opens at the newest listed message`,async()=>{
 const s=session({answers:3,replies:false,tools:[2],tail:false});const run=await s.start('');
 assert(s.row().includes('user: Question 2'));await s.press('\x1b');await run.promise;
});
test(`shelf opens Session pinned-only; Tab exclusively switches Session/All; foreign p never writes`,async()=>{
 const saved=async()=>[{id:'foreign',current:false,name:'Other',pins:sourcesOnBranch([{id:'x',parentId:null,timestamp:'2026-10-20T13:00:00Z',type:'message',message:{role:'assistant',content:[{type:'text',text:'Saved response'}],stopReason:'stop'}}])}];
 const s=session({pinned:['a0','a2'],saved});
 await s.shelfClick(2);assert(s.lines()[0].includes('◉ Session'));assert.match(s.screen(),/\(\d\/2\)/);assert(s.screen().includes('[labeled]'));
 await s.press('\t');await settle();assert(s.lines()[0].includes('◉ All'));await s.search('Saved response');await s.press('p');assert(s.screen().includes('read-only here'));
 await s.press('\t');assert(s.lines()[0].includes('◉ Session'));assert(!s.screen().includes('Search:'));await s.press('\x1b');
 assert.deepEqual(s.writes,[]);
});
test(`replacement cancel retains same browser/reader, query and offset; replacement succeeds without closing`,async()=>{
 const pinned=Array.from({length:LIMIT},(_,i)=>'a'+i),s=session({answers:LIMIT+1,pinned});const run=await s.start('');
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
 await s.press('p','\x1b[B','\r','r');assert(!run.finished);assert.equal(s.lines()[0].trim(),'Pin');assert.deepEqual(s.writes,[['a0','a3','a2']]);
 assert.equal(s.lines().at(-1),before.at(-1));assert(s.lines()[1].includes('p unpin · c copy · i insert'));
 await s.press('\x1b');assert(s.screen().includes('Search: Answer 3'));await s.press('\x1b');await run.promise;
});
test(`widget omits author prefixes while Session and All retain them`,async()=>{
 const s=session({pinned:['u0','a0','b0'],extra:[{id:'b0',type:'message',message:{role:'bashExecution',command:'npm test',output:'ok',exitCode:0,cancelled:false,truncated:false}}]});
 s.tui.terminal.columns=400;
 const labels=s.widgets.get('pins:shelf').render(400).slice(1).map(line=>clean(line).slice(5).trimEnd());
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
 const s=session({pinned:['a0','a2']}),shelf=s.widgets.get('pins:shelf');
 s.widgets.set('other',{render:()=>['Other widget']});
 const run=await s.start('');await s.press('p');
 assert.equal(s.widgets.get('pins:shelf'),shelf);assert.deepEqual([...s.widgets.keys()],['pins:shelf','other']);
 assert(shelf.render(75).map(clean).some(line=>line.includes('Answer 3')));
 await s.press('p');assert.equal(s.widgets.get('pins:shelf'),shelf);assert.deepEqual([...s.widgets.keys()],['pins:shelf','other']);
 assert(!shelf.render(75).map(clean).some(line=>line.includes('Answer 3')));
 await s.press('\x1b');await run.promise;
});
test(`cancelled discovery cannot update, report errors, or unlock a newer interaction`,async()=>{
 for(const fail of [false,true]){
  let resolve,reject,signal;
  const s=session({pinned:['a0'],saved:(_ctx,ownerSignal)=>{signal=ownerSignal;return new Promise((ok,no)=>{resolve=ok;reject=no;});}});
  const previous=await s.start('');await s.press('\t');s.reset();assert(signal.aborted);
  const browser=await s.start(''),shelf=s.widgets.get('pins:shelf').render(75);
  if(fail)reject(new Error('Late discovery failure'));else resolve([]);
  await previous.promise;await settle();
  assert.deepEqual(s.notices,[]);assert.deepEqual(s.widgets.get('pins:shelf').render(75),shelf);
  const opened=s.overlays.length;await(await s.start('')).promise;assert.equal(s.overlays.length,opened);assert(!browser.finished);
  await s.press('\x1b');await browser.promise;
 }
});
test(`a session change between choosing a replacement and saving it cancels the save`,async()=>{
 let s;
 s=session({pinned:['a0','a1','a2'],onDone:value=>{if(value?.kind==='replace')queueMicrotask(()=>s.reset());}});
 const run=await s.start('');
 await s.press('p','r');await run.promise;
 assert.deepEqual(s.writes,[]);
});
test(`list replacement commits once, while session changes cancel the pending task without saving`,async()=>{
 const s=session({answers:4,pinned:['a0','a1','a2']});let run=await s.start('');const selected=s.row();
 await s.press('p','r');
 assert(!run.finished);
 assert(selected.includes('assistant: # Answer 3'));
 assert(s.row().includes('[pinned] assistant: # Answer 3'));
 assert.deepEqual(s.writes,[['a3','a1','a2']]);
 await s.press('\x1b');await run.promise;
 run=await s.start('');await s.search('Answer 0');await s.press('p');assert(s.screen().includes('Replace with:'));
 s.reset();await run.promise;assert.deepEqual(s.writes,[['a3','a1','a2']]);
});
test('extension registers only the bare /pins command and stays inert outside the TUI',async()=>{
 const commands=new Map(),hooks=[],notices=[];
 extension({registerCommand:(name,command)=>commands.set(name,command),registerShortcut(){assert.fail('/pins is the only entry point');},on:(event,handler)=>{if(event==='session_start')hooks.push(handler);}});
 const ctx={mode:'rpc',hasUI:true,ui:{notify:(...args)=>notices.push(args)}};for(const hook of hooks)hook({},ctx);
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
 add('old-note',{type:'custom_message',customType:'old-note',content:'Previously pinned extension reference',display:true});
 add('new-state',{type:'custom',customType:PIN_STATE,data:{version:1,ids:['a0','bash-pinned','old-note']}});
 const before=JSON.stringify(branch);let command,opened=false;
 registerPins({registerCommand:(_name,value)=>{command=value;},on(){},getSessionName:()=>f.group.name,appendEntry(){assert.fail('Opening and filtering must not write pin state');}});
 const ctx={mode:'tui',sessionManager:{getSessionId:()=>f.group.id,getBranch:()=>branch},ui:{notify:message=>assert.fail(message),async custom(factory){
  opened=true;const c=factory({terminal:{columns:130,rows:65},requestRender(){}},theme,keys,()=>{});c.focused=true;
  const screen=()=>c.render(130).map(clean).join('\n');
  const search=text=>{c.handleInput('/');c.handleInput('\x05');c.handleInput('\x15');for(const ch of text)c.handleInput(ch);c.handleInput('\x1b');return screen();};
  try{
   assert.match(screen(),/\(\d+\/18\)/);
   for(const text of ['Compaction notes','ordinary extension','Branch summary sentinel','Extension role sentinel','Unpinned tool noise','Previously pinned'])assert.match(search(text),/\(0\/0\)/,text);
   assert.match(search('user command'),/\(1\/1\)/);search('');
   c.handleInput('\x0c');assert.match(screen(),/\(\d+\/2\) \[labeled\]/);
   c.handleInput('\t');assert.match(screen(),/\(\d+\/2\)/);
  }finally{c.dispose();}
 }}};
 await command.handler('',ctx);assert(opened);assert.equal(JSON.stringify(branch),before);
});
test('refresh failures clear an old shelf without writing a replacement snapshot',()=>{
 const hooks=new Map(),widgets=[],notices=[];
 let branch=[{id:'answer',type:'message',message:{role:'assistant',content:[{type:'text',text:'Reference'}]}},{id:'pins',type:'custom',customType:PIN_STATE,data:{version:1,ids:['answer']}}];
 registerPins({registerCommand(){},on:(name,handler)=>hooks.set(name,handler),getSessionName:()=> 'Example',appendEntry(){assert.fail('Must not overwrite invalid state');}});
 const ctx={mode:'tui',sessionManager:{getSessionId:()=> 'owner',getBranch:()=>branch},ui:{setWidget:(_name,widget)=>widgets.push(widget),notify:(...args)=>notices.push(args)}};
 hooks.get('session_start')({},ctx);assert.equal(typeof widgets.at(-1),'function');
 const original=TreeSelectorComponent.prototype.getTreeList;
 try{
  TreeSelectorComponent.prototype.getTreeList=function(){return Object.assign(original.call(this),{getEntryDisplayText:undefined});};
  const shelf=widgets.at(-1)({requestRender(){}},theme);assert.doesNotThrow(()=>shelf.render(75));
  hooks.get('session_tree')({},ctx);
  assert.equal(widgets.at(-1),undefined);assert.equal(notices.length,1);assert(notices[0][0].includes('unsupported Pi TreeList'));
 }finally{TreeSelectorComponent.prototype.getTreeList=original;}
 hooks.get('session_tree')({},ctx);assert.equal(typeof widgets.at(-1),'function');
 branch=[...branch,{id:'future',type:'custom',customType:PIN_STATE,data:{version:2,ids:[]}}];hooks.get('session_tree')({},ctx);
 assert.equal(widgets.at(-1),undefined);assert.equal(notices.length,2);assert(notices[1][0].includes('future'));
});
