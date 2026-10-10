'use strict';
/* Research lab is SHADOW ONLY. Never places orders or changes production models. */
const fs=require('fs'),path=require('path');
module.exports=function createResearchLab({dataDir}){
 const file=path.join(dataDir,'research-lab-v1.json');
 const N=1200,MIN=300,REVIEW=100;
 let state={version:1,ticks:0,tests:0,models:[],lastDigit:null,lastPrice:null,updatedAt:null};
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version===1)state=saved}catch(_){}
 const models=Array.from({length:N},(_,i)=>{
  const type=i%2?'RISE_FALL':'DIFFER',horizon=1+Math.floor(i/2)%5;
  const lookback=8+Math.floor(i/10)%10*8,threshold=1+Math.floor(i/100)%4;
  const seed=Math.floor(i/3)%10;
  return {id:i,type,horizon,lookback,threshold,seed,seen:0,wins:0,losses:0,score:0,pending:[],status:'SHADOW'};
 });
 const digits=[],prices=[];
 let sinceSave=0;
 function save(){try{fs.mkdirSync(dataDir,{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({version:1,ticks:state.ticks,tests:state.tests,models:models.map(m=>[m.seen,m.wins,m.losses,m.score,m.status]),lastDigit:state.lastDigit,lastPrice:state.lastPrice,updatedAt:Date.now()}));fs.renameSync(temp,file)}catch(e){console.error('Research lab save failed:',e.message)}}
 if(Array.isArray(state.models)){state.models.slice(0,N).forEach((v,i)=>{if(Array.isArray(v)){const m=models[i];[m.seen,m.wins,m.losses,m.score,m.status]=v}})}
 function onTick(d,p){
  d=Number(d);p=Number(p);if(!Number.isInteger(d)||d<0||d>9||!Number.isFinite(p))return;
  state.ticks++;digits.push(d);prices.push(p);
  if(digits.length>130){digits.shift();prices.shift()}
  const t=state.ticks;
  for(const m of models){
   if(m.pending.length){for(let j=m.pending.length-1;j>=0;j--){const x=m.pending[j];if(x.due>t)continue;m.pending.splice(j,1);const win=m.type==='DIFFER'?d!==x.pred:(p>x.price?1:p<x.price?-1:0)===x.pred;m.seen++;m.wins+=win?1:0;m.losses+=win?0:1;state.tests++;const baseline=m.type==='DIFFER'?.9:.5;m.score+=((win?1:0)-baseline);}}
   if(digits.length<m.lookback||t%m.horizon!==m.seed%m.horizon)continue;
   const window=digits.slice(-m.lookback);
   let pred;
   if(m.type==='DIFFER'){const counts=Array(10).fill(0);window.forEach(x=>counts[x]++);pred=(m.seed+counts.indexOf(Math.min(...counts)))%10;}
   else{const start=prices[Math.max(0,prices.length-m.lookback)];const trend=p-start;pred=(m.seed%2===0?1:-1)*(trend>=0?1:-1);if(Math.abs(trend)<1e-10)continue}
   if(m.pending.length<8)m.pending.push({due:t+m.horizon,pred,price:p});
   if(m.seen>=MIN&&m.seen%REVIEW===0){const rate=m.wins/m.seen,base=m.type==='DIFFER'?.9:.5;const upper=rate+1.96*Math.sqrt(Math.max(.0001,rate*(1-rate))/m.seen);m.status=upper<base?'REJECTED':m.score>2?'CANDIDATE':'SHADOW'}
  }
  state.lastDigit=d;state.lastPrice=p;state.updatedAt=Date.now();
  if(++sinceSave>=100){sinceSave=0;save()}
 }
 function summary(){
  const ranked=models.filter(m=>m.seen>=MIN).sort((a,b)=>b.score-a.score);
  return {ok:true,mode:'SHADOW_ONLY',version:1,models:N,ticks:state.ticks,resolvedTests:state.tests,minValidation:MIN,counts:{candidate:models.filter(m=>m.status==='CANDIDATE').length,rejected:models.filter(m=>m.status==='REJECTED').length,shadow:models.filter(m=>m.status==='SHADOW').length},leaders:ranked.slice(0,12).map(m=>({id:m.id,type:m.type,horizon:m.horizon,seen:m.seen,wins:m.wins,winRate:m.seen?m.wins/m.seen:0,edgeVsBaseline:m.seen?m.score/m.seen:0,status:m.status})),updatedAt:state.updatedAt,note:'Overlapping predictions on shared ticks are correlated; scores do not prove tradable edge or net profit.'}
 }
 return {onTick,summary,save};
};