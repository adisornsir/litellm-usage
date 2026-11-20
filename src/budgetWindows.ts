import type { KeyInfo } from './client';
export type BudgetPeriod = 'daily'|'monthly'|'other';
export interface BudgetWindow {
  duration:string; period:BudgetPeriod; limit:number; spent?:number; remaining?:number;
  percentage?:number; resetAt?:string; source:'windows'|'standard';
}
const amt=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
const stamp=(v:unknown):string|undefined=>typeof v==='string'&&!!v.trim()&&!Number.isNaN(Date.parse(v))?v:undefined;
export function budgetPeriod(d:string):BudgetPeriod {
  const s=d.toLowerCase().trim();
  return s==='24h'||s==='1d'?'daily':s==='30d'||s==='1mo'?'monthly':'other';
}
function make(duration:string,limit:number,spent:number|undefined,resetAt:string|undefined,source:BudgetWindow['source']):BudgetWindow {
 return {duration,period:budgetPeriod(duration),limit,spent,
  remaining:spent===undefined?undefined:Math.max(0,limit-spent),
  percentage:spent===undefined?undefined:limit===0?(spent>0?100:0):Math.min(100,spent/limit*100),
  resetAt,source};
}
/** Read per-key enforced counters. Missing counters are never mistaken for zero. */
export function budgetWindowsFromKey(info?:KeyInfo):BudgetWindow[]{
 if(!info)return [];
 const out:BudgetWindow[]=[];const seen=new Set<string>();
 for(const spec of info.budget_limits??[]){
  if(!spec||typeof spec.budget_duration!=='string')continue;
  const d=spec.budget_duration.trim(),limit=amt(spec.max_budget);
  if(!d||limit===undefined)continue;
  const u=info.budget_limits_usage?.[d];
  out.push(make(d,limit,amt(u?.current_spend),stamp(u?.reset_at)??stamp(u?.budget_reset_at)
   ??stamp(spec.reset_at)??stamp(spec.budget_reset_at),'windows'));
  seen.add(d.toLowerCase());
 }
 if(info.budget_duration&&!seen.has(info.budget_duration.toLowerCase())){
  const limit=amt(info.max_budget);
  if(limit!==undefined)out.push(make(info.budget_duration,limit,amt(info.spend),stamp(info.budget_reset_at),'standard'));
 }
 const rank=(p:BudgetPeriod)=>p==='daily'?0:p==='monthly'?1:2;
 return out.sort((a,b)=>rank(a.period)-rank(b.period));
}
export function windowStatus(w:BudgetWindow):'unknown'|'ok'|'warning'|'critical'|'exhausted'{
 if(w.spent===undefined||w.percentage===undefined)return 'unknown';
 if(w.spent>=w.limit)return 'exhausted';
 if(w.percentage>=90)return 'critical';
 if(w.percentage>=80)return 'warning';
 return 'ok';
}
