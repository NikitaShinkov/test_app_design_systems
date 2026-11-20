import JSZip from 'jszip';
import {DOMParser} from '@xmldom/xmldom';
import {crc32,inflateSync} from 'node:zlib';
import {assertWorkbookArchive} from './workbook-limits.js';

export const ATTACHMENT_LIMITS=Object.freeze({maxBytes:30*1024*1024,maxImageDimension:32768,maxImagePixels:40000000,maxDecodedImageBytes:64*1024*1024,maxImageChunks:10000,maxCsvRows:250000,maxCsvColumns:16384,maxCsvCells:5000000,maxCsvFieldChars:1024*1024,maxMetadataXmlBytes:1024*1024,maxXmlHeaderBytes:65536});
const MIME=Object.freeze({pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',csv:'text/csv',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'});
const roles=['Supplier_Datasheet','Client_Datasheet','Supporting_Document'];
const actorRoles=new Set(['ADMINISTRATOR','SUPPLIER','CLIENT']);
export class AttachmentPolicyError extends Error {
  constructor(code,message,details=[],status=422){super(message);this.name='AttachmentPolicyError';this.code=code;this.status=status;this.details=details;}
}
const fail=(code,message,details=[],status=422)=>{throw new AttachmentPolicyError(code,message,details,status);};
function filenameFor(value) {
  if(typeof value!=='string'||/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value))fail('ATTACHMENT_FILENAME_INVALID','Choose a valid attachment file name.');
  const filename=value.normalize('NFC').trim();
  if(!filename||filename.length>180||/[. ]$/.test(filename)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)||filename==='.'||filename==='..')fail('ATTACHMENT_FILENAME_INVALID','Choose a valid attachment file name.');
  const extension=filename.match(/\.([^.]+)$/)?.[1].toLowerCase();
  if(!Object.hasOwn(MIME,extension||''))fail('ATTACHMENT_TYPE_UNSUPPORTED','Allowed attachments are PDF, XLSX, DOCX, CSV, PNG and JPEG.',[filename]);
  return {filename,extension,contentType:MIME[extension]};
}
function binary(bytes) {
  const buffer=Buffer.isBuffer(bytes)?bytes:bytes instanceof Uint8Array?Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength):bytes instanceof ArrayBuffer?Buffer.from(bytes):null;
  if(!buffer||!buffer.length)fail('ATTACHMENT_EMPTY','Choose a non-empty attachment.');
  if(buffer.length>ATTACHMENT_LIMITS.maxBytes)fail('ATTACHMENT_SIZE_LIMIT','The attachment exceeds the file byte limit.',[`Bytes: ${buffer.length}; allowed: ${ATTACHMENT_LIMITS.maxBytes}.`]);
  return buffer;
}
function metadataFor(options,context) {
  const source=context?.role;
  if(!actorRoles.has(source))fail('ATTACHMENT_ACTOR_FORBIDDEN','This user cannot upload attachments.',[],403);
  const fallback=source==='SUPPLIER'?'Supplier_Datasheet':source==='CLIENT'?'Client_Datasheet':'Supporting_Document';
  const value=options.role===undefined||options.role===null||options.role===''?fallback:options.role;
  const attachmentRole=typeof value==='string'?roles.find(role=>role.toLowerCase()===value.trim().toLowerCase()):undefined;
  if(!attachmentRole)fail('ATTACHMENT_ROLE_INVALID','Select a valid attachment role.');
  if(source!=='ADMINISTRATOR'&&attachmentRole!==fallback)fail('ATTACHMENT_ROLE_FORBIDDEN','The selected attachment role is not available to this user.',[],403);
  const confidentiality=options.confidentiality===undefined||options.confidentiality===null||options.confidentiality===''?'ORDER_PARTICIPANTS':typeof options.confidentiality==='string'?options.confidentiality.trim().toUpperCase():'';
  if(!['ORDER_PARTICIPANTS','ADMINISTRATORS'].includes(confidentiality))fail('ATTACHMENT_CONFIDENTIALITY_INVALID','Select a valid attachment confidentiality level.');
  if(confidentiality==='ADMINISTRATORS'&&source!=='ADMINISTRATOR')fail('ATTACHMENT_CONFIDENTIALITY_FORBIDDEN','Only an administrator can upload an administrators-only attachment.',[],403);
  const rawDescription=options.description??'';
  if(typeof rawDescription!=='string'||rawDescription.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawDescription))fail('ATTACHMENT_DESCRIPTION_INVALID','The attachment description must be text of at most 2,000 characters without control characters.');
  const description=rawDescription.normalize('NFC').replace(/\r\n?/g,'\n').trim();
  const previous=options.supersedesArtifactId;
  if(previous!==undefined&&previous!==null&&previous!==''&&(typeof previous!=='string'||!/^\s*[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\s*$/i.test(previous)))fail('ATTACHMENT_SUPERSESSION_INVALID','The superseded attachment must be identified by a valid UUID.');
  const supersedesArtifactId=previous?previous.trim().toLowerCase():null;
  return {attachmentRole,source,description,confidentiality,supersedesArtifactId};
}
function mimeFor(declared,expected) {
  if(declared===undefined||declared===null||declared==='')return;
  if(typeof declared!=='string'||declared.length>250)fail('ATTACHMENT_MIME_MISMATCH','The declared MIME type does not match the file extension.',[`Expected: ${expected}.`]);
  const [type,...parameters]=declared.toLowerCase().split(';').map(value=>value.trim());
  if(type!==expected||(expected==='text/csv'&&parameters.some(parameter=>/^charset\s*=/.test(parameter)&&!/^charset\s*=\s*["']?utf-?8["']?$/.test(parameter))))fail('ATTACHMENT_MIME_MISMATCH','The declared MIME type does not match the file extension or UTF-8 CSV encoding.',[`Declared: ${declared}; expected: ${expected}.`]);
}
const invalid=(kind,detail)=>fail('ATTACHMENT_CONTENT_MISMATCH',`The file is not a supported ${kind} attachment.`,detail?[detail]:[]);
function dimensions(width,height,decoded) {
  if(!width||!height||width>ATTACHMENT_LIMITS.maxImageDimension||height>ATTACHMENT_LIMITS.maxImageDimension||width*height>ATTACHMENT_LIMITS.maxImagePixels||decoded>ATTACHMENT_LIMITS.maxDecodedImageBytes)fail('ATTACHMENT_IMAGE_LIMIT','The image exceeds the dimension, pixel or decoded-byte limit.',[`${width} × ${height}; estimated decoded bytes: ${decoded}.`]);
}
function png(bytes) {
  if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))invalid('PNG');
  let position=8,chunks=0,header,ended=false,seenIdat=false,idatEnded=false,palette=false;const data=[];
  while(position<bytes.length) {
    if(++chunks>ATTACHMENT_LIMITS.maxImageChunks)fail('ATTACHMENT_IMAGE_LIMIT','The image contains too many chunks.');
    if(position+12>bytes.length)invalid('PNG','Truncated chunk header.');
    const length=bytes.readUInt32BE(position),type=bytes.subarray(position+4,position+8).toString('ascii'),end=position+12+length;
    if(end>bytes.length||!/^[A-Za-z]{4}$/.test(type))invalid('PNG','Invalid chunk length or name.');
    if(crc32(bytes.subarray(position+4,end-4))!==bytes.readUInt32BE(end-4))invalid('PNG',`${type}: invalid chunk checksum.`);
    const value=bytes.subarray(position+8,end-4);
    if(!header&&type!=='IHDR')invalid('PNG','IHDR must be the first chunk.');
    if(type==='IHDR') {
      if(header||length!==13)invalid('PNG','Invalid or repeated IHDR.');
      const width=value.readUInt32BE(),height=value.readUInt32BE(4),depth=value[8],color=value[9],channels=({0:1,2:3,3:1,4:2,6:4})[color],depths=({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[color];
      if(!channels||!depths.includes(depth)||value[10]||value[11]||value[12]>1)invalid('PNG','Unsupported IHDR values.');
      const passes=value[12]?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
      const rows=passes.map(([x,y,dx,dy])=>({width:Math.max(0,Math.ceil((width-x)/dx)),height:Math.max(0,Math.ceil((height-y)/dy))})).filter(pass=>pass.width&&pass.height).map(pass=>({...pass,stride:1+Math.ceil(pass.width*channels*depth/8)}));
      const expanded=rows.reduce((sum,pass)=>sum+pass.height*pass.stride,0);dimensions(width,height,expanded);header={color,depth,expanded,rows};
    } else if(type==='PLTE') {
      if(palette||seenIdat||!length||length%3||length>768||[0,4].includes(header.color)||(header.color===3&&length/3>2**header.depth))invalid('PNG','Invalid palette.');palette=true;
    } else if(type==='IDAT') {
      if(idatEnded||(header.color===3&&!palette))invalid('PNG','Invalid image-data order or missing palette.');seenIdat=true;data.push(value);
    } else if(type==='IEND') {
      if(length||!seenIdat||end!==bytes.length)invalid('PNG','Invalid final IEND or missing image data.');ended=true;position=end;break;
    } else {
      if(['acTL','fcTL','fdAT'].includes(type))fail('ATTACHMENT_IMAGE_UNSUPPORTED','Animated PNG attachments are not supported.');
      if(type[0]===type[0].toUpperCase())invalid('PNG',`Unsupported critical chunk: ${type}.`);
      if(seenIdat)idatEnded=true;
    }
    position=end;
  }
  if(!ended)invalid('PNG','Missing IEND.');
  let decoded;try{const compressed=Buffer.concat(data),result=inflateSync(compressed,{maxOutputLength:Math.max(1,Math.min(ATTACHMENT_LIMITS.maxDecodedImageBytes,header.expanded+1)),info:true});decoded=result.buffer;if(result.engine.bytesWritten!==compressed.length||decoded.length!==header.expanded)invalid('PNG','Image-data length differs from IHDR.');}
  catch(error){if(error instanceof AttachmentPolicyError)throw error;invalid('PNG','Invalid or excessive compressed image data.');}
  let offset=0;for(const pass of header.rows)for(let row=0;row<pass.height;row++,offset+=pass.stride)if(decoded[offset]>4)invalid('PNG','Invalid scanline filter.');
}
function jpeg(bytes) {
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)invalid('JPEG');
  let position=2,markers=0,frame=false,scans=0;
  while(position<bytes.length) {
    if(++markers>ATTACHMENT_LIMITS.maxImageChunks)fail('ATTACHMENT_IMAGE_LIMIT','The image contains too many JPEG markers.');
    if(bytes[position++]!==255)invalid('JPEG','Expected a JPEG marker.');
    while(bytes[position]===255)position++;
    if(position>=bytes.length)invalid('JPEG','Truncated marker.');
    const marker=bytes[position++];
    if(marker===217){if(!frame||!scans||position!==bytes.length)invalid('JPEG','Invalid final EOI or missing frame/scan.');return;}
    if(marker===1)continue;
    if(!marker||marker===216||(marker>=208&&marker<=215)||position+2>bytes.length)invalid('JPEG','Invalid marker order.');
    const length=bytes.readUInt16BE(position),end=position+length;if(length<2||end>bytes.length)invalid('JPEG','Invalid JPEG segment length.');
    if([192,193,194].includes(marker)) {
      if(frame||length<8)invalid('JPEG','Invalid or repeated frame header.');
      const precision=bytes[position+2],height=bytes.readUInt16BE(position+3),width=bytes.readUInt16BE(position+5),components=bytes[position+7];
      if(precision!==8||![1,3,4].includes(components)||length!==8+3*components)fail('ATTACHMENT_IMAGE_UNSUPPORTED','Only ordinary 8-bit grayscale/RGB/CMYK JPEG attachments are supported.');
      dimensions(width,height,width*height*4);frame={components};
    } else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))fail('ATTACHMENT_IMAGE_UNSUPPORTED','This JPEG frame encoding is not supported.');
    if(marker===218) {
      const components=bytes[position+2];if(!frame||!components||components>frame.components||length!==6+2*components)invalid('JPEG','Invalid scan header.');scans++;
      position=end;let next=-1;
      while(position<bytes.length) {
        if(bytes[position++]!==255)continue;
        const start=position-1;while(bytes[position]===255)position++;
        if(position>=bytes.length)invalid('JPEG','Truncated entropy data.');
        const value=bytes[position++];if(value===0||(value>=208&&value<=215))continue;next=start;break;
      }
      if(next<0)invalid('JPEG','Missing final EOI.');position=next;
    } else position=end;
  }
  invalid('JPEG','Missing final EOI.');
}
function csv(bytes) {
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{invalid('UTF-8 CSV','The file is not valid UTF-8.');}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))invalid('UTF-8 CSV','The file contains NUL or unsupported control characters.');
  if(/^\s*(?:<!doctype\s+html|<html\b|<svg\b|<script\b|<iframe\b|<\?xml\b|#!)/i.test(text))fail('ATTACHMENT_ACTIVE_CONTENT','HTML, SVG, XML and executable scripts cannot be uploaded as CSV.');
  let rows=0,cells=0,columns=1,length=0,quoted=false,closed=false,fieldStart=true;
  const field=()=>{if(++cells>ATTACHMENT_LIMITS.maxCsvCells||columns>ATTACHMENT_LIMITS.maxCsvColumns||length>ATTACHMENT_LIMITS.maxCsvFieldChars)fail('ATTACHMENT_CSV_LIMIT','The CSV exceeds its cell, column or field-length limit.');length=0;closed=false;fieldStart=true;};
  const row=()=>{field();if(++rows>ATTACHMENT_LIMITS.maxCsvRows)fail('ATTACHMENT_CSV_LIMIT','The CSV contains too many rows.');columns=1;};
  for(let index=0;index<text.length;index++) {
    const character=text[index];
    if(quoted){if(character==='"'){if(text[index+1]==='"'){index++;length++;}else{quoted=false;closed=true;}}else length++;}
    else if(character===','){field();columns++;}
    else if(character==='\r'||character==='\n'){if(character==='\r'&&text[index+1]==='\n')index++;row();}
    else if(character==='"'&&fieldStart){quoted=true;fieldStart=false;}
    else{if(closed||character==='"')invalid('UTF-8 CSV','Malformed quoted field.');fieldStart=false;length++;}
    if(length>ATTACHMENT_LIMITS.maxCsvFieldChars)fail('ATTACHMENT_CSV_LIMIT','A CSV field exceeds the character limit.');
  }
  if(quoted)invalid('UTF-8 CSV','Unclosed quoted field.');
  if(text.length&&!/[\r\n]$/.test(text))row();
}
const packageNamespace='http://schemas.openxmlformats.org/package/2006/content-types';
function parseXml(bytes,part) {
  if(bytes.length>ATTACHMENT_LIMITS.maxMetadataXmlBytes)fail('ATTACHMENT_OOXML_LIMIT','An Office metadata XML part exceeds its byte limit.',[part]);
  try{const text=decodeXml(bytes);return new DOMParser({onError:(level,message)=>{throw new Error(`${level}: ${message}`);}}).parseFromString(text,'application/xml');}
  catch{fail('ATTACHMENT_OOXML_INVALID','The Office attachment contains invalid metadata XML.',[part]);}
}
function decodeXml(bytes,stream=false) {const encoding=bytes[0]===0xfe&&bytes[1]===0xff||bytes[0]===0&&bytes[1]===0x3c?'utf-16be':bytes[0]===0xff&&bytes[1]===0xfe||bytes[0]===0x3c&&bytes[1]===0?'utf-16le':'utf-8';return new TextDecoder(encoding,{fatal:true}).decode(bytes,{stream});}
async function ooxml(bytes,extension) {
  assertWorkbookArchive(bytes);
  if(bytes[0]!==80||bytes[1]!==75)invalid(extension.toUpperCase(),'An Office Open XML ZIP package is required.');
  const zip=await JSZip.loadAsync(bytes),names=Object.keys(zip.files).filter(name=>!zip.files[name].dir);
  if(names.some(name=>/(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|activeX|embeddings|customUI|macros|scripts)(?:\/|$)|\.(?:exe|dll|com|bat|cmd|ps1|vbs|js|hta|html?|svg)$/i.test(name)))fail('ATTACHMENT_ACTIVE_CONTENT','Office attachments must be macro-free and cannot contain active embedded files.');
  const main=extension==='xlsx'?'xl/workbook.xml':'word/document.xml',other=extension==='xlsx'?'word/document.xml':'xl/workbook.xml';
  const expectedType=extension==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml':'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  if(!zip.file('[Content_Types].xml')||!zip.file('_rels/.rels')||!zip.file(main)||names.some(name=>name.toLowerCase()===other))invalid(extension.toUpperCase(),'The package has missing or conflicting Office main parts.');
  const types=parseXml(await zip.file('[Content_Types].xml').async('nodebuffer'),'[Content_Types].xml'),root=types.documentElement;
  if(root.localName!=='Types'||root.namespaceURI!==packageNamespace)invalid(extension.toUpperCase(),'Invalid package content-type root.');
  const declarations=[...root.childNodes].filter(node=>node.nodeType===1);
  if(declarations.some(node=>node.namespaceURI!==packageNamespace||!['Default','Override'].includes(node.localName)))invalid(extension.toUpperCase(),'Invalid package content-type declarations.');
  if(declarations.some(node=>/macroenabled|vbaproject|vbaData|activex|oleobject|svg\+xml|text\/html|x-msdownload/i.test(node.getAttribute('ContentType')||'')))fail('ATTACHMENT_ACTIVE_CONTENT','Office attachments must be macro-free and cannot declare active embedded content.');
  const mainTypes=declarations.filter(node=>/\.main\+xml$/i.test(node.getAttribute('ContentType')||''));
  if(mainTypes.length!==1||mainTypes[0].localName!=='Override'||mainTypes[0].getAttribute('PartName')!==`/${main}`||mainTypes[0].getAttribute('ContentType').toLowerCase()!==expectedType)invalid(extension.toUpperCase(),'The package content type does not match its extension.');
  const relationships=parseXml(await zip.file('_rels/.rels').async('nodebuffer'),'_rels/.rels');
  if(relationships.documentElement.localName!=='Relationships'||relationships.documentElement.namespaceURI!=='http://schemas.openxmlformats.org/package/2006/relationships')invalid(extension.toUpperCase(),'Invalid root relationships.');
  const office=[...relationships.documentElement.childNodes].filter(node=>node.nodeType===1&&['http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument','http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'].includes(node.getAttribute('Type')));
  if(office.length!==1||office[0].getAttribute('Target').replace(/^\//,'')!==main||office[0].getAttribute('TargetMode')==='External')invalid(extension.toUpperCase(),'The Office main relationship does not match its extension.');
  for(const name of names.filter(name=>/\.rels$/i.test(name))) {
    const relations=name==='_rels/.rels'?relationships:parseXml(await zip.file(name).async('nodebuffer'),name);
    if([...relations.getElementsByTagNameNS('*','Relationship')].some(node=>/(?:^|\/)(?:vbaProject|vbaData|control|activeX|oleObject|attachedTemplate|aFChunk|customUI)$/i.test(node.getAttribute('Type')||'')))fail('ATTACHMENT_ACTIVE_CONTENT','Office attachments cannot contain macro, active object, HTML-import or template relationships.',[name]);
  }
  const mainBytes=await zip.file(main).async('nodebuffer');let head;try{head=decodeXml(mainBytes.subarray(0,ATTACHMENT_LIMITS.maxXmlHeaderBytes),true);}catch{invalid(extension.toUpperCase(),'Invalid main XML text encoding.');}
  head=head.replace(/^\uFEFF/,'');for(;;){const stripped=head.replace(/^\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->)/,'');if(stripped===head)break;head=stripped;}
  const opening=head.match(/^\s*(<[A-Za-z_][\w.:-]*(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?>)/)?.[1];
  if(!opening)invalid(extension.toUpperCase(),'The main XML root exceeds its header limit or is invalid.');
  const element=parseXml(Buffer.from(opening.replace(/\/?\s*>$/,'/>')),'main XML root').documentElement;
  const expectedRoot=extension==='xlsx'?'workbook':'document',namespaces=extension==='xlsx'?['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://purl.oclc.org/ooxml/spreadsheetml/main']:['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'];
  if(element.localName!==expectedRoot||!namespaces.includes(element.namespaceURI))invalid(extension.toUpperCase(),'The Office main XML root does not match its extension.');
}

/** Pure validation: no persistence, scanning, access lookup, or byte rewriting.
 * The repository must authorize scope/supersession and scan before release. */
export async function validateAttachment(bytes,options={},context={}) {
  if(!options||typeof options!=='object'||Array.isArray(options))fail('ATTACHMENT_METADATA_INVALID','Attachment metadata must be an object.');
  const meta=metadataFor(options,context),file=filenameFor(options.filename),buffer=binary(bytes);mimeFor(options.contentType,file.contentType);
  if((buffer[0]===77&&buffer[1]===90&&buffer.length>=64)||buffer.subarray(0,4).equals(Buffer.from([127,69,76,70])))fail('ATTACHMENT_ACTIVE_CONTENT','Executable files cannot be uploaded as attachments.');
  if(file.extension==='pdf'){if(!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s|$)/.test(buffer.subarray(0,16).toString('ascii')))invalid('PDF','Expected a PDF version header at the start of the file.');}
  else if(file.extension==='xlsx'||file.extension==='docx')await ooxml(buffer,file.extension);
  else if(file.extension==='png')png(buffer);
  else if(file.extension==='jpg'||file.extension==='jpeg')jpeg(buffer);
  else csv(buffer);
  return Object.freeze({filename:file.filename,contentType:file.contentType,...meta});
}
