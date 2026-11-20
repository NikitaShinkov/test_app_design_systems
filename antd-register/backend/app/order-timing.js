import {normalize} from './normalization.js';

export const processStages=['supplier','preliminary','final','release','record'];
export const timingModules=['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10','M11'];
const stageFor={M01:'supplier',M02:'preliminary',M03:'preliminary',M04:'preliminary',M05:'preliminary',M06:'final',M07:'final',M08:'final',M09:'release',M10:'record',M11:'closed'};
const day=86400000;
const timestamp=value=>value===null||value===undefined||value===''?NaN:Number(new Date(value));
export const activityStage=run=>run.moduleId==='M11'&&(run.action||run.result?.action)==='RESTORE'?'record':stageFor[run.moduleId];
export function timingRunAllowed(run,context){
  if(!timingModules.includes(run.moduleId)||run.scopeKnown!==true||!run.orderKeys?.length||!['EXPORTED','COMPLETED','COMPLETED_WITH_FINDINGS'].includes(run.result?.status))return false;
  if(context.role!=='ADMINISTRATOR'&&['M10','M11'].includes(run.moduleId))return false;
  if(!context.authenticated||context.role==='ADMINISTRATOR')return true;
  const orders=new Set((context.orders||[]).map(normalize));
  return run.orderKeys.every(key=>key&&orders.has(key))&&(context.role!=='SUPPLIER'||Boolean(normalize(context.organization)&&run.supplierKeys?.length&&run.supplierKeys.every(key=>key===normalize(context.organization))));
}
export function observedOrderTiming(runs,{now=new Date(),truncated=false}={}){
  const until=Number(new Date(now));
  const events=runs.map(run=>({stage:activityStage(run),at:timestamp(run.occurredAt),id:run.id})).filter(event=>event.stage&&Number.isFinite(event.at)&&event.at<=until).sort((a,b)=>a.at-b.at||String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
  const stages=processStages.map(key=>({key,milliseconds:0,startedAt:null,lastAt:null,visits:0})),byKey=new Map(stages.map(stage=>[stage.key,stage]));
  let current=null,previousAt=null,closedAt=null,inactive=0;
  for(const event of events){
    if(current&&previousAt!==null)byKey.get(current).milliseconds+=event.at-previousAt;
    if(event.stage==='closed'){current=null;closedAt=event.at;previousAt=event.at;continue;}
    if(closedAt!==null)inactive+=event.at-closedAt;
    if(event.stage!==current)byKey.get(event.stage).visits++;
    current=event.stage;closedAt=null;previousAt=event.at;
    const stage=byKey.get(current);stage.startedAt??=new Date(event.at).toISOString();stage.lastAt=new Date(event.at).toISOString();
  }
  if(current&&previousAt!==null&&!truncated)byKey.get(current).milliseconds+=until-previousAt;
  if(truncated)current=null;
  const firstAt=events[0]?.at;
  return {tracked:events.length>0,truncated,firstAt:firstAt===undefined?null:new Date(firstAt).toISOString(),lastAt:events.at(-1)?new Date(events.at(-1).at).toISOString():null,capturedAt:new Date(until).toISOString(),current,closed:closedAt!==null,inactiveDays:inactive/day,totalDays:firstAt===undefined||truncated?null:((closedAt??until)-firstAt)/day,stages:stages.map(({milliseconds,...stage})=>({...stage,days:stage.startedAt===null?null:milliseconds/day}))};
}
export function elapsedOverview(orderStarts,{now=new Date()}={}){
  const until=Number(new Date(now)),days=orderStarts.map(timestamp).filter(at=>Number.isFinite(at)&&at<=until).map(at=>(until-at)/day);
  return {trackedOrders:days.length,averageDays:days.length?days.reduce((sum,n)=>sum+n,0)/days.length:null};
}
