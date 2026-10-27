import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as settle} from 'node:timers/promises';
import {stripVTControlCharacters as clean} from 'node:util';
import {initTheme} from '@earendil-works/pi-coding-agent';
import {getKeybindings,truncateToWidth} from '@earendil-works/pi-tui';
import {createBrowser,pinItems,pinKey,readingMemory} from '../src/browser.ts';
import {createTree,pinLabel} from '../src/tree.ts';
import {sourcesOnBranch} from '../src/state.ts';
import {freeze} from './native-fixtures.mjs';

const message=(role,content,extra={})=>({type:'message',message:{role,content,...extra}});
const entries=[
 message('assistant',[{type:'text',text:'One  '},{type:'text',text:'two\n\tthree'},{type:'toolCall',id:'call',name:'read',arguments:{path:'not part of the row'}}],{stopReason:'stop'}),
 message('user','## Heading\n\nKeep  internal\tspacing.\x1b[31m\u202e'),
 message('assistant',[{type:'text',text:'🦀'.repeat(102)+' omitted tail'}],{stopReason:'stop'}),
 message('assistant',[],{stopReason:'aborted',errorMessage:'Error text available to the reader'}),
 message('assistant',[],{stopReason:'error',errorMessage:'Error\n'+ 'detail '.repeat(30)}),
 message('bashExecution',undefined,{command:'printf "hello"\n\techo done\x1b[2J',output:'Full command output',exitCode:0,cancelled:false,truncated:false}),
 message('assistant','assistant: quoted opening',{stopReason:'stop'}),
 message('user','user: quoted opening'),
].map((entry,i)=>({id:`e${i}`,parentId:i?`e${i-1}`:null,timestamp:'2026-10-21T12:00:00Z',...entry}));
const sources=sourcesOnBranch(entries),group=freeze({id:'owner',current:true,pins:sources}),items=pinItems(group,sources);

test('pin labels equal native list text across roles, whitespace, Unicode and long content',()=>{
 initTheme('dark',false);
 const before=JSON.stringify(entries);
 for(const source of sources){
  const tree=createTree(items,'all','',pinKey(group.id,source.id));
  const row=clean(tree.render(4096,1)[0]).trimEnd();
  assert.equal(row,`› [pinned] ${pinLabel(source)}`,source.id);
 }
 assert.equal(pinLabel(sources[0]),'assistant: One  two  three');
 assert.equal(pinLabel(sources[0],false),'One  two  three');
 assert.equal(pinLabel(sources[1],false),'## Heading  Keep  internal spacing.');
 assert.equal(pinLabel(sources[3]),'assistant: (aborted)');
 assert.equal(pinLabel(sources[3],false),'(aborted)');
 assert.equal(pinLabel(sources[5]),'[bash]: printf "hello"  echo done');
 assert.equal(pinLabel(sources[5],false),pinLabel(sources[5]));
 assert.equal(pinLabel(sources[6],false),'assistant: quoted opening');
 assert.equal(pinLabel(sources[7],false),'user: quoted opening');
 assert.equal(JSON.stringify(entries),before);
});

test('copy confirmation and replacement heading use native label text without shortening the source',async()=>{
 initTheme('dark',false);
 const theme={fg:(_,text)=>text,bg:(_,text)=>text,bold:text=>text};
 for(const source of [sources[0],sources[2],sources[5]]){
  const expected=clean(createTree(items,'all','',pinKey(group.id,source.id)).render(4096,1)[0]).trimEnd().replace(/^› \[pinned\] /,'');
  let copied;
  const tui={terminal:{columns:75,rows:32},requestRender(){}};
  const options={tui,theme,keys:getKeybindings(),groups:[group],scope:'current',initial:pinKey(group.id,source.id),memory:readingMemory(),signal:new AbortController().signal,done(){}};
  const browser=createBrowser({...options,copy:async text=>copied=text});browser.focused=true;
  browser.render(75);browser.handleInput('c');await settle();assert.equal(copied,source.text);
  for(const width of [40,114]){
   tui.terminal.columns=width;
   assert(browser.render(width).map(clean).some(line=>line.trim()===clean(truncateToWidth(`Copied: ${expected}`,width-2,'…'))));
  }
  browser.dispose();
  const replacement=createBrowser({...options,memory:readingMemory(),replacementFor:source});replacement.focused=true;
  for(const width of [40,114]){
   tui.terminal.columns=width;
   assert.equal(clean(replacement.render(width)[0]).trim(),clean(truncateToWidth(`Replace with: ${expected}`,width-2,'…')));
  }
  replacement.dispose();
 }
});
