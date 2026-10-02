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
const MAX_HIST = 1500;
const VERSION = 1;

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
let status = 'BOOTING';

function blankP(){ return Array(10).fill(UNIFORM); }

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
  m.globalP = Array.isArray(m.globalP) && m.globalP.length === 10 ? m.globalP : blankP();
  m.modelLoss = m.modelLoss || {};
  return m;
}

function loadMemory(){
  try{
    fs.mkdirSync(DATA_DIR, {recursive:true});
    if(!fs.existsSync(MEMORY_FILE)) return freshMemory();
    return normalizeMemory(JSON.parse(fs.readFileSync(MEMORY_FILE,'utf8')));
  }catch(e){
    console.error('Memory load error:', e.message);
    return freshMemory();
  }
}
let mem = loadMemory();

function saveMemory(){
  try{
    fs.mkdirSync(DATA_DIR, {recursive:true});
    mem.updatedAt = Date.now();
    mem.saves = (mem.saves || 0) + 1;
    const tmp = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem));
    fs.renameSync(tmp, MEMORY_FILE);
  }catch(e){
    console.error('Memory save error:', e.message);
  }
}

function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function safeNum(x,d=0){ x=Number(x); return Number.isFinite(x)?x:d; }
function contextKey(arr,endIndex,order){
  const start = endIndex-order+1;
  if(start < 0) return null;
  return arr.slice(start,endIndex+1).join('');
}
function modelLossKey(h,o){ return h+':'+o; }
function learningRate(order,n){
  const base = order===1 ? .035 : order===2 ? .050 : .070;
  const support = Math.min(1, Math.max(0,n)/80);
  return base*(1-.25*support);
}
function ensureNode(h,o,key){
  const bucket = mem.models[h][o];
  if(!bucket[key]) bucket[key] = {p:blankP(), n:0, last:mem.tickCount};
  return bucket[key];
}
function updateProb(p,target,alpha){
  for(let d=0; d<10; d++) p[d] = (1-alpha)*p[d] + alpha*(d===target?1:0);
  const sum = p.reduce((a,b)=>a+b,0) || 1;
  for(let d=0; d<10; d++) p[d] /= sum;
}

function learnDigit(targetDigit, sourceHist){
  if(sourceHist.length){
    updateProb(mem.globalP,targetDigit,.018);
    mem.globalN++;
  }

  for(const h of HORIZONS){
    const signalEnd = sourceHist.length-h;
    if(signalEnd < 0) continue;
    for(const o of ORDERS){
      const key = contextKey(sourceHist,signalEnd,o);
      if(key===null) continue;
      const node = ensureNode(h,o,key);
      const before = clamp(node.p[targetDigit] || UNIFORM,.0001,.9999);
      const loss = -Math.log(before);
      const lk = modelLossKey(h,o);
      mem.modelLoss[lk] = Number.isFinite(mem.modelLoss[lk])
        ? .985*mem.modelLoss[lk] + .015*loss
        : loss;
      updateProb(node.p,targetDigit,learningRate(o,node.n));
      node.n++;
      node.last = mem.tickCount;
    }
  }
  mem.tickCount++;
}

function pruneModels(){
  const limits = {1:10,2:100,3:900};
  HORIZONS.forEach(h => ORDERS.forEach(o => {
    const bucket = mem.models[h][o];
    const keys = Object.keys(bucket);
    const limit = limits[o];
    if(keys.length <= limit) return;
    keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
    keys.slice(limit).forEach(k => delete bucket[k]);
  }));
}

function horizonNow(){
  return clamp(Math.round(safeNum(mem.delayEWMA,1)),1,3);
}

function predict(){
  if(hist.length < 8) return null;
  const h = horizonNow();
  const dist = Array(10).fill(0);
  const denom = Array(10).fill(0);
  const modelViews = [];

  for(let d=0; d<10; d++){
    dist[d] += mem.globalP[d]*.45;
    denom[d] += .45;
  }
  modelViews.push({name:'global',p:mem.globalP.slice(),w:.45,n:mem.globalN});

  for(const o of ORDERS){
    const key = contextKey(hist,hist.length-1,o);
    if(key===null) continue;
    const node = mem.models[h][o][key];
    if(!node) continue;
    const err = safeNum(mem.modelLoss[modelLossKey(h,o)],Math.log(10));
    const reliability = 1/(.35+err);
    const support = 1-Math.exp(-node.n/(o===1?24:o===2?15:9));
    const w = reliability*support*(o===1?.8:o===2?1.05:1.20);
    if(w<=.01) continue;
    for(let d=0; d<10; d++){
      dist[d] += node.p[d]*w;
      denom[d] += w;
    }
    modelViews.push({name:'ctx'+o,p:node.p.slice(),w,n:node.n});
  }

  const recent = hist.slice(-50);
  const counts = Array(10).fill(1.2);
  recent.forEach(d => counts[d]++);
  const total = counts.reduce((a,b)=>a+b,0);
  const rp = counts.map(x=>x/total);
  const rw = .28;

  for(let d=0; d<10; d++){
    dist[d] += rp[d]*rw;
    denom[d] += rw;
  }

  const p = dist.map((x,d)=>x/(denom[d]||1));
  const sum = p.reduce((a,b)=>a+b,0)||1;
  for(let d=0; d<10; d++) p[d] /= sum;

  const scored = p.map((risk,d)=>({d,risk})).sort((a,b)=>a.risk-b.risk);
  const best = scored[0];

  const contextNodes = modelViews.filter(v=>v.name.startsWith('ctx'));
  const support = contextNodes.length
    ? contextNodes.reduce((s,v)=>s+Math.min(1,v.n/30),0)/contextNodes.length
    : 0;

  const confidence = clamp(.20 + .80*support,0,1);

  return {
    horizon:h,
    digit:best.d,
    risk:best.risk,
    confidence,
    probabilities:p,
    generatedAt:Date.now()
  };
}

function processDigit(d,epoch){
  if(!Number.isInteger(d) || d<0 || d>9) return;
  learnDigit(d,hist);
  hist.push(d);
  if(hist.length > MAX_HIST) hist.shift();
  if(epoch) lastEpoch = Math.max(lastEpoch,epoch);
  liveTickCount++;
  lastTickAt = Date.now();
  lastDigit = d;
  if(mem.tickCount % 250 === 0) pruneModels();
  lastPrediction = predict();
}

function digitFromQuote(q,pip){
  const n = Number(q);
  if(!Number.isFinite(n)) return null;
  const p = Number.isFinite(Number(pip)) ? Number(pip) : 4;
  const s = n.toFixed(p);
  return Number(s[s.length-1]);
}

function connectDeriv(){
  clearTimeout(reconnectTimer);
  status = 'CONNECTING';
  try{ if(ws) ws.close(); }catch(_){}

  ws = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');

  ws.on('open', ()=>{
    status = 'ONLINE';
    console.log('Connected to Deriv public feed');
    ws.send(JSON.stringify({ticks_history:SYMBOL,count:700,end:'latest',style:'ticks'}));
  });

  ws.on('message', raw=>{
    let m;
    try{ m = JSON.parse(raw.toString()); }catch(_){ return; }

    if(m.error){
      console.error('Deriv error:', m.error.message || m.error);
      return;
    }

    if(m.history?.prices){
      const prices = m.history.prices;
      const times = Array.isArray(m.history.times) ? m.history.times : [];
      const pip = Number(m.pip_size || 4);

      for(let i=0; i<prices.length; i++){
        const ep = Number(times[i] || 0);
        if(ep && ep <= lastEpoch) continue;
        const d = digitFromQuote(prices[i],pip);
        if(d!==null) processDigit(d,ep);
      }

      saveMemory();
      ws.send(JSON.stringify({ticks:SYMBOL,subscribe:1}));
      return;
    }

    if(m.tick){
      const ep = Number(m.tick.epoch || 0);
      if(ep && ep===lastEpoch) return;
      const d = digitFromQuote(m.tick.quote,m.tick.pip_size);
      if(d!==null) processDigit(d,ep);
    }
  });

  ws.on('error', err=>{
    status = 'ERROR';
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', ()=>{
    status = 'RECONNECTING';
    reconnectTimer = setTimeout(connectDeriv,2500);
  });
}

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','https://quispillocharly-gif.github.io');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(__dirname));

app.get('/api/cloud/status', (req,res)=>{
  res.json({
    ok:true,
    status,
    symbol:SYMBOL,
    startedAt,
    uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),
    memoryFile:MEMORY_FILE,
    tickCount:mem.tickCount,
    liveTickCount,
    lastTickAt,
    lastDigit,
    lastPrediction,
    updatedAt:mem.updatedAt
  });
});

app.get('/api/cloud/prediction', (req,res)=>{
  res.json({ok:true,prediction:lastPrediction});
});

app.get('/api/cloud/snapshot', (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,
    status,
    symbol:SYMBOL,
    lastEpoch,
    lastTickAt,
    lastDigit,
    recentDigits:hist.slice(-120),
    memory:mem
  });
});

app.get('/health', (req,res)=>{
  res.status(status==='ONLINE'?200:503).json({ok:status==='ONLINE',status,ticks:mem.tickCount});
});

app.listen(PORT, ()=>{
  console.log('Differ AI cloud server listening on port', PORT);
  connectDeriv();
});

saveTimer = setInterval(saveMemory,15000);

function shutdown(){
  clearInterval(saveTimer);
  saveMemory();
  try{ if(ws) ws.close(); }catch(_){}
  process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
