import {sourcesOnBranch,PIN_STATE,snapshot} from '../src/state.ts';
export const paragraphs=(title,n=35)=>`# ${title}\n\n`+Array.from({length:n},(_,i)=>`Step ${i+1}: verify the ${title.toLowerCase()} against the original source before changing anything.\n`).join('\n');
export function nativeFixture(){
 const entries=[],add=(id,entry)=>entries.push({id,parentId:entries.at(-1)?.id??null,timestamp:'2026-10-21T12:00:00Z',...entry});
 for(let i=0;i<8;i++){
  add('u'+i,{type:'message',message:{role:'user',content:`Question ${i}: verify the deployment recovery plan.`}});
  add('a'+i,{type:'message',message:{role:'assistant',content:[{type:'text',text:paragraphs(['Migration plan','Import diagnostics','Restore verification','Lease renewal','Release gate','Retry policy','Packaging notes','Rollout checklist'][i])}],stopReason:'stop'}});
 }
 add('bash-pinned',{type:'message',message:{role:'bashExecution',command:'npm run diagnostics',exitCode:0,cancelled:false,truncated:false,output:'Pinned diagnostic output\nFull output stays available.'}});
 add('tool-hidden',{type:'message',message:{role:'toolResult',toolName:'read',content:[{type:'text',text:'Unpinned tool noise'}]}});
 add('custom',{type:'custom_message',customType:'review',content:'An ordinary extension message with full content.',display:true});
 add('summary',{type:'compaction',summary:paragraphs('Compaction notes',5),tokensBefore:15000,firstKeptEntryId:'u0'});
 const ids=['a0','a4','bash-pinned'];
 add('state',{type:'custom',customType:PIN_STATE,data:snapshot(ids)});
 const sources=sourcesOnBranch(entries), messages=sources;
 const group={id:'01a14282-7ab5-7611-a501-000000000001',name:'Release verification',current:true,pins:sources.filter(source=>ids.includes(source.id))};
 const foreign={...group,id:'01a14282-7ab5-7611-a501-000000000002',current:false,name:'Recovery review',pins:sources.filter(source=>['a0','a1','a4'].includes(source.id))};
 const fork={...foreign,id:'01a14282-7ab5-7611-a501-000000000003',name:undefined};
 return {entries,messages,group,foreign,fork,groups:[group,foreign,fork]};
}
export function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
