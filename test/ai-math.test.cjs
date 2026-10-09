const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const src=fs.readFileSync('server.js','utf8');
function getFunction(name){
 const start=src.indexOf('function '+name+'(');
 assert.ok(start>=0,'missing '+name);
 let begin=src.indexOf('{',start),depth=0,end=begin;
 for(;end<src.length;end++){if(src[end]==='{')depth++;if(src[end]==='}'&&!--depth){end++;break}}
 return src.slice(start,end);
}
const sandbox={Math,Array,Number,Set,Map,UNIFORM:.1,RF_HORIZONS:[1,2,3,5],safeNum:(x,d)=>Number.isFinite(Number(x))?Number(x):d,clamp:(x,a,b)=>Math.min(b,Math.max(a,x)),riseFallMem:{global:{1:{n:500,counts:[500,0,500]}},performance:{1:{brierEWMA:2/9,logLossEWMA:Math.log(3)}}},riseFallExpertWeight:()=>1};
vm.createContext(sandbox);
for(const name of ['riseFallNorm3','riseFallBlendExperts'])vm.runInContext(getFunction(name),sandbox);
test('probabilities remain finite, positive, and sum to 1',()=>{
 for(const views of [[],[{name:'a',p:[.8,.1,.1],support:.9,base:1}],[{name:'a',p:[.01,.01,.98],support:.01,base:1}]]){
  const p=sandbox.riseFallBlendExperts(1,views).p;
  assert.ok(p.every(Number.isFinite));assert.ok(p.every(x=>x>0));assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-9);
 }
});
test('unreliable expert cannot overwhelm historical baseline',()=>{
 const p=sandbox.riseFallBlendExperts(1,[{name:'a',p:[.01,.01,.98],support:0,base:1}]).p;
 assert.ok(p[2]<.9,'overconfident posterior');
});
test('Differ reliability prior uses null risk rather than model prediction',()=>{
 assert.match(src,/const posterior=\\(safeNum\\(b.matches,0\\)\\+prior\\*UNIFORM\\)\\/\\(safeNum\\(b.n,0\\)\\+prior\\)/);
});
