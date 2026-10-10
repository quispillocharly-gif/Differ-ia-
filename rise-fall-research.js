'use strict';
/* Independent Rise/Fall walk-forward research. No execution, connection or order hooks. */
const fs=require('fs'),path=require('path');
module.exports=function createRiseFallResearch({dataDir}){
 const FILE=path.join(dataDir,'rise-fall-research-v1.json');
 const H=[1,2,3,5],N=960,WINDOW=240,MIN=300,REVIEW=100;
 const models=Array.from({length:N},(_,id)=>{
   const horizon=H[id%4],lookback=[3,5,8,13,21,34,55,89][Math.floor(id/4)%8];
   const rule=['momentum','reversion','acceleration','majority','volatility'][Math.floor(id/32)%5];
   const gate=[0,0.15,0.35,0.65,1,1.5][Math.floor(id/160)%6];
   return {id,horizon,lookback,rule,gate,n:0,wins:0,flat:0,recent:[],pending:[],status:'RESEARCH',reviews:0,good:0,bad:0};
 });
 let state={version:1,ticks:0,tests:0,updatedAt:null},prices=[],lastSave=0;
 try{
  const v=JSON.parse(fs.readFileSync(FILE,'utf8'));
  if(v.version===1){state={...state,ticks:Number(v.ticks)||0,tests:Number(v.tests)||0,updatedAt:v.updatedAt||null};if(Array.isArray(v.models))v.models.slice(0,N).forEach((x,i)=>{const m=models[i];if(!Array.isArray(x))return;[m.n,m.wins,m.flat,m.recent,m.status,m.reviews,m.good,m.bad]=x;m.recent=Array.isArray(m.recent)?m.recent.slice(-WINDOW):[];m.pending=[]})}
 }catch(_){}
 function save(){
  try{fs.mkdirSync(dataDir,{recursive:true});const tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...state,models:models.map(m=>[m.n,m.wins,m.flat,m.recent,m.status,m.reviews,m.good,m.bad])}));fs.renameSync(tmp,FILE)}catch(e){console.error('Rise/Fall research save:',e.message)}
 }
 function onTick(price){
  price=Number(price);if(!Number.isFinite(price))return;
  state.ticks++;prices.push(price);if(prices.length>130)prices.shift();
  for(const m of models){
   for(let j=m.pending.length-1;j>=0;j--){
    const x=m.pending[j];if(x.due>state.ticks)continue;m.pending.splice(j,1);
    const actual=Math.sign(price-x.entry),win=actual===x.direction;
    m.n++;m.wins+=win?1:0;m.flat+=actual===0?1:0;m.recent.push(win?1:0);
    if(m.recent.length>WINDOW)m.recent.shift();state.tests++;
   }
   if(prices.length<m.lookback+2)continue;
   const prev=prices[prices.length-2],old=prices[prices.length-1-m.lookback];
   const momentum=price-old,accel=(price-prev)-(prev-prices[prices.length-3]);
   const moves=prices.slice(-m.lookback).map((v,i,a)=>i?Math.abs(v-a[i-1]):0);
   const scale=moves.reduce((a,b)=>a+b,0)/Math.max(1,moves.length-1);
   let signal=m.rule==='acceleration'?accel:momentum;
   if(m.rule==='majority'){const x=prices.slice(-m.lookback);signal=x.reduce((sum,v,i)=>i?sum+Math.sign(v-x[i-1]):sum,0)}
   if(m.rule==='volatility')signal=momentum/(scale||1);
   if(m.rule==='reversion')signal=-momentum;
   if(!signal||Math.abs(signal)<m.gate*(m.rule==='volatility'||m.rule==='majority'?1:scale))continue;
   if(m.pending.length<6)m.pending.push({due:state.ticks+m.horizon,entry:price,direction:Math.sign(signal)});
   if(m.n>=MIN&&m.n%REVIEW===0&&m.reviews!==m.n){
    m.reviews=m.n;const n=m.recent.length,k=m.recent.reduce((a,b)=>a+b,0);
    const phat=k/n,z=1.96,den=1+z*z/n,center=(phat+z*z/(2*n))/den;
    const margin=z*Math.sqrt(phat*(1-phat)/n+z*z/(4*n*n))/den;
    const lower=center-margin,upper=center+margin;
    if(lower>.5){m.good++;m.bad=0}else if(upper<.5){m.bad++;m.good=0}else{m.good=0;m.bad=0}
    m.status=m.bad>=3?'REJECTED':m.good>=3?'CANDIDATE':'RESEARCH';
   }
  }
  state.updatedAt=Date.now();if(++lastSave>=100){lastSave=0;save()}
 }
 function publicModel(m){const n=m.recent.length,k=m.recent.reduce((a,b)=>a+b,0);return {id:m.id,horizon:m.horizon,lookback:m.lookback,rule:m.rule,gate:m.gate,samples:m.n,recentSamples:n,recentHitRate:n?k/n:null,flat:m.flat,status:m.status}}
 function summary(){const candidates=models.filter(m=>m.status==='CANDIDATE').sort((a,b)=>(b.recent.reduce((x,y)=>x+y,0)/Math.max(1,b.recent.length))-(a.recent.reduce((x,y)=>x+y,0)/Math.max(1,a.recent.length)));return {ok:true,mode:'RESEARCH_ONLY',strategy:'RISE_FALL',models:N,ticks:state.ticks,resolvedTests:state.tests,updatedAt:state.updatedAt,counts:{candidate:candidates.length,rejected:models.filter(m=>m.status==='REJECTED').length,research:models.filter(m=>m.status==='RESEARCH').length},candidates:candidates.slice(0,12).map(publicModel),warning:'Research predictions share ticks and are correlated. Accuracy is not profitability; payout and out-of-sample testing are required.'}}
 function knowledge(){const x=summary();return {revision:x.resolvedTests,updatedAt:x.updatedAt,validatedCandidates:x.candidates,advisoryOnly:true,productionDecisionsModified:false}}
 return {onTick,summary,knowledge,save};
};