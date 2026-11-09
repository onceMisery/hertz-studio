// SPDX-License-Identifier: MIT
// Reuse the shipped Instrument Serif subset and its unmodified OFL notice.
'use strict';
const fs=require('node:fs'), path=require('node:path'), {createHash}=require('node:crypto');

const root=path.resolve(__dirname,'..');
const sourcePath='plugin/ui/fonts/brand.css', licensePath='plugin/ui/fonts/InstrumentSerif-OFL.txt';
const fixtureText='Hertz Studio';
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
function bounded(bytes,offset,length){
 if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset>bytes.length-length)
  throw new Error('Published font fixture has an invalid SFNT table range');
 return bytes.subarray(offset,offset+length);
}

// Only inspect the Unicode cmap needed to choose among published TTF subsets.
// Native format validation remains the responsibility of font_prepare.rs.
function unicodeGlyphs(bytes){
 bounded(bytes,0,12);
 if(bytes.readUInt32BE(0)!==0x00010000)throw new Error('Published font fixture is not a TTF');
 const tableCount=bytes.readUInt16BE(4);bounded(bytes,12,16*tableCount);
 let cmap=null, glyphCount=0;
 for(let index=0;index<tableCount;index++){
  const position=12+16*index, tag=bytes.toString('ascii',position,position+4);
  const table=bounded(bytes,bytes.readUInt32BE(position+8),bytes.readUInt32BE(position+12));
  if(tag==='cmap')cmap=table;
  if(tag==='maxp'){bounded(table,0,6);glyphCount=table.readUInt16BE(4);}
 }
 if(!cmap||glyphCount===0)throw new Error('Published font fixture lacks cmap or glyphs');
 bounded(cmap,0,4);
 const mappingCount=cmap.readUInt16BE(2);bounded(cmap,4,8*mappingCount);
 const mappings=[], seen=new Set();
 for(let index=0;index<mappingCount;index++){
  const position=4+8*index, platform=cmap.readUInt16BE(position), encoding=cmap.readUInt16BE(position+2);
  if(platform!==0&&(platform!==3||(encoding!==1&&encoding!==10)))continue;
  const offset=cmap.readUInt32BE(position+4);bounded(cmap,offset,2);
  if(seen.has(offset))continue;seen.add(offset);
  const format=cmap.readUInt16BE(offset);
  if(format===4){
   bounded(cmap,offset,4);
   const table=bounded(cmap,offset,cmap.readUInt16BE(offset+2));bounded(table,0,16);
   const count=table.readUInt16BE(6)/2;
   if(!Number.isInteger(count)||count===0)throw new Error('Published font fixture has an invalid cmap segment count');
   const end=14, start=end+2*count+2, delta=start+2*count, range=delta+2*count;
   bounded(table,end,8*count+2);
   mappings.push(scalar=>{
    if(scalar>0xffff)return 0;
    for(let segment=0;segment<count;segment++){
     const first=table.readUInt16BE(start+2*segment), last=table.readUInt16BE(end+2*segment);
     if(scalar<first||scalar>last)continue;
     const adjustment=table.readInt16BE(delta+2*segment), relative=table.readUInt16BE(range+2*segment);
     if(relative===0)return (scalar+adjustment)&0xffff;
     const position=range+2*segment+relative+2*(scalar-first);bounded(table,position,2);
     const glyph=table.readUInt16BE(position);return glyph===0?0:(glyph+adjustment)&0xffff;
    }
    return 0;
   });
  }else if(format===12){
   bounded(cmap,offset,16);
   const table=bounded(cmap,offset,cmap.readUInt32BE(offset+4)), count=table.readUInt32BE(12);
   bounded(table,16,12*count);
   mappings.push(scalar=>{
    for(let group=0;group<count;group++){
     const position=16+12*group, first=table.readUInt32BE(position), last=table.readUInt32BE(position+4);
     if(scalar>=first&&scalar<=last)return table.readUInt32BE(position+8)+scalar-first;
    }
    return 0;
   });
  }
 }
 if(mappings.length===0)throw new Error('Published font fixture lacks a supported Unicode cmap');
 return scalar=>mappings.map(mapping=>mapping(scalar)).find(glyph=>glyph>0&&glyph<glyphCount)||0;
}

function loadCompositionFontFixture({text=fixtureText}={}){
 if(typeof text!=='string'||text.length===0)throw new Error('Font fixture text must be a nonempty string');
 const cssBytes=fs.readFileSync(path.join(root,sourcePath)), css=cssBytes.toString('utf8');
 const licenseBytes=fs.readFileSync(path.join(root,licensePath)), licenseText=licenseBytes.toString('utf8');
 const sourceHeader=/\/\*[\s\S]*?\*\//.exec(css)?.[0];
 if(!sourceHeader?.includes('Instrument Serif')||!sourceHeader.includes('SIL OFL 1.1')||
    !licenseText.startsWith('Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)')||
    !licenseText.includes('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007'))
  throw new Error('Published font fixture is missing its Instrument Serif OFL provenance');
 const scalars=[...new Set(Array.from(text,character=>character.codePointAt(0)))].sort((a,b)=>a-b), candidates=[];
 let subsetIndex=0;
 for(const face of css.matchAll(/@font-face\s*\{([^}]*)\}/g)){
  const body=face[1], fontFamily=/font-family\s*:\s*["']([^"']+)["']\s*;/.exec(body)?.[1];
  for(const embedded of body.matchAll(/url\(\s*["']data:font\/ttf;base64,([A-Za-z0-9+/]+={0,2})["']\s*\)\s*format\(\s*["']truetype["']\s*\)/g)){
   const bytes=Buffer.from(embedded[1],'base64');
   if(bytes.toString('base64')!==embedded[1])throw new Error('Published font fixture has noncanonical base64');
   const glyph=unicodeGlyphs(bytes), coverage=scalars.map(scalar=>({scalar,glyphId:glyph(scalar)}));
   candidates.push({bytes,sha256:hash(bytes),fontFamily,subsetIndex:subsetIndex++,coverage});
  }
 }
 // Stable byte identity determines the subset, independent of CSS face order.
 const eligible=candidates.filter(candidate=>candidate.coverage.every(glyph=>glyph.glyphId!==0));
 eligible.sort((a,b)=>a.bytes.length-b.bytes.length||(a.sha256<b.sha256?-1:a.sha256>b.sha256?1:0)||a.subsetIndex-b.subsetIndex);
 const selected=eligible[0];
 if(!selected)throw new Error(`No published Instrument Serif TTF subset covers fixture text ${JSON.stringify(text)}`);
 if(selected.fontFamily!=='Hertz Instrument Serif')throw new Error('Published font fixture has an unexpected font family');
 const copyrightNotice=licenseText.split(/\r?\n/,1)[0];
 const license={id:'OFL-1.1',sourcePath:licensePath,file:'licenses/instrument-serif-ofl.txt',mime:'text/plain',
  bytes:licenseBytes,text:licenseText,sha256:hash(licenseBytes)};
 const provenance={sourcePath,sourceSha256:hash(cssBytes),sourceHeader,fontFamily:selected.fontFamily,
  subsetIndex:selected.subsetIndex,fontSha256:selected.sha256,mime:'font/ttf',format:'ttf',
  licenseId:license.id,licenseSourcePath:licensePath,licenseSha256:license.sha256,copyrightNotice,
  fixtureText:text,glyphCoverage:selected.coverage};
 const provenanceBytes=Buffer.from(JSON.stringify(provenance,null,2)+'\n');
 const packageFiles=[{file:license.file,mime:license.mime,bytes:license.bytes,sha256:license.sha256},
  {file:'licenses/instrument-serif-provenance.json',mime:'application/json',bytes:provenanceBytes,sha256:hash(provenanceBytes)}];
 return {bytes:selected.bytes,byteLength:selected.bytes.length,sha256:selected.sha256,mime:'font/ttf',format:'ttf',file:'font.ttf',
  text,license,provenance,packageFiles,manifestLicense:{assets:'OFL-1.1 (Instrument Serif font)',attribution:copyrightNotice}};
}

module.exports={loadCompositionFontFixture};
