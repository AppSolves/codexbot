import { posix } from 'node:path';
import { requireCondition } from './errors.js';
import type { ChangedFile } from './review.js';
import type { gitSource } from './git-source.js';

export interface BinaryChange { filename:string; status:string; format:string; inspection:'requires-model'; snapshots:{side:'base'|'head';path:string;sha:string;bytes:number}[] }
export const MAX_BINARY_BYTES=8_000_000, MAX_BINARY_FILE_BYTES=2_000_000;
/** Format framing only: no decompression, rendering, execution or visual-review claim. */
function imageFormat(bytes:Buffer):string|null {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    let offset=8,chunks=0,idat=false;
    while(offset+12<=bytes.length&&++chunks<=4096){
      const size=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);if(size>bytes.length-offset-12)return null;
      if(chunks===1&&(kind!=='IHDR'||size!==13||!bytes.readUInt32BE(offset+8)||!bytes.readUInt32BE(offset+12)||bytes.readUInt32BE(offset+8)*bytes.readUInt32BE(offset+12)>16_000_000))return null;
      if(kind==='IDAT')idat=true;offset+=size+12;
      if(kind==='IEND')return size===0&&offset===bytes.length&&idat?'png':null;
    }return null;
  }
  return null;
}
export async function binaryChange(file:ChangedFile,base:string,head:string,source:ReturnType<typeof gitSource>,budget:{bytes:number;shas:Set<string>}):Promise<BinaryChange> {
  requireCondition(!file.patch,'context_text_patch_truncated');
  const sides:('base'|'head')[]=file.status==='added'?['head']:file.status==='removed'?['base']:['base','head'];
  requireCondition(['added','removed','modified','renamed'].includes(file.status),'context_unsupported_binary');
  const snapshots:BinaryChange['snapshots']=[];let format='';
  for(const side of sides){
    const path=side==='base'?(file.previous_filename??file.filename):file.filename;
    const entry=await source.find(side==='base'?base:head,path);
    requireCondition(entry?.type==='blob'&&entry.mode==='100644'&&entry.sha,'context_binary_unverifiable');
    requireCondition(entry.size!==undefined&&entry.size<=MAX_BINARY_FILE_BYTES,'context_binary_size_limit');
    const bytes=await source.read(entry,MAX_BINARY_FILE_BYTES);
    if(!budget.shas.has(entry.sha)){budget.shas.add(entry.sha);budget.bytes+=bytes.length;}
    requireCondition(budget.bytes<=MAX_BINARY_BYTES,'context_binary_size_limit');
    const kind=imageFormat(bytes),extension=posix.extname(path).toLowerCase();
    requireCondition(kind==='png'&&extension==='.png','context_unsupported_binary');
    format=kind;snapshots.push({side,path,sha:entry.sha,bytes:bytes.length});
  }
  return {filename:file.filename,status:file.status,format,inspection:'requires-model',snapshots};
}

export function binaryLocations(files:BinaryChange[]):Set<string>{return new Set(files.flatMap(file=>file.snapshots.map(snapshot=>`${snapshot.side==='base'?'LEFT':'RIGHT'}:${file.filename}`)));}
