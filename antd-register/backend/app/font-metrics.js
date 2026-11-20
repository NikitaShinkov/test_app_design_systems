import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Read only trusted, pinned packaged fonts. These advance metrics are a bounded
// layout estimate, not Excel AutoFit, shaping or installed-font discovery.
export function readSfntMetrics(bytes,{family='Liberation Sans',face='Regular'}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length<64||bytes.length>2*1024*1024||bytes.readUInt32BE(0)!==0x00010000)throw Error('Unsupported bounded static TTF.');
  const count=bytes.readUInt16BE(4);if(count<1||count>128||12+16*count>bytes.length)throw Error('Invalid TTF table directory.');
  const tables=new Map();
  for(let index=0;index<count;index++){const at=12+16*index,tag=bytes.toString('ascii',at,at+4),offset=bytes.readUInt32BE(at+8),length=bytes.readUInt32BE(at+12);if(offset>bytes.length||length>bytes.length-offset||tables.has(tag))throw Error('Invalid TTF table bounds.');tables.set(tag,bytes.subarray(offset,offset+length));}
  if(tables.has('fvar'))throw Error('Variable-font instances require a separate measured profile.');
  const need=(tag,min)=>{const table=tables.get(tag);if(!table||table.length<min)throw Error('Missing bounded '+tag+' metric table.');return table;};
  const head=need('head',20),hhea=need('hhea',36),maxp=need('maxp',6),hmtx=need('hmtx',4),cmap=need('cmap',4),unitsPerEm=head.readUInt16BE(18),glyphs=maxp.readUInt16BE(4),metrics=hhea.readUInt16BE(34);
  if(unitsPerEm<16||unitsPerEm>16384||!glyphs||!metrics||metrics>glyphs||metrics*4>hmtx.length)throw Error('Invalid TTF metric counts.');
  const choices=[];for(let index=0;index<cmap.readUInt16BE(2);index++){const at=4+index*8;if(at+8>cmap.length)throw Error('Invalid cmap record.');const platform=cmap.readUInt16BE(at),encoding=cmap.readUInt16BE(at+2),offset=cmap.readUInt32BE(at+4);if(offset+2>cmap.length)throw Error('Invalid cmap offset.');const format=cmap.readUInt16BE(offset);if((platform===0||platform===3&&[1,10].includes(encoding))&&[4,12].includes(format))choices.push({format,offset});}
  choices.sort((left,right)=>right.format-left.format);const choice=choices[0];if(!choice)throw Error('No supported Unicode cmap.');
  const table=cmap.subarray(choice.offset),format=choice.format;
  let lookup;
  if(format===12){
    if(table.length<16)throw Error('Invalid cmap12.');const length=table.readUInt32BE(4),groups=table.readUInt32BE(12);if(length>table.length||groups>65536||16+groups*12>length)throw Error('Invalid cmap12 groups.');
    lookup=code=>{let low=0,high=groups-1;while(low<=high){const middle=(low+high)>>1,at=16+middle*12,start=table.readUInt32BE(at),end=table.readUInt32BE(at+4);if(code<start)high=middle-1;else if(code>end)low=middle+1;else return table.readUInt32BE(at+8)+code-start;}return 0;};
  }else{
    if(table.length<16)throw Error('Invalid cmap4.');const length=table.readUInt16BE(2),segments=table.readUInt16BE(6)/2,endAt=14,startAt=endAt+segments*2+2,deltaAt=startAt+segments*2,rangeAt=deltaAt+segments*2;if(!Number.isInteger(segments)||segments<1||length>table.length||rangeAt+segments*2>length)throw Error('Invalid cmap4 segments.');
    lookup=code=>{if(code>65535)return 0;let low=0,high=segments-1;while(low<=high){const middle=(low+high)>>1;if(code>table.readUInt16BE(endAt+middle*2))low=middle+1;else high=middle-1;}if(low>=segments||code<table.readUInt16BE(startAt+low*2))return 0;const delta=table.readInt16BE(deltaAt+low*2),range=table.readUInt16BE(rangeAt+low*2);if(!range)return (code+delta)&65535;const at=rangeAt+low*2+range+2*(code-table.readUInt16BE(startAt+low*2));if(at+2>length)throw Error('Invalid cmap4 glyph offset.');const glyph=table.readUInt16BE(at);return glyph?(glyph+delta)&65535:0;};
  }
  const hheaHeight=hhea.readInt16BE(4)-hhea.readInt16BE(6)+Math.max(0,hhea.readInt16BE(8)),os2=tables.get('OS/2');
  const lineUnits=Math.max(unitsPerEm,hheaHeight,os2?.length>=78?os2.readUInt16BE(74)+os2.readUInt16BE(76):0,os2?.length>=78?os2.readInt16BE(68)-os2.readInt16BE(70)+Math.max(0,os2.readInt16BE(72)):0);
  const advance=code=>{const glyph=lookup(code);return glyph>0&&glyph<glyphs?hmtx.readUInt16BE(Math.min(glyph,metrics-1)*4)/unitsPerEm:null;};
  return Object.freeze({family,face,sha256:createHash('sha256').update(bytes).digest('hex'),unitsPerEm,lineEm:lineUnits/unitsPerEm,advanceEm:advance});
}

export async function loadBundledProfiles(appRoot){
  if(appRoot instanceof URL)appRoot=fileURLToPath(appRoot);
  const directory=path.join(appRoot,'public/vendor/pdfjs/6.5.438/standard_fonts'),faces={};
  const fingerprints={Regular:'f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f',Bold:'361c61b82d575c5c35fd9157fda8b0194bcfcd0d88ea8521a4fb5dd53d33dddc',Italic:'832b4406dbef23628800d3aaad21048534ac84d7e3ad955be83b8172ed8ef512',BoldItalic:'a224075ac17495ad0a3af3bc0a419ac0704a8b3fd1095456201fb9b095fc281d'};
  for(const face of ['Regular','Bold','Italic','BoldItalic']){faces[face]=readSfntMetrics(await fs.readFile(path.join(directory,`LiberationSans-${face}.ttf`)),{face});if(faces[face].sha256!==fingerprints[face])throw Error('The packaged layout font differs from its reviewed metric profile.');}
  const resolve=font=>{
    const name=String(font?.name||'Calibri'),face=font?.bold?(font?.italic?'BoldItalic':'Bold'):(font?.italic?'Italic':'Regular');
    // OOXML documents rendered Normal Calibri11 digits as7px at96dpi. A
    // substitute font's unhinted advances cannot supply that width basis.
    const documentedNormal=/^Calibri$/i.test(font?.name||'')&&font?.size===11&&face==='Regular';
    return {metrics:faces[face],sourceFamily:name,substituted:!/^Liberation Sans$/i.test(name),nativeCalibrationRequired:!/^Liberation Sans$/i.test(name),...(documentedNormal?{maximumDigitPixelsAt96Dpi:7}:{})};
  };
  return Object.freeze({faces:Object.freeze(faces),resolve});
}
