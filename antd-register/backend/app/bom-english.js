import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {workflowError} from './workbook-file-errors.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const russian=/[\u0400-\u04ff]/u;
const dictionary=new Map(Object.entries({
  'примечание':'Note','примечания':'Notes','описание':'Description','обозначение':'Designation','наименование':'Description',
  'производитель':'Manufacturer','единица измерения':'Unit','ед. изм.':'Unit','количество':'Quantity','поз. обозначение':'Position',
  'не устанавливать':'Do not populate','не установлен':'Not populated','не установлено':'Not populated','не закупать':'Do not purchase',
  'не заменять':'Do not substitute','устаревший':'Obsolete','печатная плата':'Printed circuit board','резистор':'Resistor','конденсатор':'Capacitor','микросхема':'Integrated circuit','диод':'Diode','разъем':'Connector','разъём':'Connector',
  'напряжение':'Voltage','допуск':'Tolerance','мощность':'Power','температура':'Temperature',
  'шт':'pcs','шт.':'pcs','мм':'mm'
}));
const units=new Map(Object.entries({'Ом':'Ohm','кОм':'kOhm','мОм':'mOhm','МОм':'MOhm','В':'V','мВ':'mV','А':'A','мА':'mA','мкФ':'uF','мФ':'mF','нФ':'nF','пФ':'pF','мкГн':'uH','МГц':'MHz','мГц':'mHz'}));

function splitText(value){
  value=value.replace(/(\d[\d.,]*\s*)(мВ|В|мА|А)(?=\s|$|[.,;])/gu,(_,number,unit)=>number+({'мВ':'mV','В':'V','мА':'mA','А':'A'}[unit])).replace(/°С/gu,'°C');
  // Preserve existing Latin wording, codes/part numbers and numeric technical
  // values exactly. Only the intervening Russian phrases reach the model.
  return value.split(/([A-Za-z0-9][A-Za-z0-9_./:+%°µΩ±×=\-]*|[.!?;:\r\n]+)/g).map(part=>{
    if(!russian.test(part))return {literal:part};
    const whole=part.trim(),unit=units.get(whole),direct=dictionary.get(whole.toLocaleLowerCase('ru'));
    if(unit||direct)return {literal:part.match(/^\s*/u)[0]+(unit||direct)+part.match(/\s*$/u)[0]};
    const prefix=part.match(/^[^\p{L}]*/u)[0],suffix=part.match(/[^\p{L}]*$/u)[0],text=part.slice(prefix.length,part.length-suffix.length||undefined);
    if(!text)return {literal:part};
    const known=units.get(text)||dictionary.get(text.toLocaleLowerCase('ru'));
    return known?{literal:prefix+known+suffix}:{text,prefix,suffix};
  });
}

export async function translateLocalRussian(texts){
  if(!texts.length)return [];
  const runtime=path.resolve(process.env.RR_TRANSLATION_ROOT||path.join(root,'.translation-runtime'));
  const python=process.env.RR_TRANSLATION_PYTHON||path.join(runtime,'p',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  try{await Promise.all([fs.access(python),fs.access(path.join(runtime,'manifest.json'))]);}
  catch{workflowError('M01_TRANSLATION_UNAVAILABLE','Локальный переводчик RU → EN не установлен.', ['Запустите app/setup-local-translation.py с Python 3.12. Перевод выполняется только локально; файл не выпущен.']);}
  const request=JSON.stringify({texts});if(Buffer.byteLength(request)>4*1024*1024)workflowError('M01_TRANSLATION_LIMIT','Текст BOM превышает лимит перевода за один экспорт (4 МБ).');
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-I',path.join(root,'app','local-translation.py'),runtime],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
    let out='',err='',settled=false;
    const fail=(code,message)=>{if(settled)return;settled=true;clearTimeout(timer);reject(Object.assign(new Error(message),{status:422,code}));};
    const timer=setTimeout(()=>{child.kill();fail('M01_TRANSLATION_TIMEOUT','Локальный перевод BOM превысил 95 секунд. Файл не выпущен; повторите подготовку.');},95000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.on('error',()=>fail('M01_TRANSLATION_UNAVAILABLE','Не удалось запустить локальный переводчик. Проверьте его установку.'));
    child.stdout.on('data',chunk=>{out+=chunk.toString('utf8');if(Buffer.byteLength(out)>8*1024*1024){child.kill();fail('M01_TRANSLATION_LIMIT','Результат локального перевода превышает допустимый объём.');}});
    child.stderr.on('data',chunk=>{if(err.length<16000)err+=chunk.toString('utf8');});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(settled)return;
      if(code!==0){let detail='';try{detail=JSON.parse(err.trim().split('\n').at(-1)).error||'';}catch{}return fail('M01_TRANSLATION_FAILED','Локальный перевод BOM не выполнен.'+(detail?' '+detail.slice(0,500):' Проверьте установку языковой модели.'));}
      try{const values=JSON.parse(out).translations;if(!Array.isArray(values)||values.length!==texts.length||values.some(text=>typeof text!=='string'||!/[A-Za-z]/.test(text)||russian.test(text)))throw Error('Некоторые фразы остались непереведёнными.');settled=true;clearTimeout(timer);resolve(values);}
      catch(error){fail('M01_TRANSLATION_INCOMPLETE','Локальный перевод не вернул полный английский текст. '+error.message);}
    });
    child.stdin.write(request+String.fromCharCode(10));
  });
}

export async function translateM01Sheet(worksheet,{headerRow,lastRow,protectedColumns=[],translate=translateLocalRussian}={}){
  const protectedSet=new Set(protectedColumns.filter(Boolean)),slots=[],unique=new Set();
  function textSlot(value,set,address){
    if(typeof value!=='string'||!russian.test(value))return;
    const pieces=splitText(value);for(const piece of pieces)if(piece.text)unique.add(piece.text);
    slots.push({pieces,set,address});
  }
  function cellText(cell){
    let value=cell.value;
    if(value?.richText?.some(run=>russian.test(run.text||''))||value?.hyperlink&&russian.test(value.text||'')){value=structuredClone(value);cell.value=value;}
    if(typeof value==='string')textSlot(value,v=>{cell.value=v;},cell.address);
    else if(value?.richText)for(const run of value.richText)textSlot(run.text,v=>{run.text=v;},cell.address);
    else if(value?.hyperlink)textSlot(value.text,v=>{value.text=v;},cell.address);
    else if((value?.formula||value?.sharedFormula)&&typeof value.result==='string'&&russian.test(value.result))workflowError('M01_TRANSLATION_FORMULA','Нельзя перевести русскоязычный результат формулы без изменения исходной формулы.',[`${worksheet.name}!${cell.address}: замените текстовый результат формулы английским в исходной BOM.`]);
  }
  function noteText(cell){
    if(typeof cell.note==='string')textSlot(cell.note,v=>{cell.note=v;},cell.address+' note');
    else if(cell.note?.texts){cell.note=structuredClone(cell.note);for(const run of cell.note.texts)textSlot(run.text,v=>{run.text=v;},cell.address+' note');}
  }
  cellText(worksheet.getCell('B3'));
  for(let row=headerRow;row<=lastRow;row++){
    const current=worksheet.getRow(row);current.eachCell({includeEmpty:false},(cell,column)=>{
      if(cell.isMerged&&cell.master.address!==cell.address)return;
      if(row===headerRow||!protectedSet.has(column))cellText(cell);
      noteText(cell);
    });
  }
  const requested=[...unique],translated=await translate(requested);
  if(!Array.isArray(translated)||translated.length!==requested.length||translated.some(v=>typeof v!=='string'||!/[A-Za-z]/.test(v)||russian.test(v)))workflowError('M01_TRANSLATION_INCOMPLETE','Не все текстовые ячейки BOM переведены на английский. Файл не выпущен.',slots.slice(0,20).map(slot=>`${worksheet.name}!${slot.address}`));
  const values=new Map(requested.map((text,index)=>[text,translated[index]]));
  for(const slot of slots)slot.set(slot.pieces.map(p=>p.literal??p.prefix+values.get(p.text)+p.suffix).join(''));
  return {language:'en',translatedCells:slots.length,uniquePhrases:requested.length,engine:'local-ru-en'};
}
