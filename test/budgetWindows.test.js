const {test}=require('node:test');
const assert=require('node:assert/strict');
const {budgetWindowsFromKey,budgetPeriod,windowStatus}=require('../out/budgetWindows.js');
test('daily and monthly aliases',()=>{
 assert.equal(budgetPeriod('24h'),'daily');assert.equal(budgetPeriod('1d'),'daily');
 assert.equal(budgetPeriod('30d'),'monthly');assert.equal(budgetPeriod('1mo'),'monthly');
});
test('independent daily and monthly counters',()=>{
 const v=budgetWindowsFromKey({budget_limits:[{budget_duration:'30d',max_budget:100},{budget_duration:'24h',max_budget:20}],
 budget_limits_usage:{'30d':{current_spend:51.25},'24h':{current_spend:15,reset_at:'2026-11-21T00:00:00Z'}}});
 assert.deepEqual(v.map(w=>w.period),['daily','monthly']);
 assert.deepEqual(v.map(w=>w.remaining),[5,48.75]);assert.equal(v[0].resetAt,'2026-11-21T00:00:00Z');
});
test('missing counters unknown, not zero',()=>{
 const [v]=budgetWindowsFromKey({budget_limits:[{budget_duration:'24h',max_budget:20}]});
 assert.equal(v.spent,undefined);assert.equal(windowStatus(v),'unknown');
});
test('single standard budget_duration fallback',()=>{
 const [v]=budgetWindowsFromKey({budget_duration:'1d',max_budget:20,spend:3.75,budget_reset_at:'2026-11-21T00:00:00Z'});
 assert.equal(v.period,'daily');assert.equal(v.remaining,16.25);
});
test('thresholds and zero',()=>{
 for(const [spend,status] of [[0,'ok'],[16,'warning'],[18,'critical'],[21,'exhausted']]){
 const [v]=budgetWindowsFromKey({budget_limits:[{budget_duration:'24h',max_budget:20}],budget_limits_usage:{'24h':{current_spend:spend}}});
 assert.equal(windowStatus(v),status);assert.equal(v.remaining,Math.max(0,20-spend));
 }
});
test('invalid usage omitted',()=>{
 const v=budgetWindowsFromKey({budget_limits:[{budget_duration:'24h',max_budget:-1},{budget_duration:'30d',max_budget:100}],
 budget_limits_usage:{'30d':{current_spend:-8,reset_at:'bad'}}});
 assert.equal(v.length,1);assert.equal(v[0].spent,undefined);assert.equal(v[0].resetAt,undefined);
});