'use strict';
const WebSocket=require('ws');
const fs=require('fs');
const path=require('path');
const SYMBOLS=['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ25V','1HZ50V','1HZ75V','1HZ100V'];
module.exports=function startBackgroundLearning(dataDir){
 const file=path.join(dataDir,'multi-index-research.json');
 let store={version:1,updatedAt:0,markets:{}};
 try{const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(raw?.version===1&&raw.markets)store=raw}catch(_){}
 const states=new Map();let socket=null,retry=null,flush=null;
 function save(){try{fs.mkdirSync(dataDir,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(store));fs.renameSync(tmp,file)}catch(e){console.error('[multi-index] save:',e.message)}}
 function predict(ds,method){
  const last=ds.at(-1),freq=Array(10).fill(1),trans=Array(10).fill(1),recent=Array(10).fill(1);
  ds.slice(-100).forEach(d=>freq[d]++);
  ds.slice(-25).forEach(d=>recent[d]++);
  for(let i=Math.max(1,ds.length-100);i<ds.length;i++)if(ds[i-1]===last)trans[ds[i]]++;
  const scores=freq.map((v,d)=>method==='frequency'?v:method==='markov'?trans[d]:method==='recent'?recent[d]:.35*v/100+.4*trans[d]/trans.reduce((a,b)=>a+b,0)+.25*recent[d]/35);
  return scores.indexOf(Math.min(...scores));
 }
 function learn(state){
  const ds=state.digits;if(ds.length<130)return;
  const outcome=ds.at(-1),history=ds.slice(0,-1);
  const market=store.markets[state.symbol]||(store.markets[state.symbol]={samples:0,methods:{},direction:{up:0,down:0,flat:0},updatedAt:0});
  for(const method of ['frequency','markov','recent','ensemble']){
   const pick=predict(history,method),hit=Number(pick!==outcome);
   const x=market.methods[method]||(market.methods[method]={samples:0,hitEWMA:.9,correct:0});
   x.samples++;x.correct+=hit;x.hitEWMA=.98*x.hitEWMA+.02*hit;
  }
  if(state.prices.length>1){const d=Math.sign(state.prices.at(-1)-state.prices.at(-2));market.direction[d>0?'up':d<0?'down':'flat']++}
  market.samples++;market.updatedAt=Date.now();store.updatedAt=market.updatedAt;
 }
 function digit(price,pip){const n=Number(price);if(!Number.isFinite(n)||!Number.isInteger(pip))return null;return Math.abs(Math.round(n*Math.pow(10,pip)))%10}
 function connect(){
  socket=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');
  socket.on('open',()=>SYMBOLS.forEach((symbol,i)=>{states.set(symbol,{symbol,prices:[],digits:[],pip:null,lastEpoch:0});socket.send(JSON.stringify({ticks_history:symbol,count:300,end:'latest',style:'ticks',req_id:18000+i}))}));
  socket.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch(_){return}if(m.error)return;
   if(m.history?.prices){
    const symbol=SYMBOLS[Number(m.echo_req?.req_id??m.req_id)-18000];const st=states.get(symbol);if(!st)return;
    const pip=Number(m.pip_size);if(!Number.isInteger(pip)||pip<0||pip>10)return;
    st.pip=pip;st.prices=m.history.prices.map(Number).slice(-300);st.digits=st.prices.map(p=>digit(p,pip));st.lastEpoch=Number(m.history.times?.at(-1)||0);
    socket.send(JSON.stringify({ticks:symbol,subscribe:1}));return;
   }
   if(m.tick){const st=states.get(m.tick.symbol);if(!st||st.pip===null)return;
    const epoch=Number(m.tick.epoch||0),price=Number(m.tick.quote);if(!epoch||epoch<=st.lastEpoch||!Number.isFinite(price))return;
    st.lastEpoch=epoch;st.prices.push(price);st.digits.push(digit(price,st.pip));if(st.prices.length>300)st.prices.shift();if(st.digits.length>300)st.digits.shift();learn(st);
   }
  });
  socket.on('error',e=>console.error('[multi-index] socket:',e.message));
  socket.on('close',()=>{states.clear();clearTimeout(retry);retry=setTimeout(connect,5000);retry.unref?.()});
 }
 flush=setInterval(save,30000);flush.unref?.();process.on('SIGTERM',save);process.on('SIGINT',save);connect();
 return {snapshot:()=>store};
};
