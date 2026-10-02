const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.DERIV_SYMBOL || 'R_75';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'differ-ai-memory.json');

const ORDERS = [1,2,3];
const HORIZONS = [1,2,3];
const UNIFORM = 0.10;
const MAX_HIST = 20000;
const SHADOW_RECENT_MAX = 500;
const VERSION = 1;
const MODEL_NAMES = ['global','recent25','recent100','recent300','ctx1','ctx2','ctx3'];

let ws = null;
let reconnectTimer = null;
let saveTimer = null;
let hist = [];
let lastEpoch = 0;
let liveTickCount = 0;
let startedAt = Date.now();
let lastTickAt = 0;
let lastDigit = null;
let lastPrediction = null;
let shadowPending = null;
let status = 'BOOTING';

function blankP(){ return Array(10).fill(UNIFORM); }
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function safeNum(x,d=0){ x=Number(x); return Number.isFinite(x)?x:d; }
function normalizeDist(p){
  const out=Array.from({length:10},(_,i)=>Math.max(0,safeNum(p?.[i],UNIFORM)));
  const s=out.reduce((a,b)=>a+b,0)||1;
  return out.map(x=>x/s);
}
function freshPerf(){
  const o={};
  MODEL_NAMES.forEach(name=>o[name]={samples:0,logLossEWMA:Math.log(10),matchEWMA:UNIFORM,weight:1});
  return o;
}
function freshShadow(){
  return {
    total:0,wins:0,matches:0,matchRate:UNIFORM,edgeVsBaseline:0,
    recent:[],performance:freshPerf(),last:null
  };
}
function freshMemory(){
  const models = {};
  HORIZONS.forEach(h => {
    models[h] = {};
    ORDERS.forEach(o => models[h][o] = {});
  });
  return {
    version: VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tickCount: 0,
    models,
    globalP: blankP(),
    globalN: 0,
    modelLoss: {},
    delayEWMA: 1,
    lastMarketEpoch: 0,
    deepHistory: [],
    shadow: freshShadow(),
    saves: 0
  };
}

function normalizeMemory(x){
  if(!x || x.version !== VERSION) return freshMemory();
  const base = freshMemory();
  const m = {...base, ...x};
  m.models = m.models || base.models;
  HORIZONS.forEach(h => {
    m.models[h] = m.models[h] || {};
    ORDERS.forEach(o => m.models[h][o] = m.models[h][o] || {});
  });
  m.globalP = Array.isArray(m.globalP) && m.globalP.length===10 ? normalizeDist(m.globalP) : blankP();
  m.modelLoss = m.modelLoss || {};
  m.deepHistory = Array.isArray(m.deepHistory)
    ? m.deepHistory.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=9).slice(-MAX_HIST)
    : [];
  m.lastMarketEpoch = safeNum(m.lastMarketEpoch,0);
  const sh = m.shadow && typeof m.shadow==='object' ? m.shadow : freshShadow();
  m.shadow = {...freshShadow(), ...sh};
  m.shadow.performance = {...freshPerf(), ...(sh.performance||{})};
  MODEL_NAMES.forEach(name=>{
    const p=m.shadow.performance[name]||{};
    m.shadow.performance[name]={
      samples:safeNum(p.samples,0),
      logLossEWMA:safeNum(p.logLossEWMA,Math.log(10)),
      matchEWMA:clamp(safeNum(p.matchEWMA,UNIFORM),0,1),
      weight:clamp(safeNum(p.weight,1),.20,3)
    };
  });
  m.shadow.recent = Array.isArray(m.shadow.recent) ? m.shadow.recent.slice(-SHADOW_RECENT_MAX) : [];
  return m;
}

function loadMemory(){
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    if(!fs.existsSync(MEMORY_FILE)) return freshMemory();
    return normalizeMemory(JSON.parse(fs.readFileSync(MEMORY_FILE,'utf8')));
  }catch(e){
    console.error('Memory load error:',e.message);
    return freshMemory();
  }
}
let mem = loadMemory();
hist = mem.deepHistory.slice(-MAX_HIST);
lastEpoch = safeNum(mem.lastMarketEpoch,0);

function saveMemory(){
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    mem.updatedAt=Date.now();
    mem.saves=(mem.saves||0)+1;
    mem.deepHistory=hist.slice(-MAX_HIST);
    mem.lastMarketEpoch=lastEpoch;
    const tmp=MEMORY_FILE+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(mem));
    fs.renameSync(tmp,MEMORY_FILE);
  }catch(e){
    console.error('Memory save error:',e.message);
  }
}

function contextKey(arr,endIndex,order){
  const start=endIndex-order+1;
  if(start<0) return null;
  return arr.slice(start,endIndex+1).join('');
}
function modelLossKey(h,o){ return h+':'+o; }
function learningRate(order,n){
  const base=order===1?.035:order===2?.050:.070;
  const support=Math.min(1,Math.max(0,n)/80);
  return base*(1-.25*support);
}
function ensureNode(h,o,key){
  const bucket=mem.models[h][o];
  if(!bucket[key]) bucket[key]={p:blankP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function updateProb(p,target,alpha){
  for(let d=0;d<10;d++) p[d]=(1-alpha)*p[d]+alpha*(d===target?1:0);
  const sum=p.reduce((a,b)=>a+b,0)||1;
  for(let d=0;d<10;d++) p[d]/=sum;
}

function learnDigit(targetDigit,sourceHist){
  if(sourceHist.length){
    updateProb(mem.globalP,targetDigit,.018);
    mem.globalN++;
  }
  for(const h of HORIZONS){
    const signalEnd=sourceHist.length-h;
    if(signalEnd<0) continue;
    for(const o of ORDERS){
      const key=contextKey(sourceHist,signalEnd,o);
      if(key===null) continue;
      const node=ensureNode(h,o,key);
      const before=clamp(node.p[targetDigit]||UNIFORM,.0001,.9999);
      const loss=-Math.log(before);
      const lk=modelLossKey(h,o);
      mem.modelLoss[lk]=Number.isFinite(mem.modelLoss[lk])?.985*mem.modelLoss[lk]+.015*loss:loss;
      updateProb(node.p,targetDigit,learningRate(o,node.n));
      node.n++;
      node.last=mem.tickCount;
    }
  }
  mem.tickCount++;
}

function pruneModels(){
  const limits={1:10,2:100,3:900};
  HORIZONS.forEach(h=>ORDERS.forEach(o=>{
    const bucket=mem.models[h][o];
    const keys=Object.keys(bucket);
    const limit=limits[o];
    if(keys.length<=limit) return;
    keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
    keys.slice(limit).forEach(k=>delete bucket[k]);
  }));
}

function frequencyDist(windowSize){
  const recent=hist.slice(-windowSize);
  const counts=Array(10).fill(1.4);
  recent.forEach(d=>counts[d]++);
  return normalizeDist(counts);
}

function contextDist(order){
  const key=contextKey(hist,hist.length-1,order);
  if(key===null) return null;
  const node=mem.models[1][order][key];
  if(!node) return null;
  return {p:normalizeDist(node.p),support:1-Math.exp(-safeNum(node.n,0)/(order===1?26:order===2?16:10)),n:safeNum(node.n,0)};
}

function adaptiveWeight(name){
  const perf=mem.shadow.performance[name]||freshPerf()[name];
  const logAdv=Math.log(10)-safeNum(perf.logLossEWMA,Math.log(10));
  const differAdv=UNIFORM-clamp(safeNum(perf.matchEWMA,UNIFORM),0,1);
  const evidence=1-Math.exp(-safeNum(perf.samples,0)/120);
  const raw=Math.exp(clamp(logAdv*1.25,-.7,.7))*(1+clamp(differAdv*4,-.30,.30));
  const w=clamp((1-evidence)*1+evidence*raw,.25,2.5);
  perf.weight=w;
  return w;
}

function modelViews(){
  const views=[];
  views.push({name:'global',p:normalizeDist(mem.globalP),support:Math.min(1,safeNum(mem.globalN,0)/500),base:.80});
  views.push({name:'recent25',p:frequencyDist(25),support:Math.min(1,hist.length/25),base:.75});
  views.push({name:'recent100',p:frequencyDist(100),support:Math.min(1,hist.length/100),base:.90});
  views.push({name:'recent300',p:frequencyDist(300),support:Math.min(1,hist.length/300),base:.75});
  for(const o of ORDERS){
    const c=contextDist(o);
    if(c) views.push({name:'ctx'+o,p:c.p,support:c.support,base:o===1?.95:o===2?1.12:1.22,n:c.n});
  }
  return views;
}

function ensemblePredict(){
  if(hist.length<8) return null;
  const views=modelViews();
  const num=Array(10).fill(0),den=Array(10).fill(0);
  const modelVotes=[];

  for(const v of views){
    const aw=adaptiveWeight(v.name);
    const w=v.base*(.25+.75*v.support)*aw;
    const own=v.p.map((risk,d)=>({d,risk})).sort((a,b)=>a.risk-b.risk)[0];
    modelVotes.push({name:v.name,digit:own.d,risk:own.risk,weight:w,support:v.support,adaptiveWeight:aw});
    for(let d=0;d<10;d++){num[d]+=v.p[d]*w;den[d]+=w;}
  }

  const p=normalizeDist(num.map((x,d)=>x/(den[d]||1)));
  const ranked=p.map((risk,d)=>({d,risk})).sort((a,b)=>a.risk-b.risk);
  const best=ranked[0];

  const risks=views.map(v=>v.p[best.d]);
  const mean=risks.reduce((a,b)=>a+b,0)/(risks.length||1);
  const variance=risks.reduce((s,x)=>s+(x-mean)**2,0)/(risks.length||1);
  const disagreement=Math.sqrt(variance);
  const support=views.reduce((s,v)=>s+v.support,0)/(views.length||1);
  const confidence=clamp((.18+.82*support)*Math.exp(-disagreement*16),0,1);

  return {
    horizon:1,
    digit:best.d,
    risk:best.risk,
    confidence,
    probabilities:p,
    modelVotes,
    generatedAt:Date.now()
  };
}

function updateModelPerformance(pending,actual){
  for(const mv of pending.modelVotes||[]){
    const perf=mem.shadow.performance[mv.name]||(mem.shadow.performance[mv.name]={samples:0,logLossEWMA:Math.log(10),matchEWMA:UNIFORM,weight:1});
    const view=(pending.modelDistributions||{})[mv.name];
    if(!Array.isArray(view)||view.length!==10) continue;
    const prob=clamp(safeNum(view[actual],UNIFORM),.0001,.9999);
    const ll=-Math.log(prob);
    const ownMatch=actual===mv.digit?1:0;
    perf.samples++;
    const a=perf.samples<80?.05:.018;
    perf.logLossEWMA=(1-a)*safeNum(perf.logLossEWMA,Math.log(10))+a*ll;
    perf.matchEWMA=(1-a)*safeNum(perf.matchEWMA,UNIFORM)+a*ownMatch;
    adaptiveWeight(mv.name);
  }
}

function evaluateShadow(actual){
  const p=shadowPending;
  if(!p) return;
  const match=actual===p.digit;
  const sh=mem.shadow;
  sh.total++;
  if(match) sh.matches++; else sh.wins++;
  sh.matchRate=sh.total?sh.matches/sh.total:UNIFORM;
  sh.edgeVsBaseline=UNIFORM-sh.matchRate;
  sh.last={ts:Date.now(),candidate:p.digit,actual,match,risk:p.risk,confidence:p.confidence};
  sh.recent.push(sh.last);
  if(sh.recent.length>SHADOW_RECENT_MAX) sh.recent.shift();
  updateModelPerformance(p,actual);
}

function prepareShadow(){
  const pred=ensemblePredict();
  if(!pred){ shadowPending=null; lastPrediction=null; return; }
  const distributions={};
  for(const v of modelViews()) distributions[v.name]=v.p.slice();
  shadowPending={...pred,modelDistributions:distributions};
  lastPrediction=pred;
}

function processDigit(d,epoch){
  if(!Number.isInteger(d)||d<0||d>9) return;

  evaluateShadow(d);

  learnDigit(d,hist);
  hist.push(d);
  if(hist.length>MAX_HIST) hist.shift();

  if(epoch){
    lastEpoch=Math.max(lastEpoch,epoch);
    mem.lastMarketEpoch=lastEpoch;
  }
  liveTickCount++;
  lastTickAt=Date.now();
  lastDigit=d;

  if(mem.tickCount%250===0) pruneModels();
  if(mem.tickCount%25===0) mem.deepHistory=hist.slice(-MAX_HIST);

  prepareShadow();
}

function digitFromQuote(q,pip){
  const n=Number(q);
  if(!Number.isFinite(n)) return null;
  const p=Number.isFinite(Number(pip))?Number(pip):4;
  const s=n.toFixed(p);
  return Number(s[s.length-1]);
}

function connectDeriv(){
  clearTimeout(reconnectTimer);
  status='CONNECTING';
  try{if(ws)ws.close()}catch(_){}

  ws=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');

  ws.on('open',()=>{
    status='ONLINE';
    console.log('Connected to Deriv public feed');
    ws.send(JSON.stringify({ticks_history:SYMBOL,count:700,end:'latest',style:'ticks'}));
  });

  ws.on('message',raw=>{
    let m;
    try{m=JSON.parse(raw.toString())}catch(_){return}

    if(m.error){
      console.error('Deriv error:',m.error.message||m.error);
      return;
    }

    if(m.history?.prices){
      const prices=m.history.prices;
      const times=Array.isArray(m.history.times)?m.history.times:[];
      const pip=Number(m.pip_size||4);

      for(let i=0;i<prices.length;i++){
        const ep=Number(times[i]||0);
        if(ep&&ep<=safeNum(mem.lastMarketEpoch,0)) continue;
        const d=digitFromQuote(prices[i],pip);
        if(d!==null) processDigit(d,ep);
      }

      saveMemory();
      ws.send(JSON.stringify({ticks:SYMBOL,subscribe:1}));
      return;
    }

    if(m.tick){
      const ep=Number(m.tick.epoch||0);
      if(ep&&ep<=lastEpoch) return;
      const d=digitFromQuote(m.tick.quote,m.tick.pip_size);
      if(d!==null) processDigit(d,ep);
    }
  });

  ws.on('error',err=>{
    status='ERROR';
    console.error('WebSocket error:',err.message);
  });

  ws.on('close',()=>{
    status='RECONNECTING';
    reconnectTimer=setTimeout(connectDeriv,2500);
  });
}

function browserMemory(){
  return {
    version:mem.version,
    createdAt:mem.createdAt,
    updatedAt:mem.updatedAt,
    tickCount:mem.tickCount,
    models:mem.models,
    globalP:mem.globalP,
    globalN:mem.globalN,
    modelLoss:mem.modelLoss,
    delayEWMA:mem.delayEWMA,
    lastMarketEpoch:mem.lastMarketEpoch
  };
}
function performanceSummary(){
  const out={};
  MODEL_NAMES.forEach(name=>{
    const p=mem.shadow.performance[name];
    out[name]={
      samples:p.samples,
      weight:Number(p.weight.toFixed(3)),
      matchEWMA:Number(p.matchEWMA.toFixed(4)),
      logLossEWMA:Number(p.logLossEWMA.toFixed(4))
    };
  });
  return out;
}

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','https://quispillocharly-gif.github.io');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

app.get('/api/cloud/status',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,status,symbol:SYMBOL,startedAt,
    uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),
    tickCount:mem.tickCount,
    deepHistorySize:hist.length,
    liveTickCount,lastTickAt,lastDigit,lastPrediction,
    shadow:{
      total:mem.shadow.total,
      wins:mem.shadow.wins,
      matches:mem.shadow.matches,
      matchRate:mem.shadow.matchRate,
      edgeVsBaseline:mem.shadow.edgeVsBaseline,
      last:mem.shadow.last,
      modelCount:MODEL_NAMES.length,
      performance:performanceSummary()
    },
    updatedAt:mem.updatedAt
  });
});

app.get('/api/cloud/prediction',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,prediction:lastPrediction,shadow:mem.shadow.last});
});

app.get('/api/cloud/shadow',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,
    total:mem.shadow.total,
    wins:mem.shadow.wins,
    matches:mem.shadow.matches,
    matchRate:mem.shadow.matchRate,
    edgeVsBaseline:mem.shadow.edgeVsBaseline,
    recent:mem.shadow.recent.slice(-100),
    performance:performanceSummary()
  });
});

app.get('/api/cloud/snapshot',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,status,symbol:SYMBOL,lastEpoch,lastTickAt,lastDigit,
    recentDigits:hist.slice(-120),
    memory:browserMemory()
  });
});

app.get('/health',(req,res)=>{
  res.status(status==='ONLINE'?200:503).json({
    ok:status==='ONLINE',status,ticks:mem.tickCount,shadowTrades:mem.shadow.total,history:hist.length
  });
});

app.listen(PORT,()=>{
  console.log('Differ AI cloud ensemble server listening on port',PORT);
  console.log('Persistent history restored:',hist.length,'ticks');
  console.log('Shadow trades restored:',mem.shadow.total);
  prepareShadow();
  connectDeriv();
});

saveTimer=setInterval(saveMemory,15000);

function shutdown(){
  clearInterval(saveTimer);
  saveMemory();
  try{if(ws)ws.close()}catch(_){}
  process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
