import {inflateRawSync} from 'node:zlib';

export const WORKBOOK_LIMITS=Object.freeze({maxInputBytes:30*1024*1024,maxExpandedBytes:128*1024*1024,maxPartBytes:64*1024*1024,maxEntries:10000,maxSheets:256,maxRows:250000,maxColumns:16384,maxCells:5000000});

export class WorkbookLimitError extends Error {
  constructor(code,message,details=[]) {super(message);this.name='WorkbookLimitError';this.status=422;this.code=code;this.details=details;}
}
const fail=(code,message,details=[])=>{throw new WorkbookLimitError(code,message,details);};
function configuration(overrides) {
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw new TypeError('Workbook limits must be an object.');
  const limits={...WORKBOOK_LIMITS};
  for(const [key,value] of Object.entries(overrides)) {
    if(!Object.hasOwn(limits,key)||!Number.isSafeInteger(value)||value<0)throw new TypeError(`Invalid workbook limit: ${key}.`);
    limits[key]=value;
  }
  return limits;
}
function inputBuffer(bytes,limits) {
  let buffer;
  if(Buffer.isBuffer(bytes))buffer=bytes;
  else if(bytes instanceof Uint8Array)buffer=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  else if(bytes instanceof ArrayBuffer)buffer=Buffer.from(bytes);
  else fail('WORKBOOK_INPUT_INVALID','The workbook must contain binary file bytes.');
  if(buffer.length>limits.maxInputBytes)fail('WORKBOOK_INPUT_LIMIT','The workbook file exceeds the input byte limit.',[`File bytes: ${buffer.length}; allowed: ${limits.maxInputBytes}.`]);
  return buffer;
}
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes) {let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;}
const utf8=new TextDecoder('utf-8',{fatal:true});
function unicodeName(bytes) {try{return utf8.decode(bytes);}catch{fail('WORKBOOK_ZIP_NAME_INVALID','The workbook contains an invalid UTF-8 ZIP part name.');}}
function safeName(name) {
  const segments=name.split('/');
  if(!name||name.startsWith('/')||name.includes('\\')||/^[A-Za-z]:/.test(name)||/[\x00-\x1f\x7f]/.test(name)||segments.some((segment,index)=>segment==='.'||segment==='..'||(!segment&&index<segments.length-1)))fail('WORKBOOK_ZIP_PATH','The workbook contains an unsafe ZIP part path.',[name]);
  return name;
}
function extraFields(bytes,nameBytes) {
  let unicode;
  for(let position=0;position<bytes.length;) {
    if(position+4>bytes.length)fail('WORKBOOK_ZIP_STRUCTURE','The workbook contains a truncated ZIP extra field.');
    const id=bytes.readUInt16LE(position),size=bytes.readUInt16LE(position+2);position+=4;
    if(position+size>bytes.length)fail('WORKBOOK_ZIP_STRUCTURE','The workbook contains an invalid ZIP extra-field length.');
    const value=bytes.subarray(position,position+size);position+=size;
    if(id===1)fail('WORKBOOK_ZIP64_UNSUPPORTED','ZIP64 workbooks are not supported.');
    if(id===0x9901)fail('WORKBOOK_ZIP_ENCRYPTED','Encrypted ZIP workbooks are not supported.');
    if(id===0x7075&&size>=5&&value[0]===1) {
      const candidate=safeName(unicodeName(value.subarray(5)));
      if(value.readUInt32LE(1)===crc32(nameBytes)) {
        if(unicode!==undefined&&unicode!==candidate)fail('WORKBOOK_ZIP_NAME_INVALID','The workbook contains conflicting Unicode ZIP part names.');
        unicode=candidate;
      }
    }
  }
  return unicode;
}
function flagsAllowed(flags,method) {
  if(flags&(1|0x40|0x2000))fail('WORKBOOK_ZIP_ENCRYPTED','Encrypted ZIP workbooks are not supported.');
  if(flags&~0x080e||(!method&&(flags&6)))fail('WORKBOOK_ZIP_UNSUPPORTED','The workbook uses unsupported ZIP flags.');
  if(method!==0&&method!==8)fail('WORKBOOK_ZIP_METHOD','The workbook uses an unsupported ZIP compression method.',[`Method: ${method}; supported: stored (0), deflate (8).`]);
}
function scanXml(bytes,name) {
  if(!/\.(?:xml|rels|vml)$/i.test(name))return;
  if(bytes.length>=4&&((bytes[0]===0&&bytes[1]===0&&((bytes[2]===0xfe&&bytes[3]===0xff)||(bytes[2]===0&&bytes[3]===0x3c)))||(bytes[2]===0&&bytes[3]===0&&((bytes[0]===0xff&&bytes[1]===0xfe)||(bytes[0]===0x3c&&bytes[1]===0)))))fail('WORKBOOK_XML_ENCODING','The workbook contains an unsupported UTF-32 XML part.',[name]);
  const encoding=bytes[0]===0xfe&&bytes[1]===0xff||bytes[0]===0&&bytes[1]===0x3c?'utf-16be':bytes[0]===0xff&&bytes[1]===0xfe||bytes[0]===0x3c&&bytes[1]===0?'utf-16le':'utf-8';
  const decoder=new TextDecoder(encoding),pattern=/<!DOCTYPE|<!ENTITY/i;let tail='';
  for(let position=0;position<bytes.length;position+=65536) {
    const chunk=tail+decoder.decode(bytes.subarray(position,position+65536),{stream:true});
    if(pattern.test(chunk))fail('WORKBOOK_XML_DECLARATION','The workbook contains a prohibited XML document-type or entity declaration.',[name]);
    tail=chunk.slice(-16);
  }
  if(pattern.test(tail+decoder.decode()))fail('WORKBOOK_XML_DECLARATION','The workbook contains a prohibited XML document-type or entity declaration.',[name]);
}

/** Bound and validate a ZIP package before SheetJS/JSZip decompress it again.
 * Non-ZIP/legacy XLS inputs receive the byte cap only; their parser runs under
 * the caller's deadline. No content is changed and no files are extracted. */
export function assertWorkbookArchive(bytes,overrides={}) {
  const limits=configuration(overrides),buffer=inputBuffer(bytes,limits);
  if(buffer[0]!==0x50||buffer[1]!==0x4b)return;
  let end=-1;
  for(let position=buffer.length-22;position>=Math.max(0,buffer.length-65557);position--)if(buffer.readUInt32LE(position)===0x06054b50&&position+22+buffer.readUInt16LE(position+20)===buffer.length){end=position;break;}
  if(end<0)fail('WORKBOOK_ZIP_STRUCTURE','The workbook ZIP end record is missing or truncated.');
  const disk=buffer.readUInt16LE(end+4),directoryDisk=buffer.readUInt16LE(end+6),diskEntries=buffer.readUInt16LE(end+8),count=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),directoryStart=buffer.readUInt32LE(end+16);
  if(count===0xffff||diskEntries===0xffff||directorySize===0xffffffff||directoryStart===0xffffffff||(end>=20&&buffer.readUInt32LE(end-20)===0x07064b50))fail('WORKBOOK_ZIP64_UNSUPPORTED','ZIP64 workbooks are not supported.');
  if(disk||directoryDisk||diskEntries!==count)fail('WORKBOOK_ZIP_MULTIDISK','Multi-disk ZIP workbooks are not supported.');
  if(count>limits.maxEntries)fail('WORKBOOK_ZIP_ENTRY_LIMIT','The workbook contains too many ZIP parts.',[`Parts: ${count}; allowed: ${limits.maxEntries}.`]);
  if(directoryStart+directorySize!==end)fail('WORKBOOK_ZIP_STRUCTURE','The workbook ZIP directory boundaries are invalid.');
  const entries=[],names=new Set(),rawNames=new Set();let position=directoryStart,declaredTotal=0;
  for(let index=0;index<count;index++) {
    if(position+46>end||buffer.readUInt32LE(position)!==0x02014b50)fail('WORKBOOK_ZIP_STRUCTURE','The workbook contains a truncated or invalid ZIP directory entry.');
    const flags=buffer.readUInt16LE(position+8),method=buffer.readUInt16LE(position+10),crc=buffer.readUInt32LE(position+16),compressed=buffer.readUInt32LE(position+20),expanded=buffer.readUInt32LE(position+24),nameLength=buffer.readUInt16LE(position+28),extraLength=buffer.readUInt16LE(position+30),commentLength=buffer.readUInt16LE(position+32),entryDisk=buffer.readUInt16LE(position+34),local=buffer.readUInt32LE(position+42),next=position+46+nameLength+extraLength+commentLength;
    if(compressed===0xffffffff||expanded===0xffffffff||local===0xffffffff||entryDisk===0xffff)fail('WORKBOOK_ZIP64_UNSUPPORTED','ZIP64 workbooks are not supported.');
    if(entryDisk)fail('WORKBOOK_ZIP_MULTIDISK','Multi-disk ZIP workbooks are not supported.');
    flagsAllowed(flags,method);
    if(next>end)fail('WORKBOOK_ZIP_STRUCTURE','The workbook ZIP directory entry lengths are invalid.');
    const nameBytes=buffer.subarray(position+46,position+46+nameLength),rawName=safeName(flags&0x800?unicodeName(nameBytes):nameBytes.toString('latin1'));
    const name=extraFields(buffer.subarray(position+46+nameLength,position+46+nameLength+extraLength),nameBytes)??rawName;
    const rawKey=nameBytes.toString('hex');
    if(names.has(name)||rawNames.has(rawKey))fail('WORKBOOK_ZIP_DUPLICATE','The workbook contains duplicate ZIP part names.',[name]);
    names.add(name);rawNames.add(rawKey);
    if(expanded>limits.maxPartBytes)fail('WORKBOOK_ZIP_PART_LIMIT','A workbook ZIP part exceeds the expanded byte limit.',[`${name}: declared ${expanded}; allowed: ${limits.maxPartBytes}.`]);
    declaredTotal+=expanded;
    if(declaredTotal>limits.maxExpandedBytes)fail('WORKBOOK_ZIP_EXPANDED_LIMIT','The workbook exceeds the total expanded byte limit.',[`Declared expanded bytes: ${declaredTotal}; allowed: ${limits.maxExpandedBytes}.`]);
    entries.push({flags,method,crc,compressed,expanded,name,nameBytes,local});position=next;
  }
  if(position!==end)fail('WORKBOOK_ZIP_STRUCTURE','The workbook ZIP directory count does not match its contents.');
  const ranges=[];let actualTotal=0;
  for(const entry of entries) {
    const {local,compressed,expanded,name,flags,method,crc,nameBytes}=entry;
    if(local+30>directoryStart||buffer.readUInt32LE(local)!==0x04034b50)fail('WORKBOOK_ZIP_STRUCTURE','The workbook contains an invalid ZIP local header.',[name]);
    const localFlags=buffer.readUInt16LE(local+6),localMethod=buffer.readUInt16LE(local+8),localCrc=buffer.readUInt32LE(local+14),localCompressed=buffer.readUInt32LE(local+18),localExpanded=buffer.readUInt32LE(local+22),nameLength=buffer.readUInt16LE(local+26),extraLength=buffer.readUInt16LE(local+28),payloadStart=local+30+nameLength+extraLength,payloadEnd=payloadStart+compressed;
    if(localCompressed===0xffffffff||localExpanded===0xffffffff)fail('WORKBOOK_ZIP64_UNSUPPORTED','ZIP64 workbooks are not supported.');
    if(payloadEnd>directoryStart||localFlags!==flags||localMethod!==method||!buffer.subarray(local+30,local+30+nameLength).equals(nameBytes))fail('WORKBOOK_ZIP_STRUCTURE','The workbook local and central ZIP records disagree.',[name]);
    const alternate=extraFields(buffer.subarray(local+30+nameLength,payloadStart),nameBytes);
    if(alternate!==undefined&&alternate!==name)fail('WORKBOOK_ZIP_NAME_INVALID','The workbook local and central Unicode part names disagree.',[name]);
    if(flags&8?(localCrc!==0&&localCrc!==crc)||(localCompressed!==0&&localCompressed!==compressed)||(localExpanded!==0&&localExpanded!==expanded):localCrc!==crc||localCompressed!==compressed||localExpanded!==expanded)fail('WORKBOOK_ZIP_STRUCTURE','The workbook local and central ZIP sizes or checksums disagree.',[name]);
    let localEnd=payloadEnd;
    if(flags&8) {
      const matches=start=>start+12<=directoryStart&&buffer.readUInt32LE(start)===crc&&buffer.readUInt32LE(start+4)===compressed&&buffer.readUInt32LE(start+8)===expanded;
      if(payloadEnd+16<=directoryStart&&buffer.readUInt32LE(payloadEnd)===0x08074b50&&matches(payloadEnd+4))localEnd+=16;
      else if(matches(payloadEnd))localEnd+=12;
      else fail('WORKBOOK_ZIP_STRUCTURE','The workbook ZIP data descriptor is invalid.',[name]);
    }
    ranges.push({start:local,end:localEnd,name});
    const remaining=limits.maxExpandedBytes-actualTotal,budget=Math.min(limits.maxPartBytes,remaining),payload=buffer.subarray(payloadStart,payloadEnd);let actual;
    if(method===0)actual=payload;
    else {
      try {const result=inflateRawSync(payload,{maxOutputLength:Math.max(1,budget),info:true});actual=result.buffer;if(result.engine.bytesWritten!==payload.length)fail('WORKBOOK_ZIP_INVALID_DATA','The workbook ZIP part contains trailing compressed data.',[name]);}
      catch(error){if(error instanceof WorkbookLimitError)throw error;if(error.code==='ERR_BUFFER_TOO_LARGE')fail(remaining<limits.maxPartBytes?'WORKBOOK_ZIP_EXPANDED_LIMIT':'WORKBOOK_ZIP_PART_LIMIT','The workbook ZIP data exceeds the actual expanded byte limit.',[`${name}; output allowance: ${budget} bytes.`]);fail('WORKBOOK_ZIP_INVALID_DATA','The workbook contains invalid deflate data.',[`${name}: ${error.code||error.message}.`]);}
    }
    if(actual.length>limits.maxPartBytes)fail('WORKBOOK_ZIP_PART_LIMIT','A workbook ZIP part exceeds the actual expanded byte limit.',[name]);
    actualTotal+=actual.length;
    if(actualTotal>limits.maxExpandedBytes)fail('WORKBOOK_ZIP_EXPANDED_LIMIT','The workbook exceeds the actual total expanded byte limit.',[`Expanded bytes: ${actualTotal}; allowed: ${limits.maxExpandedBytes}.`]);
    if(actual.length!==expanded)fail('WORKBOOK_ZIP_SIZE_MISMATCH','The workbook ZIP part expanded size differs from its declaration.',[`${name}: declared ${expanded}; actual ${actual.length}.`]);
    if(crc32(actual)!==crc)fail('WORKBOOK_ZIP_CRC_MISMATCH','The workbook ZIP part checksum is invalid.',[name]);
    scanXml(actual,name);
  }
  ranges.sort((a,b)=>a.start-b.start);let cursor=0;
  for(const range of ranges){if(range.start!==cursor)fail('WORKBOOK_ZIP_STRUCTURE','The workbook contains overlapping or unlisted ZIP local data.',[range.name]);cursor=range.end;}
  if(cursor!==directoryStart)fail('WORKBOOK_ZIP_STRUCTURE','The workbook contains unlisted data before its ZIP directory.');
}

function cellCoordinate(column,row) {
  let number=0;for(const character of column.toUpperCase())number=number*26+character.charCodeAt(0)-64;
  const rowNumber=Number(row);
  return {column:number,row:rowNumber};
}
/** Validate the physical A1-bounded allocation used by sheet_to_json, rather
 * than just the small span of a sparse !ref beginning far below/right of A1. */
export function assertWorkbookModel(book,overrides={}) {
  const limits=configuration(overrides);
  if(!book||!Array.isArray(book.SheetNames)||!book.Sheets||typeof book.Sheets!=='object')fail('WORKBOOK_MODEL_INVALID','The workbook worksheet model is invalid.');
  if(book.SheetNames.length>limits.maxSheets||Object.keys(book.Sheets).length>limits.maxSheets)fail('WORKBOOK_SHEET_LIMIT','The workbook contains too many worksheets.',[`Worksheets: ${Math.max(book.SheetNames.length,Object.keys(book.Sheets).length)}; allowed: ${limits.maxSheets}.`]);
  const names=new Set();let total=0;
  for(const name of book.SheetNames) {
    if(typeof name!=='string'||!name||names.has(name)||!Object.hasOwn(book.Sheets,name)||!book.Sheets[name]||typeof book.Sheets[name]!=='object')fail('WORKBOOK_MODEL_INVALID','The workbook contains an invalid or duplicate worksheet.',[String(name)]);
    names.add(name);const reference=book.Sheets[name]['!ref'];if(reference===undefined||reference===null||reference==='')continue;
    const match=typeof reference==='string'&&reference.match(/^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]*))?$/);
    if(!match)fail('WORKBOOK_RANGE_INVALID','The workbook contains an invalid worksheet range.',[`${name}: ${String(reference)}.`]);
    const start=cellCoordinate(match[1],match[2]),end=cellCoordinate(match[3]||match[1],match[4]||match[2]);
    if(!Number.isSafeInteger(start.row)||!Number.isSafeInteger(end.row)||start.row>end.row||start.column>end.column||end.row>1048576||end.column>16384)fail('WORKBOOK_RANGE_INVALID','The workbook contains a reversed or non-Excel worksheet range.',[`${name}: ${reference}.`]);
    if(end.row>limits.maxRows)fail('WORKBOOK_ROW_LIMIT','The worksheet exceeds the physical row limit.',[`${name}: last row ${end.row}; allowed: ${limits.maxRows}.`]);
    if(end.column>limits.maxColumns)fail('WORKBOOK_COLUMN_LIMIT','The worksheet exceeds the physical column limit.',[`${name}: last column ${end.column}; allowed: ${limits.maxColumns}.`]);
    const cells=end.row*end.column;total+=cells;
    if(cells>limits.maxCells||total>limits.maxCells)fail('WORKBOOK_CELL_LIMIT','The workbook exceeds the bounded worksheet-cell allocation.',[`${name}: A1-bounded cells ${cells}; workbook total ${total}; allowed: ${limits.maxCells}.`]);
  }
}
