import {sourcesOnBranch} from '../src/state.ts';
export const paragraphs=(title,n=35)=>`# ${title}\n\n`+Array.from({length:n},(_,i)=>`Step ${i+1}: verify the ${title.toLowerCase()} against the original source before changing anything.\n`).join('\n');
export const TIME='2026-10-21T12:00:00Z';
/** Row key of a fixture message: its identity. */
export const key=(id,time=TIME)=>`${id}@${time}`;
export function nativeFixture(){
 const entries=[],add=(id,entry)=>entries.push({id,parentId:entries.at(-1)?.id??null,timestamp:TIME,...entry});
 for(let i=0;i<8;i++){
  add('u'+i,{type:'message',message:{role:'user',content:`Question ${i}: verify the deployment recovery plan.`}});
  add('a'+i,{type:'message',message:{role:'assistant',content:[{type:'text',text:paragraphs(['Migration plan','Import diagnostics','Restore verification','Lease renewal','Release gate','Retry policy','Packaging notes','Rollout checklist'][i])}],stopReason:'stop'}});
 }
 add('bash-pinned',{type:'message',message:{role:'bashExecution',command:'npm run diagnostics',exitCode:0,cancelled:false,truncated:false,output:'Pinned diagnostic output\nFull output stays available.'}});
 add('tool-hidden',{type:'message',message:{role:'toolResult',toolName:'read',content:[{type:'text',text:'Unpinned tool noise'}]}});
 add('custom',{type:'custom_message',customType:'review',content:'An ordinary extension message with full content.',display:true});
 add('summary',{type:'compaction',summary:paragraphs('Compaction notes',5),tokensBefore:15000,firstKeptEntryId:'u0'});
 const messages=sourcesOnBranch(entries),pick=ids=>messages.filter(source=>ids.includes(source.id));
 // Messages of other sessions reuse this session's IDs but are different messages: their timestamps differ.
 const elsewhere=(ids,timestamp)=>sourcesOnBranch(pick(ids).map(source=>({...source.entry,timestamp})));
 const group={id:'01a14282-7ab5-7611-a501-000000000001',name:'Release verification',pins:pick(['a0','a4','bash-pinned'])};
 const foreign={id:'01a14282-7ab5-7611-a501-000000000002',name:'Recovery review',pins:elsewhere(['a0','a1','a4'],'2026-10-21T13:00:00Z')};
 const fork={id:'01a14282-7ab5-7611-a501-000000000003',pins:elsewhere(['a0','a1','a4'],'2026-10-21T14:00:00Z')};
 return {entries,messages,group,foreign,fork,view:{session:group,messages,all:[group,foreign,fork]}};
}
export function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
