const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SYMBOL = process.env.DERIV_SYMBOL || 'R_75';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'differ-ai-memory.json');
const RISE_FALL_FILE = path.join(DATA_DIR, 'rise-fall-ai-memory.json');

const ORDERS = [1,2,3];
const HORIZONS = [1,2,3];
const UNIFORM = 0.10;
const MAX_HIST = 20000;
const SHADOW_RECENT_MAX = 500;
const VERSION = 1;
const MODEL_NAMES = ['global','recent25','recent100','recent300','ctx1','ctx2','ctx3','motion','phase','futureMove','range','collab'];
const HEDGE_ETA = 0.34;
const CAL_BINS = 20;
const DRIFT_MAX_WINDOW = 360;
const TOURNAMENT_NAMES = ['base','recentFocus','contextFocus','robust'];
const TOURNAMENT_MIN_SAMPLES = 2000;
const TOURNAMENT_RECENT = 900;
const TOURNAMENT_COOLDOWN_TICKS = 3600;
const MASTER_BRAIN_VERSION = 'NEXUS-MASTER-2';
const MOVE_BUCKETS = ['DOWN_JUMP','DOWN_MED','DOWN_SMALL','FLAT','UP_SMALL','UP_MED','UP_JUMP'];
const MOVE_CENTERS = [-14,-6,-2,0,2,6,14];
const MOVE_UNIFORM = 1/MOVE_BUCKETS.length;
const MOVE_BASE_LOGLOSS = Math.log(MOVE_BUCKETS.length);
const MOVE_BASE_BRIER = 6/49;
const RANGE_STATES = ['STAY','BREAK_DOWN','BREAK_UP'];
const RANGE_UNIFORM = 1/3;
const RANGE_BASE_LOGLOSS = Math.log(3);
const RANGE_BASE_BRIER = 2/9;
const ENTRY_RESEARCH_PROFILES = {
  balanced:{riskCeiling:.0975,minConfidence:.22,minConsensus:.54,robustCeiling:.118},
  strict:{riskCeiling:.0940,minConfidence:.26,minConsensus:.60,robustCeiling:.110},
  surgical:{riskCeiling:.0900,minConfidence:.32,minConsensus:.66,robustCeiling:.103}
};

let ws = null;
let reconnectTimer = null;
let saveTimer = null;
let hist = [];
let priceHist = [];
let motionHist = [];
let marketPip = 4;
let lastEpoch = 0;
let liveTickCount = 0;
let startedAt = Date.now();
let lastTickAt = 0;
let lastDigit = null;
let lastPrediction = null;
let shadowPending = null;
let movementQueue = [];
let movementBootstrapDone = false;
let rangeQueue = [];
let rangeBootstrapDone = false;
let riseFallBootstrapDone = false;
let riseFallPending = [];
let riseFallLastPrediction = null;
let status = 'BOOTING';

function blankP(){ return Array(10).fill(UNIFORM); }
function blankMoveP(){ return Array(MOVE_BUCKETS.length).fill(MOVE_UNIFORM); }
function freshMovePerf(){ return {samples:0,logLossEWMA:MOVE_BASE_LOGLOSS,brierEWMA:MOVE_BASE_BRIER,directionHitEWMA:1/3,maeUnitsEWMA:6,lastAt:0}; }
function freshRangePerf(){ return {samples:0,logLossEWMA:RANGE_BASE_LOGLOSS,brierEWMA:RANGE_BASE_BRIER,accuracyEWMA:1/3,lastAt:0}; }
function blankRangeState(){ return Array(3).fill(RANGE_UNIFORM); }
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function safeNum(x,d=0){ x=Number(x); return Number.isFinite(x)?x:d; }
function mean(xs){ return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function normalizeDist(p){
  const out=Array.from({length:10},(_,i)=>Math.max(0,safeNum(p?.[i],UNIFORM)));
  const s=out.reduce((a,b)=>a+b,0)||1;
  return out.map(x=>x/s);
}
function freshPerf(){
  const o={};
  MODEL_NAMES.forEach(name=>o[name]={
    samples:0,
    logLossEWMA:Math.log(10),
    matchEWMA:UNIFORM,
    weight:1,
    cumulativeLoss:0
  });
  return o;
}
function freshCalibration(){
  return {
    samples:0,
    brierEWMA:0.09,
    predictedEWMA:UNIFORM,
    observedEWMA:UNIFORM,
    ece:0,
    bins:Array.from({length:CAL_BINS},()=>({n:0,matches:0}))
  };
}
function freshDrift(){
  return {
    events:0,
    active:false,
    boostRemaining:0,
    lastAt:0,
    lastTick:0,
    score:0,
    epsilon:0,
    cut:0,
    lossWindow:[]
  };
}
function freshCollaborative(){
  return {
    received:0,
    accepted:0,
    duplicates:0,
    wins:0,
    matches:0,
    matchRate:UNIFORM,
    lastAt:0,
    updatedAt:0,
    byDigit:Array.from({length:10},()=>({n:0,matches:0,last:0})),
    contexts:{},
    seen:{}
  };
}

function freshStreakStats(){
  return {
    '0-2':{n:0,matches:0},
    '3-5':{n:0,matches:0},
    '6-8':{n:0,matches:0},
    '9-11':{n:0,matches:0},
    '12+':{n:0,matches:0}
  };
}
function masterStreakBucket(n){
  n=Math.max(0,Math.floor(safeNum(n,0)));
  if(n<=2)return '0-2';
  if(n<=5)return '3-5';
  if(n<=8)return '6-8';
  if(n<=11)return '9-11';
  return '12+';
}
function freshSessionAnalytics(){
  return {
    sessionsStarted:0,
    sessionsCompleted:0,
    sessionsStopped:0,
    tradesObserved:0,
    matches:0,
    earlyMatches:0,
    matchPositionSum:0,
    maxPosition:0,
    lastMatchPosition:0,
    lastCompletionPosition:0,
    byPosition:Array.from({length:50},()=>({trades:0,matches:0,completions:0})),
    overflow:{trades:0,matches:0,completions:0},
    seen:{},
    updatedAt:0
  };
}
function freshMasterBrain(){
  return {
    version:MASTER_BRAIN_VERSION,
    revision:0,
    updatedAt:0,
    counterfactualTicks:0,
    digitCalibration:Array.from({length:10},()=>({n:0,matches:0,predictedSum:0})),
    rankStats:Array.from({length:10},()=>({n:0,matches:0})),
    errorContexts:[],
    streakStats:freshStreakStats(),
    sessionAnalytics:freshSessionAnalytics()
  };
}

function freshEntryResearchStat(){
  return {accepted:0,matches:0,recent:[],lastAt:0};
}
function freshEntryResearch(){
  const profiles={};
  Object.keys(ENTRY_RESEARCH_PROFILES).forEach(name=>profiles[name]=freshEntryResearchStat());
  return {
    version:1,
    resolved:0,
    profiles,
    recommended:'balanced',
    updatedAt:0
  };
}
function normalizeEntryResearch(raw){
  const base=freshEntryResearch();
  if(!raw||typeof raw!=='object')return base;
  const out={...base,...raw};
  out.resolved=Math.max(0,Math.floor(safeNum(out.resolved,0)));
  out.profiles={};
  Object.keys(ENTRY_RESEARCH_PROFILES).forEach(name=>{
    const x=raw.profiles?.[name]||{};
    out.profiles[name]={
      accepted:Math.max(0,Math.floor(safeNum(x.accepted,0))),
      matches:Math.max(0,Math.floor(safeNum(x.matches,0))),
      recent:Array.isArray(x.recent)?x.recent.map(v=>v?1:0).slice(-800):[],
      lastAt:Math.max(0,safeNum(x.lastAt,0))
    };
  });
  out.recommended=Object.prototype.hasOwnProperty.call(ENTRY_RESEARCH_PROFILES,String(raw.recommended||''))?String(raw.recommended):'balanced';
  out.updatedAt=Math.max(0,safeNum(raw.updatedAt,0));
  return out;
}
function weightedQuantile(items,q){
  const xs=items.filter(x=>Number.isFinite(x.value)&&x.weight>0).sort((a,b)=>a.value-b.value);
  if(!xs.length)return UNIFORM;
  const total=xs.reduce((s,x)=>s+x.weight,0)||1;
  let acc=0;
  for(const x of xs){
    acc+=x.weight;
    if(acc/total>=q)return x.value;
  }
  return xs[xs.length-1].value;
}
function entryCommitteeMetrics(pending){
  const digit=Number(pending?.digit);
  const distributions=pending?.modelDistributions||{};
  const votes=Array.isArray(pending?.modelVotes)?pending.modelVotes:[];
  const items=[];
  for(const v of votes){
    const w=Math.max(0,safeNum(v?.weight,0));
    const dist=distributions[v?.name];
    if(w<=.005||!Array.isArray(dist)||dist.length!==10)continue;
    items.push({value:clamp(safeNum(dist[digit],UNIFORM),.001,.40),weight:w,name:v.name});
  }
  if(!items.length)return {consensus:0,robustRisk:.30,spread:.30,models:0};
  const total=items.reduce((s,x)=>s+x.weight,0)||1;
  const safe=items.reduce((s,x)=>s+(x.value<=UNIFORM?x.weight:0),0);
  const meanRisk=items.reduce((s,x)=>s+x.value*x.weight,0)/total;
  const variance=items.reduce((s,x)=>s+x.weight*(x.value-meanRisk)*(x.value-meanRisk),0)/total;
  return {
    consensus:clamp(safe/total,0,1),
    robustRisk:weightedQuantile(items,.75),
    spread:Math.sqrt(Math.max(0,variance)),
    models:items.length
  };
}
function entryResearchAccepts(profile,pending,committee){
  const risk=clamp(safeNum(pending?.risk,UNIFORM),.001,.40);
  const conf=clamp(safeNum(pending?.confidence,0),0,1);
  return risk<=profile.riskCeiling &&
    conf>=profile.minConfidence &&
    committee.consensus>=profile.minConsensus &&
    committee.robustRisk<=profile.robustCeiling &&
    committee.models>=3;
}
function entryPosteriorRate(stat){
  // Prior centrado en 10% para evitar premiar perfiles con pocas muestras.
  return (safeNum(stat?.matches,0)+20*UNIFORM)/(safeNum(stat?.accepted,0)+20);
}
function updateEntryResearch(pending,actual){
  if(!pending||!Number.isInteger(actual))return;
  const er=mem.entryResearch||(mem.entryResearch=freshEntryResearch());
  const committee=entryCommitteeMetrics(pending);
  er.resolved++;
  Object.entries(ENTRY_RESEARCH_PROFILES).forEach(([name,profile])=>{
    const st=er.profiles[name]||(er.profiles[name]=freshEntryResearchStat());
    if(!entryResearchAccepts(profile,pending,committee))return;
    const match=actual===pending.digit?1:0;
    st.accepted++;
    st.matches+=match;
    st.recent.push(match);
    if(st.recent.length>800)st.recent.shift();
    st.lastAt=Date.now();
  });

  const balanced=er.profiles.balanced;
  let recommended='balanced';
  if(er.resolved>=1200 && balanced.accepted>=400){
    const baseRate=entryPosteriorRate(balanced);
    for(const name of ['strict','surgical']){
      const st=er.profiles[name];
      const coverage=st.accepted/Math.max(1,er.resolved);
      const rate=entryPosteriorRate(st);
      if(st.accepted>=350 && coverage>=.04 && rate<=baseRate-.002){
        recommended=name;
      }
    }
  }
  er.recommended=recommended;
  er.updatedAt=Date.now();
}
function entryResearchPublic(){
  const er=mem.entryResearch||freshEntryResearch();
  const profiles={};
  Object.entries(ENTRY_RESEARCH_PROFILES).forEach(([name,cfg])=>{
    const st=er.profiles?.[name]||freshEntryResearchStat();
    const recent=Array.isArray(st.recent)?st.recent:[];
    profiles[name]={
      ...cfg,
      accepted:st.accepted,
      matches:st.matches,
      matchRate:st.accepted?st.matches/st.accepted:UNIFORM,
      posteriorRate:entryPosteriorRate(st),
      recentMatchRate:recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:UNIFORM,
      coverage:er.resolved?st.accepted/er.resolved:0
    };
  });
  const recommended=Object.prototype.hasOwnProperty.call(ENTRY_RESEARCH_PROFILES,er.recommended)?er.recommended:'balanced';
  return {
    resolved:er.resolved,
    recommended,
    ready:er.resolved>=1200 && (er.profiles?.[recommended]?.accepted||0)>=350,
    profile:profiles[recommended],
    profiles,
    updatedAt:er.updatedAt
  };
}

function freshTournamentStat(){
  return {
    samples:0,wins:0,matches:0,matchRate:UNIFORM,
    brierEWMA:.09,logLossEWMA:Math.log(10),
    recent:[]
  };
}
function freshTournament(){
  const candidates={};
  TOURNAMENT_NAMES.forEach(name=>candidates[name]=freshTournamentStat());
  return {
    champion:'base',
    promotions:0,
    lastPromotionAt:0,
    lastPromotionTick:0,
    candidates
  };
}

function freshShadow(){
  return {
    total:0,wins:0,matches:0,matchRate:UNIFORM,edgeVsBaseline:0,
    recent:[],
    performance:freshPerf(),
    calibration:freshCalibration(),
    drift:freshDrift(),
    tournament:freshTournament(),
    last:null
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
    motionModels:{1:{},2:{},3:{}},
    phaseModels:{1:{},2:{},3:{}},
    movementModels:{1:{},2:{},3:{}},
    moveDigitModels:{1:{},2:{},3:{}},
    movementBucketStats:{
      1:Array.from({length:7},()=>({n:0,sum:0})),
      2:Array.from({length:7},()=>({n:0,sum:0})),
      3:Array.from({length:7},()=>({n:0,sum:0}))
    },
    movementPerf:{1:freshMovePerf(),2:freshMovePerf(),3:freshMovePerf()},
    rangeModels:{1:{},2:{},3:{}},
    rangePerf:{1:freshRangePerf(),2:freshRangePerf(),3:freshRangePerf()},
    globalP: blankP(),
    globalN: 0,
    modelLoss: {},
    delayEWMA: 1,
    lastMarketEpoch: 0,
    deepHistory: [],
    deepPrices: [],
    collaborative: freshCollaborative(),
    master: freshMasterBrain(),
    entryResearch:freshEntryResearch(),
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
  m.motionModels=m.motionModels&&typeof m.motionModels==='object'?m.motionModels:base.motionModels;
  HORIZONS.forEach(h=>{m.motionModels[h]=m.motionModels[h]&&typeof m.motionModels[h]==='object'?m.motionModels[h]:{}});
  m.phaseModels=m.phaseModels&&typeof m.phaseModels==='object'?m.phaseModels:base.phaseModels;
  HORIZONS.forEach(h=>{m.phaseModels[h]=m.phaseModels[h]&&typeof m.phaseModels[h]==='object'?m.phaseModels[h]:{}});
  m.movementModels=m.movementModels&&typeof m.movementModels==='object'?m.movementModels:base.movementModels;
  m.moveDigitModels=m.moveDigitModels&&typeof m.moveDigitModels==='object'?m.moveDigitModels:base.moveDigitModels;
  m.movementBucketStats=m.movementBucketStats&&typeof m.movementBucketStats==='object'?m.movementBucketStats:base.movementBucketStats;
  m.movementPerf=m.movementPerf&&typeof m.movementPerf==='object'?m.movementPerf:base.movementPerf;
  HORIZONS.forEach(h=>{
    m.movementModels[h]=m.movementModels[h]&&typeof m.movementModels[h]==='object'?m.movementModels[h]:{};
    m.moveDigitModels[h]=m.moveDigitModels[h]&&typeof m.moveDigitModels[h]==='object'?m.moveDigitModels[h]:{};
    const rawStats=Array.isArray(m.movementBucketStats[h])?m.movementBucketStats[h]:[];
    m.movementBucketStats[h]=Array.from({length:7},(_,i)=>({
      n:Math.max(0,Math.floor(safeNum(rawStats[i]?.n,0))),
      sum:safeNum(rawStats[i]?.sum,0)
    }));
    const p=m.movementPerf[h]||{};
    m.movementPerf[h]={
      samples:Math.max(0,Math.floor(safeNum(p.samples,0))),
      logLossEWMA:clamp(safeNum(p.logLossEWMA,MOVE_BASE_LOGLOSS),.01,12),
      brierEWMA:clamp(safeNum(p.brierEWMA,MOVE_BASE_BRIER),0,1),
      directionHitEWMA:clamp(safeNum(p.directionHitEWMA,1/3),0,1),
      maeUnitsEWMA:Math.max(0,safeNum(p.maeUnitsEWMA,6)),
      lastAt:Math.max(0,safeNum(p.lastAt,0))
    };
  });

  m.rangeModels=m.rangeModels&&typeof m.rangeModels==='object'?m.rangeModels:base.rangeModels;
  m.rangePerf=m.rangePerf&&typeof m.rangePerf==='object'?m.rangePerf:base.rangePerf;
  HORIZONS.forEach(h=>{
    const bucket=m.rangeModels[h]&&typeof m.rangeModels[h]==='object'?m.rangeModels[h]:{};
    const clean={};
    for(const [key,node] of Object.entries(bucket)){
      if(typeof key!=='string'||key.length>180)continue;
      clean[key]={
        state:Array.isArray(node?.state)&&node.state.length===3
          ?node.state.map(v=>Math.max(.0001,safeNum(v,1)))
          :[1,1,1],
        p:Array.isArray(node?.p)&&node.p.length===10?normalizeDist(node.p):blankP(),
        n:Math.max(0,Math.floor(safeNum(node?.n,0))),
        last:Math.max(0,Math.floor(safeNum(node?.last,0)))
      };
    }
    m.rangeModels[h]=clean;
    const rp=m.rangePerf[h]||{};
    m.rangePerf[h]={
      samples:Math.max(0,Math.floor(safeNum(rp.samples,0))),
      logLossEWMA:clamp(safeNum(rp.logLossEWMA,RANGE_BASE_LOGLOSS),.01,8),
      brierEWMA:clamp(safeNum(rp.brierEWMA,RANGE_BASE_BRIER),0,1),
      accuracyEWMA:clamp(safeNum(rp.accuracyEWMA,1/3),0,1),
      lastAt:Math.max(0,safeNum(rp.lastAt,0))
    };
  });

  m.globalP = Array.isArray(m.globalP) && m.globalP.length===10 ? normalizeDist(m.globalP) : blankP();
  m.modelLoss = m.modelLoss || {};
  m.deepHistory = Array.isArray(m.deepHistory)
    ? m.deepHistory.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=9).slice(-MAX_HIST)
    : [];
  m.deepPrices = Array.isArray(m.deepPrices)
    ? m.deepPrices.map(Number).filter(Number.isFinite).slice(-MAX_HIST)
    : [];
  m.lastMarketEpoch = safeNum(m.lastMarketEpoch,0);

  const rawCol=m.collaborative && typeof m.collaborative==='object' ? m.collaborative : freshCollaborative();
  const col={...freshCollaborative(),...rawCol};
  col.received=Math.max(0,safeNum(col.received,0));
  col.accepted=Math.max(0,safeNum(col.accepted,0));
  col.duplicates=Math.max(0,safeNum(col.duplicates,0));
  col.wins=Math.max(0,safeNum(col.wins,0));
  col.matches=Math.max(0,safeNum(col.matches,0));
  col.matchRate=col.accepted?col.matches/col.accepted:UNIFORM;
  col.lastAt=Math.max(0,safeNum(col.lastAt,0));
  col.updatedAt=Math.max(0,safeNum(col.updatedAt,0));
  col.byDigit=Array.from({length:10},(_,d)=>{
    const n=rawCol.byDigit?.[d]||{};
    return {n:Math.max(0,safeNum(n.n,0)),matches:Math.max(0,safeNum(n.matches,0)),last:Math.max(0,safeNum(n.last,0))};
  });
  col.contexts=col.contexts && typeof col.contexts==='object' ? col.contexts : {};
  for(const [k,n] of Object.entries(col.contexts)){
    if(!/^\d{1,2}>\d$/.test(k)){delete col.contexts[k];continue}
    col.contexts[k]={n:Math.max(0,safeNum(n?.n,0)),matches:Math.max(0,safeNum(n?.matches,0)),last:Math.max(0,safeNum(n?.last,0))};
  }
  col.seen=col.seen && typeof col.seen==='object' ? col.seen : {};
  const seenEntries=Object.entries(col.seen).sort((a,b)=>safeNum(b[1],0)-safeNum(a[1],0)).slice(0,5000);
  col.seen=Object.fromEntries(seenEntries);
  m.collaborative=col;

  const rawMaster=m.master&&typeof m.master==='object'?m.master:freshMasterBrain();
  const master={...freshMasterBrain(),...rawMaster};
  master.version=MASTER_BRAIN_VERSION;
  master.revision=Math.max(0,Math.floor(safeNum(master.revision,0)));
  master.updatedAt=Math.max(0,safeNum(master.updatedAt,0));
  master.counterfactualTicks=Math.max(0,Math.floor(safeNum(master.counterfactualTicks,0)));
  master.digitCalibration=Array.from({length:10},(_,d)=>{
    const x=Array.isArray(rawMaster.digitCalibration)?rawMaster.digitCalibration[d]:null;
    return {
      n:Math.max(0,Math.floor(safeNum(x?.n,0))),
      matches:Math.max(0,Math.floor(safeNum(x?.matches,0))),
      predictedSum:Math.max(0,safeNum(x?.predictedSum,0))
    };
  });
  master.rankStats=Array.from({length:10},(_,rank)=>{
    const x=Array.isArray(rawMaster.rankStats)?rawMaster.rankStats[rank]:null;
    return {
      n:Math.max(0,Math.floor(safeNum(x?.n,0))),
      matches:Math.max(0,Math.floor(safeNum(x?.matches,0)))
    };
  });
  master.errorContexts=Array.isArray(rawMaster.errorContexts)?rawMaster.errorContexts.slice(-220).map(x=>({
    ctx:String(x?.ctx||'').slice(-3),
    digit:Math.max(0,Math.min(9,Math.floor(safeNum(x?.digit,0)))),
    ts:Math.max(0,safeNum(x?.ts,0)),
    risk:clamp(safeNum(x?.risk,UNIFORM),0,.5)
  })):[];
  const baseStreak=freshStreakStats(),rawStreak=rawMaster.streakStats&&typeof rawMaster.streakStats==='object'?rawMaster.streakStats:{};
  master.streakStats={};
  Object.keys(baseStreak).forEach(k=>{
    const x=rawStreak[k]||{};
    master.streakStats[k]={
      n:Math.max(0,Math.floor(safeNum(x.n,0))),
      matches:Math.max(0,Math.floor(safeNum(x.matches,0)))
    };
  });
  const rawSa=rawMaster.sessionAnalytics&&typeof rawMaster.sessionAnalytics==='object'?rawMaster.sessionAnalytics:{};
  const sa={...freshSessionAnalytics(),...rawSa};
  ['sessionsStarted','sessionsCompleted','sessionsStopped','tradesObserved','matches','earlyMatches','matchPositionSum','maxPosition','lastMatchPosition','lastCompletionPosition','updatedAt'].forEach(k=>{
    sa[k]=Math.max(0,Math.floor(safeNum(sa[k],0)));
  });
  sa.byPosition=Array.from({length:50},(_,i)=>{
    const x=Array.isArray(rawSa.byPosition)?rawSa.byPosition[i]:null;
    return {
      trades:Math.max(0,Math.floor(safeNum(x?.trades,0))),
      matches:Math.max(0,Math.floor(safeNum(x?.matches,0))),
      completions:Math.max(0,Math.floor(safeNum(x?.completions,0)))
    };
  });
  const of=rawSa.overflow&&typeof rawSa.overflow==='object'?rawSa.overflow:{};
  sa.overflow={
    trades:Math.max(0,Math.floor(safeNum(of.trades,0))),
    matches:Math.max(0,Math.floor(safeNum(of.matches,0))),
    completions:Math.max(0,Math.floor(safeNum(of.completions,0)))
  };
  const seen=rawSa.seen&&typeof rawSa.seen==='object'?rawSa.seen:{};
  sa.seen=Object.fromEntries(
    Object.entries(seen)
      .filter(([k])=>typeof k==='string'&&k.length<=96)
      .sort((a,b)=>safeNum(b[1],0)-safeNum(a[1],0))
      .slice(0,6000)
  );
  master.sessionAnalytics=sa;
  m.master=master;
  m.entryResearch=normalizeEntryResearch(m.entryResearch);

  const sh = m.shadow && typeof m.shadow==='object' ? m.shadow : freshShadow();
  m.shadow = {...freshShadow(), ...sh};

  m.shadow.performance = {...freshPerf(), ...(sh.performance||{})};
  MODEL_NAMES.forEach(name=>{
    const p=m.shadow.performance[name]||{};
    m.shadow.performance[name]={
      samples:safeNum(p.samples,0),
      logLossEWMA:safeNum(p.logLossEWMA,Math.log(10)),
      matchEWMA:clamp(safeNum(p.matchEWMA,UNIFORM),0,1),
      weight:clamp(safeNum(p.weight,1),.12,5),
      cumulativeLoss:Math.max(0,safeNum(p.cumulativeLoss,0))
    };
  });

  const c={...freshCalibration(), ...(sh.calibration||{})};
  c.bins=Array.isArray(c.bins)&&c.bins.length===CAL_BINS
    ? c.bins.map(b=>({n:Math.max(0,safeNum(b?.n,0)),matches:Math.max(0,safeNum(b?.matches,0))}))
    : freshCalibration().bins;
  c.samples=Math.max(0,safeNum(c.samples,0));
  c.brierEWMA=clamp(safeNum(c.brierEWMA,.09),0,1);
  c.predictedEWMA=clamp(safeNum(c.predictedEWMA,UNIFORM),0,1);
  c.observedEWMA=clamp(safeNum(c.observedEWMA,UNIFORM),0,1);
  c.ece=clamp(safeNum(c.ece,0),0,1);
  m.shadow.calibration=c;

  const d={...freshDrift(), ...(sh.drift||{})};
  d.events=Math.max(0,safeNum(d.events,0));
  d.active=!!d.active;
  d.boostRemaining=Math.max(0,safeNum(d.boostRemaining,0));
  d.lastAt=Math.max(0,safeNum(d.lastAt,0));
  d.lastTick=Math.max(0,safeNum(d.lastTick,0));
  d.score=Math.max(0,safeNum(d.score,0));
  d.epsilon=Math.max(0,safeNum(d.epsilon,0));
  d.cut=Math.max(0,safeNum(d.cut,0));
  d.lossWindow=Array.isArray(d.lossWindow)
    ? d.lossWindow.map(v=>clamp(safeNum(v,0),0,1)).slice(-DRIFT_MAX_WINDOW)
    : [];
  m.shadow.drift=d;

  const rawTournament=sh.tournament&&typeof sh.tournament==='object'?sh.tournament:freshTournament();
  const tournament={...freshTournament(),...rawTournament};
  tournament.champion=TOURNAMENT_NAMES.includes(tournament.champion)?tournament.champion:'base';
  tournament.promotions=Math.max(0,Math.floor(safeNum(tournament.promotions,0)));
  tournament.lastPromotionAt=Math.max(0,safeNum(tournament.lastPromotionAt,0));
  tournament.lastPromotionTick=Math.max(0,safeNum(tournament.lastPromotionTick,0));
  tournament.candidates={};
  TOURNAMENT_NAMES.forEach(name=>{
    const raw=rawTournament.candidates?.[name]||{};
    const st={...freshTournamentStat(),...raw};
    st.samples=Math.max(0,Math.floor(safeNum(st.samples,0)));
    st.wins=Math.max(0,Math.floor(safeNum(st.wins,0)));
    st.matches=Math.max(0,Math.floor(safeNum(st.matches,0)));
    st.matchRate=st.samples?st.matches/st.samples:UNIFORM;
    st.brierEWMA=clamp(safeNum(st.brierEWMA,.09),0,1);
    st.logLossEWMA=clamp(safeNum(st.logLossEWMA,Math.log(10)),.01,12);
    st.recent=Array.isArray(st.recent)?st.recent.map(x=>x?1:0).slice(-TOURNAMENT_RECENT):[];
    tournament.candidates[name]=st;
  });
  m.shadow.tournament=tournament;

  m.shadow.recent = Array.isArray(m.shadow.recent) ? m.shadow.recent.slice(-SHADOW_RECENT_MAX) : [];
  return m;
}

function freshRiseFallPerf(){
  return {
    resolved:0,
    actionSamples:0,
    actionWins:0,
    directionHitEWMA:.5,
    brierEWMA:2/9,
    logLossEWMA:Math.log(3),
    lastAt:0
  };
}
function freshRiseFallOperationLearning(){
  return {
    total:0,wins:0,losses:0,
    byAction:{RISE:{n:0,wins:0},FALL:{n:0,wins:0}},
    byHorizon:{1:{n:0,wins:0},2:{n:0,wins:0},3:{n:0,wins:0}},
    confidenceBins:Array.from({length:10},()=>({n:0,wins:0})),
    seen:{},updatedAt:0
  };
}
function freshRiseFallMemory(){
  const models={1:{},2:{},3:{}};
  const global={
    1:{counts:[1,1,1],n:0},
    2:{counts:[1,1,1],n:0},
    3:{counts:[1,1,1],n:0}
  };
  return {
    version:1,
    createdAt:Date.now(),
    updatedAt:Date.now(),
    tickCount:0,
    trainedSamples:0,
    models,
    global,
    performance:{1:freshRiseFallPerf(),2:freshRiseFallPerf(),3:freshRiseFallPerf()},
    operationLearning:freshRiseFallOperationLearning(),
    lastEpoch:0,
    saves:0
  };
}
function normalizeRiseFallMemory(x){
  const base=freshRiseFallMemory();
  if(!x||safeNum(x.version,0)!==1)return base;
  const m={...base,...x};
  m.models=m.models&&typeof m.models==='object'?m.models:base.models;
  m.global=m.global&&typeof m.global==='object'?m.global:base.global;
  m.performance=m.performance&&typeof m.performance==='object'?m.performance:base.performance;
  HORIZONS.forEach(h=>{
    m.models[h]=m.models[h]&&typeof m.models[h]==='object'?m.models[h]:{};
    const g=m.global[h]||{};
    m.global[h]={
      counts:Array.from({length:3},(_,i)=>Math.max(.001,safeNum(g.counts?.[i],1))),
      n:Math.max(0,Math.floor(safeNum(g.n,0)))
    };
    const p=m.performance[h]||{};
    m.performance[h]={
      resolved:Math.max(0,Math.floor(safeNum(p.resolved,0))),
      actionSamples:Math.max(0,Math.floor(safeNum(p.actionSamples,0))),
      actionWins:Math.max(0,Math.floor(safeNum(p.actionWins,0))),
      directionHitEWMA:clamp(safeNum(p.directionHitEWMA,.5),0,1),
      brierEWMA:clamp(safeNum(p.brierEWMA,2/9),0,1),
      logLossEWMA:clamp(safeNum(p.logLossEWMA,Math.log(3)),.01,8),
      lastAt:Math.max(0,safeNum(p.lastAt,0))
    };
  });
  const rawOps=m.operationLearning&&typeof m.operationLearning==='object'?m.operationLearning:{};
  const ops=freshRiseFallOperationLearning();
  ops.total=Math.max(0,Math.floor(safeNum(rawOps.total,0)));
  ops.wins=Math.max(0,Math.floor(safeNum(rawOps.wins,0)));
  ops.losses=Math.max(0,Math.floor(safeNum(rawOps.losses,Math.max(0,ops.total-ops.wins))));
  ['RISE','FALL'].forEach(name=>{
    const x=rawOps.byAction?.[name]||{};
    ops.byAction[name]={n:Math.max(0,Math.floor(safeNum(x.n,0))),wins:Math.max(0,Math.floor(safeNum(x.wins,0)))};
  });
  [1,2,3].forEach(h=>{
    const x=rawOps.byHorizon?.[h]||{};
    ops.byHorizon[h]={n:Math.max(0,Math.floor(safeNum(x.n,0))),wins:Math.max(0,Math.floor(safeNum(x.wins,0)))};
  });
  ops.confidenceBins=Array.from({length:10},(_,i)=>{
    const x=Array.isArray(rawOps.confidenceBins)?rawOps.confidenceBins[i]:null;
    return {n:Math.max(0,Math.floor(safeNum(x?.n,0))),wins:Math.max(0,Math.floor(safeNum(x?.wins,0)))};
  });
  const seen=rawOps.seen&&typeof rawOps.seen==='object'?rawOps.seen:{};
  ops.seen=Object.fromEntries(
    Object.entries(seen)
      .filter(([k])=>typeof k==='string'&&k.length<=96)
      .sort((a,b)=>safeNum(b[1],0)-safeNum(a[1],0))
      .slice(0,2500)
  );
  ops.updatedAt=Math.max(0,safeNum(rawOps.updatedAt,0));
  m.operationLearning=ops;

  m.tickCount=Math.max(0,Math.floor(safeNum(m.tickCount,0)));
  m.trainedSamples=Math.max(0,Math.floor(safeNum(m.trainedSamples,0)));
  m.lastEpoch=Math.max(0,Math.floor(safeNum(m.lastEpoch,0)));
  return m;
}
function loadRiseFallMemory(){
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    if(!fs.existsSync(RISE_FALL_FILE))return freshRiseFallMemory();
    return normalizeRiseFallMemory(JSON.parse(fs.readFileSync(RISE_FALL_FILE,'utf8')));
  }catch(e){
    console.error('Rise/Fall memory load error:',e.message);
    return freshRiseFallMemory();
  }
}
let riseFallMem=loadRiseFallMemory();

function saveRiseFallMemory(){
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    riseFallMem.updatedAt=Date.now();
    riseFallMem.saves=(riseFallMem.saves||0)+1;
    const tmp=RISE_FALL_FILE+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(riseFallMem));
    fs.renameSync(tmp,RISE_FALL_FILE);
  }catch(e){
    console.error('Rise/Fall memory save error:',e.message);
  }
}
function riseFallOutcomeIndex(sourcePrice,targetPrice){
  const a=Number(sourcePrice),b=Number(targetPrice);
  if(!Number.isFinite(a)||!Number.isFinite(b))return 1;
  if(b>a)return 2;
  if(b<a)return 0;
  return 1;
}
function riseFallNorm3(xs){
  const a=Array.from({length:3},(_,i)=>Math.max(.000001,safeNum(xs?.[i],1)));
  const s=a.reduce((x,y)=>x+y,0)||1;
  return a.map(x=>x/s);
}
function riseFallContextKeys(snap){
  if(!snap)return [];
  const phase=marketPhaseFromMotion(snap);
  return [
    {key:'PH:'+phase+'|V'+snap.volatility,need:70,w:1.00},
    {key:'DIR:'+snap.direction+'|S'+snap.strength+'|A'+snap.accel,need:95,w:.82},
    {key:'MIC:'+snap.microDir+'|F'+snap.microForce+'|T'+snap.trendBand,need:65,w:1.08},
    {key:'TURN:'+snap.turn+'|'+phase+'|'+snap.accel,need:55,w:1.16}
  ];
}
function riseFallNode(h,key){
  const bucket=riseFallMem.models[h];
  if(!bucket[key])bucket[key]={counts:[1,1,1],n:0,last:riseFallMem.tickCount};
  return bucket[key];
}
function riseFallLearnOne(h,snap,outcome){
  const g=riseFallMem.global[h];
  g.counts[outcome]+=1;
  g.n++;
  riseFallContextKeys(snap).forEach(k=>{
    const n=riseFallNode(h,k.key);
    n.counts[outcome]+=1;
    n.n++;
    n.last=riseFallMem.tickCount;
  });
  riseFallMem.trainedSamples++;
}
function riseFallOwnDistribution(h,snap){
  const g=riseFallMem.global[h];
  const gp=riseFallNorm3(g.counts);
  const acc=gp.map(x=>x*.38),den=Array(3).fill(.38);
  let supportSum=0,used=0,totalN=0;
  riseFallContextKeys(snap).forEach(k=>{
    const node=riseFallMem.models[h]?.[k.key];
    if(!node)return;
    const support=1-Math.exp(-safeNum(node.n,0)/k.need);
    const w=k.w*support;
    const p=riseFallNorm3(node.counts);
    for(let i=0;i<3;i++){acc[i]+=p[i]*w;den[i]+=w}
    supportSum+=support;
    used++;
    totalN+=safeNum(node.n,0);
  });
  const p=riseFallNorm3(acc.map((x,i)=>x/(den[i]||1)));
  return {p,support:used?supportSum/used:0,n:totalN+safeNum(g.n,0)};
}
function riseFallPosterior(stat,priorRate=.52,priorN=18){
  const n=Math.max(0,safeNum(stat?.n,0));
  const wins=Math.max(0,safeNum(stat?.wins,0));
  return (wins+priorN*priorRate)/(n+priorN);
}
function riseFallOperationGate(action,h,probability){
  const ops=riseFallMem.operationLearning||freshRiseFallOperationLearning();
  const a=ops.byAction?.[action]||{n:0,wins:0};
  const hz=ops.byHorizon?.[h]||{n:0,wins:0};
  const binIndex=clamp(Math.floor(clamp(safeNum(probability,.5),.5,.999)*10),0,9);
  const bin=ops.confidenceBins?.[binIndex]||{n:0,wins:0};

  const parts=[
    {n:a.n,rate:riseFallPosterior(a)},
    {n:hz.n,rate:riseFallPosterior(hz)},
    {n:bin.n,rate:riseFallPosterior(bin)}
  ].filter(x=>x.n>0);
  const weight=parts.reduce((s,x)=>s+Math.min(120,x.n),0);
  const learnedRate=weight
    ? parts.reduce((s,x)=>s+x.rate*Math.min(120,x.n),0)/weight
    : .52;
  const samples=Math.max(a.n,hz.n,bin.n);

  let minProbability=.56;
  if(samples>=30){
    if(learnedRate<.49)minProbability=.62;
    else if(learnedRate<.515)minProbability=.60;
    else if(learnedRate<.535)minProbability=.58;
  }
  return {
    samples,
    learnedWinRate:clamp(learnedRate,0,1),
    minProbability,
    totalOperations:ops.total,
    totalWins:ops.wins,
    totalLosses:ops.losses,
    overallWinRate:ops.total?ops.wins/ops.total:.5
  };
}
function recordRiseFallDemoOperation(b){
  const ops=riseFallMem.operationLearning||(riseFallMem.operationLearning=freshRiseFallOperationLearning());
  const id=typeof b.id==='string'&&/^[A-Za-z0-9:_-]{6,96}$/.test(b.id)?b.id:'';
  const action=b.action==='RISE'||b.action==='FALL'?b.action:'';
  const h=Math.floor(safeNum(b.horizon,0));
  const probability=safeNum(b.probability,NaN);
  const profit=safeNum(b.profit,NaN);
  const breakEven=safeNum(b.breakEven,NaN);
  const signalEpoch=Math.floor(safeNum(b.signalEpoch,0));

  if(b.mode!=='demo'||!id||!action||h<1||h>3||
     !Number.isFinite(probability)||probability<.45||probability>1||
     !Number.isFinite(profit)||Math.abs(profit)>100000||
     !Number.isFinite(breakEven)||breakEven<=0||breakEven>1||
     !signalEpoch){
    return {ok:false,error:'invalid rise/fall demo experience'};
  }
  if(ops.seen[id])return {ok:true,accepted:false,duplicate:true,summary:riseFallOperationGate(action,h,probability)};

  ops.seen[id]=Date.now();
  const entries=Object.entries(ops.seen);
  if(entries.length>2500){
    entries.sort((x,y)=>safeNum(y[1],0)-safeNum(x[1],0));
    ops.seen=Object.fromEntries(entries.slice(0,2500));
  }

  const win=profit>0;
  ops.total++;
  if(win)ops.wins++;else ops.losses++;

  const a=ops.byAction[action];
  a.n++; if(win)a.wins++;

  const hz=ops.byHorizon[h];
  hz.n++; if(win)hz.wins++;

  const binIndex=clamp(Math.floor(clamp(probability,.5,.999)*10),0,9);
  const bin=ops.confidenceBins[binIndex];
  bin.n++; if(win)bin.wins++;

  ops.updatedAt=Date.now();
  riseFallMem.updatedAt=Date.now();
  if(ops.total%5===0)saveRiseFallMemory();

  return {ok:true,accepted:true,duplicate:false,summary:riseFallOperationGate(action,h,probability)};
}

function riseFallPredict(h=1){
  h=clamp(Math.round(safeNum(h,1)),1,3);
  const snap=motionSnapshot();
  if(!snap)return null;
  const own=riseFallOwnDistribution(h,snap);
  let p=own.p.slice();

  // Lectura unidireccional del predictor de movimiento de DIFFER.
  // Rise/Fall puede usarla como evidencia, pero nunca escribe de regreso en DIFFER.
  const move=movementForecast(h);
  if(move){
    const ext=riseFallNorm3([move.down,move.flat,move.up]);
    const readOnlyWeight=clamp(.12+.20*safeNum(move.support,0),.12,.32);
    p=riseFallNorm3(p.map((x,i)=>(1-readOnlyWeight)*x+readOnlyWeight*ext[i]));
  }

  const down=p[0],flat=p[1],up=p[2];
  const direction=up>=down?'RISE':'FALL';
  const directionProbability=Math.max(up,down);
  const gap=Math.abs(up-down);
  const operationGate=riseFallOperationGate(direction,h,directionProbability);
  const minDirectionalProbability=Math.max(.56,safeNum(operationGate.minProbability,.56));
  let action='WAIT';
  if(up>=minDirectionalProbability&&gap>=.065&&flat<=.30)action='RISE';
  else if(down>=minDirectionalProbability&&gap>=.065&&flat<=.30)action='FALL';

  const perf=riseFallMem.performance[h]||freshRiseFallPerf();
  const actionWinRate=perf.actionSamples?perf.actionWins/perf.actionSamples:.5;
  const ready=
    perf.resolved>=900 &&
    perf.actionSamples>=450 &&
    perf.directionHitEWMA>=.535 &&
    perf.brierEWMA<=(2/9)-.004 &&
    perf.logLossEWMA<=Math.log(3)-.010 &&
    actionWinRate>=.53;

  return {
    horizon:h,
    signalEpoch:lastEpoch,
    generatedAt:Date.now(),
    action,
    direction,
    directionProbability,
    probabilities:{FALL:down,FLAT:flat,RISE:up},
    confidence:clamp((directionProbability-.5)*2*(.55+.45*own.support),0,1),
    support:clamp(own.support,0,1),
    phase:marketPhaseFromMotion(snap),
    motion:{
      direction:snap.direction,
      strength:snap.strength,
      accel:snap.accel,
      turn:snap.turn,
      microDir:snap.microDir,
      microForce:snap.microForce
    },
    expectedUnits:move?safeNum(move.expectedUnits,0):0,
    reversalProbability:move?clamp(safeNum(move.reversalProbability,0),0,1):0,
    continuationProbability:move?clamp(safeNum(move.continuationProbability,0),0,1):0,
    ready,
    operationLearning:operationGate,
    validation:{
      resolved:perf.resolved,
      actionSamples:perf.actionSamples,
      actionWins:perf.actionWins,
      actionWinRate,
      directionHitEWMA:perf.directionHitEWMA,
      brierEWMA:perf.brierEWMA,
      logLossEWMA:perf.logLossEWMA
    }
  };
}
function riseFallResolve(targetPrice,counter){
  if(!riseFallPending.length||!Number.isFinite(Number(targetPrice)))return;
  const due=[],keep=[];
  riseFallPending.forEach(x=>(x.due<=counter?due:keep).push(x));
  riseFallPending=keep.slice(-30);

  due.forEach(item=>{
    const actual=riseFallOutcomeIndex(item.sourcePrice,targetPrice);
    const p=riseFallNorm3(item.p);
    const perf=riseFallMem.performance[item.h]||(riseFallMem.performance[item.h]=freshRiseFallPerf());
    const prob=clamp(p[actual],.0001,.9999);
    const logLoss=-Math.log(prob);
    let brier=0;
    for(let i=0;i<3;i++){
      const y=i===actual?1:0,e=p[i]-y;
      brier+=e*e;
    }
    brier/=3;

    perf.resolved++;
    const a=perf.resolved<300?.025:.0075;
    perf.logLossEWMA=(1-a)*safeNum(perf.logLossEWMA,Math.log(3))+a*logLoss;
    perf.brierEWMA=(1-a)*safeNum(perf.brierEWMA,2/9)+a*brier;

    const actualDir=actual===2?'RISE':actual===0?'FALL':'FLAT';
    if(actualDir!=='FLAT'){
      const predicted=item.up>=item.down?'RISE':'FALL';
      const hit=predicted===actualDir?1:0;
      perf.directionHitEWMA=(1-a)*safeNum(perf.directionHitEWMA,.5)+a*hit;
      if(item.action==='RISE'||item.action==='FALL'){
        perf.actionSamples++;
        if(item.action===actualDir)perf.actionWins++;
      }
    }
    perf.lastAt=Date.now();
  });
}
function riseFallLearnOutcome(targetPrice){
  const n=Math.min(hist.length,priceHist.length,motionHist.length);
  for(const h of HORIZONS){
    const signalIndex=n-h;
    if(signalIndex<0)continue;
    const sourcePrice=Number(priceHist[signalIndex]);
    const snap=motionHist[signalIndex];
    if(!Number.isFinite(sourcePrice)||!snap)continue;
    const outcome=riseFallOutcomeIndex(sourcePrice,targetPrice);
    riseFallLearnOne(h,snap,outcome);
  }
  riseFallMem.tickCount++;
}
function riseFallSchedule(counter){
  for(const h of HORIZONS){
    const pred=riseFallPredict(h);
    if(!pred||!priceHist.length)continue;
    riseFallPending.push({
      due:counter+h,
      h,
      sourcePrice:Number(priceHist[priceHist.length-1]),
      p:[pred.probabilities.FALL,pred.probabilities.FLAT,pred.probabilities.RISE],
      up:pred.probabilities.RISE,
      down:pred.probabilities.FALL,
      action:pred.action
    });
    if(h===1)riseFallLastPrediction=pred;
  }
  if(riseFallPending.length>30)riseFallPending=riseFallPending.slice(-30);
}
function bootstrapRiseFall(){
  if(riseFallBootstrapDone)return;
  riseFallBootstrapDone=true;
  if(riseFallMem.trainedSamples>500)return;
  const n=Math.min(hist.length,priceHist.length,motionHist.length);
  if(n<120)return;

  const start=Math.max(24,n-12000);
  let trained=0;
  for(let targetIndex=start;targetIndex<n;targetIndex++){
    const targetPrice=Number(priceHist[targetIndex]);
    if(!Number.isFinite(targetPrice))continue;
    for(const h of HORIZONS){
      const signalIndex=targetIndex-h;
      if(signalIndex<8)continue;
      const sourcePrice=Number(priceHist[signalIndex]);
      const snap=motionHist[signalIndex];
      if(!Number.isFinite(sourcePrice)||!snap)continue;
      riseFallLearnOne(h,snap,riseFallOutcomeIndex(sourcePrice,targetPrice));
      trained++;
    }
  }
  riseFallMem.tickCount+=Math.max(0,n-start);
  saveRiseFallMemory();
  console.log('Rise/Fall AI bootstrapped from history:',trained,'training samples');
}
function pruneRiseFall(){
  HORIZONS.forEach(h=>{
    const bucket=riseFallMem.models[h]||{};
    const keys=Object.keys(bucket);
    if(keys.length<=1800)return;
    keys.sort((a,b)=>safeNum(bucket[b]?.last,0)-safeNum(bucket[a]?.last,0));
    keys.slice(1800).forEach(k=>delete bucket[k]);
  });
}
function riseFallStatus(){
  return {
    ok:true,
    status,
    symbol:SYMBOL,
    isolated:true,
    persistence:'cloud',
    learnsWhenBrowserClosed:true,
    updatedAt:riseFallMem.updatedAt,
    tickCount:riseFallMem.tickCount,
    trainedSamples:riseFallMem.trainedSamples,
    operationLearning:{
      total:riseFallMem.operationLearning.total,
      wins:riseFallMem.operationLearning.wins,
      losses:riseFallMem.operationLearning.losses,
      winRate:riseFallMem.operationLearning.total?riseFallMem.operationLearning.wins/riseFallMem.operationLearning.total:.5,
      updatedAt:riseFallMem.operationLearning.updatedAt
    },
    predictions:{
      1:riseFallPredict(1),
      2:riseFallPredict(2),
      3:riseFallPredict(3)
    }
  };
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
priceHist = mem.deepPrices.slice(-MAX_HIST);
motionHist=[];
{
  const build=[];
  priceHist.forEach(v=>{build.push(v);motionHist.push(motionSnapshot(build))});
  if(motionHist.length<hist.length)motionHist=Array(hist.length-motionHist.length).fill(null).concat(motionHist);
}
lastEpoch = safeNum(mem.lastMarketEpoch,0);

function saveMemory(){
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    mem.updatedAt=Date.now();
    mem.saves=(mem.saves||0)+1;
    mem.deepHistory=hist.slice(-MAX_HIST);
    mem.deepPrices=priceHist.slice(-MAX_HIST);
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
function driftLearningBoost(){
  return mem.shadow.drift.boostRemaining>0 ? 1.55 : 1;
}
function learningRate(order,n){
  const base=order===1?.035:order===2?.050:.070;
  const support=Math.min(1,Math.max(0,n)/80);
  return clamp(base*(1-.25*support)*driftLearningBoost(),.01,.13);
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

function motionStd(xs){
  if(xs.length<2)return 0;
  const m=mean(xs);
  return Math.sqrt(mean(xs.map(x=>(x-m)*(x-m))));
}
function motionSnapshot(prices=priceHist){
  if(!Array.isArray(prices)||prices.length<8)return null;
  const p=prices.slice(-24).map(Number).filter(Number.isFinite);
  if(p.length<8)return null;
  const diffs=[];
  for(let i=1;i<p.length;i++)diffs.push(p[i]-p[i-1]);
  const scale=Math.max(1e-8,mean(diffs.slice(-12).map(Math.abs)));
  const slope=n=>p.length<=n?0:(p[p.length-1]-p[p.length-1-n])/(n*scale);
  const s3=slope(3),s6=slope(6),s10=slope(Math.min(10,p.length-1));
  const velocity=.55*s3+.30*s6+.15*s10;
  const acceleration=s3-s6;
  const absV=Math.abs(velocity);
  const direction=velocity>.22?'UP':velocity<-.22?'DOWN':'FLAT';
  const strength=absV>.95?'STRONG':absV>.42?'MED':'WEAK';
  const accel=acceleration>.35?'ACCEL':acceleration<-.35?'DECEL':'STEADY';
  const recentDiffs=diffs.slice(-12);
  const volRatio=motionStd(recentDiffs)/scale;
  const volatility=volRatio>1.25?'HIGH':volRatio<.72?'LOW':'MID';
  const signs=recentDiffs.slice(-5).map(x=>x>0?1:x<0?-1:0);
  const prior=signs.slice(0,-1).filter(Boolean);
  const last=signs[signs.length-1]||0;
  const majority=prior.length?Math.sign(prior.reduce((a,b)=>a+b,0)):0;
  const turn=last&&majority&&last!==majority?'TURN':'FLOW';

  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  const lastMoveUnits=Math.round((p[p.length-1]-p[p.length-2])/unit);
  const moves3=diffs.slice(-3).map(x=>Math.round(x/unit));
  const mean3=mean(moves3);
  const absUnits=Math.abs(lastMoveUnits);
  const microForce=absUnits<=1?'TINY':absUnits<=3?'SMALL':absUnits<=8?'MED':absUnits<=20?'LARGE':'JUMP';
  const microDir=lastMoveUnits>0?'UP':lastMoveUnits<0?'DOWN':'FLAT';
  const residue=((lastMoveUnits%10)+10)%10;
  const trendUnits=Math.round(mean3);
  const trendBand=trendUnits>=5?'UPFAST':trendUnits>=1?'UPSLOW':trendUnits<=-5?'DOWNFAST':trendUnits<=-1?'DOWNSLOW':'STABLE';
  const quoteText=p[p.length-1].toFixed(pip);
  const currentDigit=Number(quoteText[quoteText.length-1]);
  const microKey=[currentDigit,microDir,microForce,'R'+residue,trendBand].join('|');

  return {direction,strength,accel,volatility,turn,velocity,acceleration,volRatio,currentDigit,lastMoveUnits,microForce,microDir,residue,trendUnits,trendBand,microKey,key:[direction,strength,accel,volatility,turn].join('|')};
}
function ensureMotionNode(h,key){
  const bucket=mem.motionModels[h];
  if(!bucket[key])bucket[key]={p:blankP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function learnMotion(targetDigit,sourceHist){
  for(const h of HORIZONS){
    const signalIndex=sourceHist.length-h;
    if(signalIndex<0)continue;
    const snap=motionHist[signalIndex];
    if(!snap?.key)continue;
    const lastDigit=sourceHist[signalIndex];
    const keys=[
      {key:'M:'+snap.key,base:.030},
      {key:'MD:'+snap.key+'>D'+lastDigit,base:.040},
      {key:snap.microKey?'MICRO:'+snap.microKey:null,base:.044}
    ].filter(x=>x.key);
    keys.forEach((entry)=>{
      const node=ensureMotionNode(h,entry.key);
      const alpha=entry.base*driftLearningBoost();
      updateProb(node.p,targetDigit,clamp(alpha*(1-Math.min(.35,node.n/900)),.012,.070));
      node.n++;
      node.last=mem.tickCount;
    });
  }
}
function motionDist(){
  const snap=motionSnapshot();
  if(!snap?.key||!hist.length)return null;
  const lastDigit=hist[hist.length-1];
  const keys=[
    {key:'M:'+snap.key,need:45,base:.70},
    {key:'MD:'+snap.key+'>D'+lastDigit,need:28,base:1.00},
    {key:snap.microKey?'MICRO:'+snap.microKey:null,need:24,base:1.18}
  ].filter(x=>x.key);
  const num=Array(10).fill(0),den=Array(10).fill(0);
  let evidence=0,totalN=0;
  keys.forEach((entry)=>{
    const node=mem.motionModels[1]?.[entry.key];
    if(!node)return;
    const support=1-Math.exp(-safeNum(node.n,0)/entry.need);
    const w=entry.base*support;
    if(w<=.01)return;
    for(let d=0;d<10;d++){num[d]+=safeNum(node.p[d],UNIFORM)*w;den[d]+=w}
    evidence+=support;totalN+=safeNum(node.n,0);
  });
  if(totalN<1)return null;
  return {p:normalizeDist(num.map((x,d)=>x/(den[d]||1))),support:clamp(evidence/keys.length,0,1),n:totalN,state:snap};
}

function marketPhaseFromMotion(s){
  if(!s)return 'UNKNOWN';
  const dir=s.direction, micro=s.microDir, turn=s.turn;
  const v=Math.abs(safeNum(s.velocity,0));
  const a=safeNum(s.acceleration,0);

  if(turn==='TURN' && micro==='UP')return 'TURN_UP';
  if(turn==='TURN' && micro==='DOWN')return 'TURN_DOWN';
  if(dir==='FLAT'||(v<.28&&Math.abs(safeNum(s.trendUnits,0))<=1))return 'RANGE';

  if(dir==='UP' && micro==='DOWN')return 'PULLBACK_DOWN';
  if(dir==='DOWN' && micro==='UP')return 'PULLBACK_UP';

  if(dir==='UP' && a<-.20)return 'EXHAUST_UP';
  if(dir==='DOWN' && a>.20)return 'EXHAUST_DOWN';

  if(dir==='UP' && (s.strength==='STRONG'||a>.35||s.trendBand==='UPFAST'))return 'IMPULSE_UP';
  if(dir==='DOWN' && (s.strength==='STRONG'||a<-.35||s.trendBand==='DOWNFAST'))return 'IMPULSE_DOWN';

  if(dir==='UP')return 'CONTINUE_UP';
  if(dir==='DOWN')return 'CONTINUE_DOWN';
  return 'RANGE';
}
function phaseLabel(phase){
  return String(phase||'UNKNOWN');
}
function ensurePhaseNode(h,key){
  const bucket=mem.phaseModels[h];
  if(!bucket[key])bucket[key]={p:blankP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function learnPhase(targetDigit,sourceHist){
  for(const h of HORIZONS){
    const signalIndex=sourceHist.length-h;
    if(signalIndex<0)continue;
    const snap=motionHist[signalIndex];
    if(!snap)continue;
    const phase=marketPhaseFromMotion(snap);
    if(phase==='UNKNOWN')continue;
    const lastDigit=sourceHist[signalIndex];
    const keys=[
      {key:'P:'+phase+'|V'+snap.volatility,base:.034},
      {key:'PD:'+phase+'|V'+snap.volatility+'>D'+lastDigit,base:.042},
      {key:'PF:'+phase+'|F'+snap.microForce+'|T'+snap.trendBand,base:.040}
    ];
    keys.forEach(entry=>{
      const node=ensurePhaseNode(h,entry.key);
      const alpha=entry.base*driftLearningBoost();
      updateProb(node.p,targetDigit,clamp(alpha*(1-Math.min(.35,node.n/1000)),.010,.060));
      node.n++;
      node.last=mem.tickCount;
    });
  }
}
function phaseDist(){
  const snap=motionSnapshot();
  if(!snap||!hist.length)return null;
  const phase=marketPhaseFromMotion(snap);
  if(phase==='UNKNOWN')return null;
  const lastDigit=hist[hist.length-1];
  const keys=[
    {key:'P:'+phase+'|V'+snap.volatility,need:55,base:.72},
    {key:'PD:'+phase+'|V'+snap.volatility+'>D'+lastDigit,need:34,base:1.05},
    {key:'PF:'+phase+'|F'+snap.microForce+'|T'+snap.trendBand,need:38,base:.92}
  ];
  const num=Array(10).fill(0),den=Array(10).fill(0);
  let evidence=0,totalN=0;
  keys.forEach(entry=>{
    const node=mem.phaseModels[1]?.[entry.key];
    if(!node)return;
    const support=1-Math.exp(-safeNum(node.n,0)/entry.need);
    const w=entry.base*support;
    if(w<=.01)return;
    for(let d=0;d<10;d++){num[d]+=safeNum(node.p[d],UNIFORM)*w;den[d]+=w}
    evidence+=support;
    totalN+=safeNum(node.n,0);
  });
  if(totalN<1)return null;
  return {
    p:normalizeDist(num.map((x,d)=>x/(den[d]||1))),
    support:clamp(evidence/keys.length,0,1),
    n:totalN,
    phase,
    state:snap
  };
}

function normalizeMoveDist(p){
  const out=Array.from({length:MOVE_BUCKETS.length},(_,i)=>Math.max(.000001,safeNum(p?.[i],MOVE_UNIFORM)));
  const sum=out.reduce((a,b)=>a+b,0)||1;
  return out.map(x=>x/sum);
}
function updateCategorical(p,target,alpha,size){
  for(let i=0;i<size;i++)p[i]=(1-alpha)*safeNum(p[i],1/size)+alpha*(i===target?1:0);
  const sum=p.reduce((a,b)=>a+b,0)||1;
  for(let i=0;i<size;i++)p[i]/=sum;
}
function moveBucketIndex(units){
  units=Math.round(safeNum(units,0));
  if(units<=-9)return 0;
  if(units<=-4)return 1;
  if(units<=-1)return 2;
  if(units===0)return 3;
  if(units<=3)return 4;
  if(units<=8)return 5;
  return 6;
}
function movementContextKeys(snap){
  if(!snap)return [];
  const phase=marketPhaseFromMotion(snap);
  return [
    {key:'PH:'+phase+'|V'+snap.volatility,need:65,base:.86},
    {key:'MA:'+snap.direction+'|'+snap.strength+'|'+snap.accel+'|'+snap.turn,need:80,base:.72},
    {key:'MI:'+snap.microDir+'|'+snap.microForce+'|'+snap.trendBand,need:55,base:1.02},
    {key:'PX:'+phase+'|'+snap.microForce+'|'+snap.accel,need:48,base:1.12}
  ];
}
function ensureMovementNode(h,key){
  const bucket=mem.movementModels[h];
  if(!bucket[key])bucket[key]={p:blankMoveP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function ensureMoveDigitNode(h,key){
  const bucket=mem.moveDigitModels[h];
  if(!bucket[key])bucket[key]={p:blankP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function learnMovementOutcome(targetPrice,targetDigit){
  if(!Number.isFinite(Number(targetPrice))||!Number.isInteger(targetDigit)||targetDigit<0||targetDigit>9)return;
  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  for(const h of HORIZONS){
    const signalIndex=priceHist.length-h;
    if(signalIndex<0)continue;
    const sourcePrice=Number(priceHist[signalIndex]);
    const snap=motionHist[signalIndex];
    const sourceDigit=hist[signalIndex];
    if(!Number.isFinite(sourcePrice)||!snap||!Number.isInteger(sourceDigit))continue;
    const units=Math.round((Number(targetPrice)-sourcePrice)/unit);
    const bucketIndex=moveBucketIndex(units);
    movementContextKeys(snap).forEach(entry=>{
      const node=ensureMovementNode(h,entry.key);
      const alpha=.032*(mem.shadow?.drift?.active?1.18:1);
      updateCategorical(node.p,bucketIndex,clamp(alpha*(1-Math.min(.35,node.n/1400)),.008,.045),MOVE_BUCKETS.length);
      node.n++;
      node.last=mem.tickCount;
    });
    const stats=mem.movementBucketStats[h][bucketIndex];
    stats.n++;
    stats.sum+=units;

    const digitKeys=[
      {key:'B:'+bucketIndex,alpha:.022},
      {key:'BD:'+bucketIndex+'>D'+sourceDigit,alpha:.032}
    ];
    digitKeys.forEach(entry=>{
      const node=ensureMoveDigitNode(h,entry.key);
      updateProb(node.p,targetDigit,clamp(entry.alpha*(1-Math.min(.35,node.n/1500)),.008,.040));
      node.n++;
      node.last=mem.tickCount;
    });
  }
}
function bootstrapMovementPredictor(){
  if(movementBootstrapDone)return;
  movementBootstrapDone=true;
  const n=Math.min(hist.length,priceHist.length,motionHist.length);
  if(n<120)return;

  let existing=0;
  HORIZONS.forEach(h=>{existing+=Object.keys(mem.movementModels[h]||{}).length});
  if(existing>20)return;

  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  const start=Math.max(24,n-12000);
  let samples=0;

  for(let targetIndex=start;targetIndex<n;targetIndex++){
    const targetPrice=Number(priceHist[targetIndex]);
    const targetDigit=hist[targetIndex];
    if(!Number.isFinite(targetPrice)||!Number.isInteger(targetDigit))continue;

    for(const h of HORIZONS){
      const signalIndex=targetIndex-h;
      if(signalIndex<8)continue;
      const sourcePrice=Number(priceHist[signalIndex]);
      const snap=motionHist[signalIndex];
      const sourceDigit=hist[signalIndex];
      if(!Number.isFinite(sourcePrice)||!snap||!Number.isInteger(sourceDigit))continue;

      const units=Math.round((targetPrice-sourcePrice)/unit);
      const bucketIndex=moveBucketIndex(units);
      movementContextKeys(snap).forEach(entry=>{
        const node=ensureMovementNode(h,entry.key);
        updateCategorical(node.p,bucketIndex,.012,MOVE_BUCKETS.length);
        node.n++;
        node.last=Math.max(0,mem.tickCount-(n-targetIndex));
      });
      const st=mem.movementBucketStats[h][bucketIndex];
      st.n++;
      st.sum+=units;

      [
        {key:'B:'+bucketIndex,alpha:.010},
        {key:'BD:'+bucketIndex+'>D'+sourceDigit,alpha:.014}
      ].forEach(entry=>{
        const node=ensureMoveDigitNode(h,entry.key);
        updateProb(node.p,targetDigit,entry.alpha);
        node.n++;
        node.last=Math.max(0,mem.tickCount-(n-targetIndex));
      });
      samples++;
    }
  }
  console.log('Future movement predictor bootstrapped from history:',samples,'training samples');
}

function movementForecast(h=1){
  h=clamp(Math.round(safeNum(h,1)),1,3);
  const snap=motionSnapshot();
  if(!snap||!hist.length)return null;
  const sourceDigit=hist[hist.length-1];
  const num=Array(MOVE_BUCKETS.length).fill(0),den=Array(MOVE_BUCKETS.length).fill(0);
  let supportSum=0,totalN=0,keyCount=0;
  movementContextKeys(snap).forEach(entry=>{
    const node=mem.movementModels[h]?.[entry.key];
    if(!node)return;
    const support=1-Math.exp(-safeNum(node.n,0)/entry.need);
    const w=entry.base*support;
    if(w<=.01)return;
    const p=normalizeMoveDist(node.p);
    for(let b=0;b<MOVE_BUCKETS.length;b++){num[b]+=p[b]*w;den[b]+=w}
    supportSum+=support;
    totalN+=safeNum(node.n,0);
    keyCount++;
  });
  if(totalN<1)return null;
  const moveP=normalizeMoveDist(num.map((x,b)=>x/(den[b]||1)));
  const digitP=Array(10).fill(0);
  for(let b=0;b<MOVE_BUCKETS.length;b++){
    const general=mem.moveDigitModels[h]?.['B:'+b];
    const specific=mem.moveDigitModels[h]?.['BD:'+b+'>D'+sourceDigit];
    let cond=Array(10).fill(0),weight=0;
    if(general){
      const g=normalizeDist(general.p),w=.45*(1-Math.exp(-safeNum(general.n,0)/100));
      for(let d=0;d<10;d++)cond[d]+=g[d]*w;
      weight+=w;
    }
    if(specific){
      const sp=normalizeDist(specific.p),w=.75*(1-Math.exp(-safeNum(specific.n,0)/70));
      for(let d=0;d<10;d++)cond[d]+=sp[d]*w;
      weight+=w;
    }
    if(weight>0){
      cond=normalizeDist(cond.map(x=>x/weight));
    }else{
      cond=blankP();
    }
    for(let d=0;d<10;d++)digitP[d]+=moveP[b]*cond[d];
  }
  const projectedDigits=normalizeDist(digitP);
  const means=mem.movementBucketStats[h].map((st,b)=>safeNum(st.n,0)>=20?safeNum(st.sum,0)/st.n:MOVE_CENTERS[b]);
  const expectedUnits=moveP.reduce((sum,p,b)=>sum+p*means[b],0);
  const down=moveP[0]+moveP[1]+moveP[2],flat=moveP[3],up=moveP[4]+moveP[5]+moveP[6];
  const dirs=[{name:'DOWN',p:down},{name:'FLAT',p:flat},{name:'UP',p:up}].sort((a,b)=>b.p-a.p);
  const reversal=snap.direction==='UP'?down:snap.direction==='DOWN'?up:Math.max(up,down);
  const continuation=snap.direction==='UP'?up:snap.direction==='DOWN'?down:flat;
  const perf=mem.movementPerf[h]||freshMovePerf();
  const digitPerf=mem.shadow.performance.futureMove||{};
  const ready=
    safeNum(perf.samples,0)>=1500 &&
    safeNum(perf.logLossEWMA,MOVE_BASE_LOGLOSS)<=MOVE_BASE_LOGLOSS-.010 &&
    safeNum(perf.brierEWMA,MOVE_BASE_BRIER)<=MOVE_BASE_BRIER-.0008 &&
    safeNum(perf.directionHitEWMA,1/3)>=.39 &&
    safeNum(digitPerf.samples,0)>=1200 &&
    safeNum(digitPerf.matchEWMA,UNIFORM)<=.096 &&
    safeNum(digitPerf.logLossEWMA,Math.log(10))<=Math.log(10)-.003;
  return {
    h,moveP,digitP:projectedDigits,n:totalN,
    support:clamp(supportSum/Math.max(1,keyCount),0,1),
    expectedUnits,
    down,flat,up,
    direction:dirs[0].name,
    directionProbability:dirs[0].p,
    reversalProbability:clamp(reversal,0,1),
    continuationProbability:clamp(continuation,0,1),
    phase:marketPhaseFromMotion(snap),
    ready,
    perf:{
      samples:safeNum(perf.samples,0),
      logLossEWMA:safeNum(perf.logLossEWMA,MOVE_BASE_LOGLOSS),
      brierEWMA:safeNum(perf.brierEWMA,MOVE_BASE_BRIER),
      directionHitEWMA:safeNum(perf.directionHitEWMA,1/3),
      maeUnitsEWMA:safeNum(perf.maeUnitsEWMA,6)
    }
  };
}
function scheduleMovementForecasts(counter){
  for(const h of HORIZONS){
    const f=movementForecast(h);
    if(!f||!priceHist.length)continue;
    movementQueue.push({
      due:counter+h,
      h,
      sourcePrice:Number(priceHist[priceHist.length-1]),
      moveP:f.moveP.slice(),
      expectedUnits:f.expectedUnits
    });
  }
  if(movementQueue.length>30)movementQueue=movementQueue.slice(-30);
}
function resolveMovementForecasts(targetPrice,counter){
  if(!movementQueue.length||!Number.isFinite(Number(targetPrice)))return;
  const due=[],keep=[];
  movementQueue.forEach(x=>(x.due<=counter?due:keep).push(x));
  movementQueue=keep.slice(-30);
  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  due.forEach(item=>{
    const actualUnits=Math.round((Number(targetPrice)-safeNum(item.sourcePrice,Number(targetPrice)))/unit);
    const actualBucket=moveBucketIndex(actualUnits);
    const p=normalizeMoveDist(item.moveP);
    const prob=clamp(p[actualBucket],.0001,.9999);
    const logLoss=-Math.log(prob);
    let brier=0;
    for(let b=0;b<MOVE_BUCKETS.length;b++){
      const y=b===actualBucket?1:0,err=p[b]-y;
      brier+=err*err;
    }
    brier/=MOVE_BUCKETS.length;
    const down=p[0]+p[1]+p[2],flat=p[3],up=p[4]+p[5]+p[6];
    const predDir=[{d:-1,p:down},{d:0,p:flat},{d:1,p:up}].sort((a,b)=>b.p-a.p)[0].d;
    const actualDir=actualUnits>0?1:actualUnits<0?-1:0;
    const hit=predDir===actualDir?1:0;
    const mae=Math.abs(safeNum(item.expectedUnits,0)-actualUnits);
    const perf=mem.movementPerf[item.h]||(mem.movementPerf[item.h]=freshMovePerf());
    perf.samples++;
    const a=perf.samples<250?.025:.008;
    perf.logLossEWMA=(1-a)*safeNum(perf.logLossEWMA,MOVE_BASE_LOGLOSS)+a*logLoss;
    perf.brierEWMA=(1-a)*safeNum(perf.brierEWMA,MOVE_BASE_BRIER)+a*brier;
    perf.directionHitEWMA=(1-a)*safeNum(perf.directionHitEWMA,1/3)+a*hit;
    perf.maeUnitsEWMA=(1-a)*safeNum(perf.maeUnitsEWMA,6)+a*Math.min(60,mae);
    perf.lastAt=Date.now();
  });
}

function rangeDigitCorridor(digits,endIndex){
  if(!Array.isArray(digits)||endIndex<0)return {low:0,high:9,coverage:0,width:10};
  const recent=digits.slice(Math.max(0,endIndex-13),endIndex+1)
    .map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=9);
  if(recent.length<5)return {low:0,high:9,coverage:0,width:10};
  let best={low:0,high:9,coverage:0,width:10,score:-1};
  for(let low=0;low<=8;low++){
    for(let high=low+1;high<=Math.min(9,low+4);high++){
      const inside=recent.reduce((n,d)=>n+(d>=low&&d<=high?1:0),0);
      const coverage=inside/recent.length;
      const width=high-low+1;
      const score=coverage-width*.035;
      if(coverage>=.42 && (score>best.score || (score===best.score&&width<best.width))){
        best={low,high,coverage,width,score};
      }
    }
  }
  return {low:best.low,high:best.high,coverage:best.coverage,width:best.width};
}
function rangeSnapshotAt(prices,endIndex,digits=hist,motionState=null){
  if(!Array.isArray(prices)||endIndex<7)return null;
  const start=Math.max(0,endIndex-15);
  const p=prices.slice(start,endIndex+1).map(Number).filter(Number.isFinite);
  if(p.length<8)return null;
  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  const low=Math.min(...p),high=Math.max(...p),last=p[p.length-1];
  const widthUnits=Math.max(1,Math.round((high-low)/unit));
  const short=p.slice(-7);
  const shortWidth=Math.max(...short)-Math.min(...short);
  const compression=clamp((shortWidth/unit)/Math.max(1,widthUnits),0,2);
  let pathUnits=0,flips=0,prevSign=0;
  for(let i=1;i<p.length;i++){
    const u=(p[i]-p[i-1])/unit;
    pathUnits+=Math.abs(u);
    const sign=u>0?1:u<0?-1:0;
    if(sign&&prevSign&&sign!==prevSign)flips++;
    if(sign)prevSign=sign;
  }
  const netUnits=Math.abs((last-p[0])/unit);
  const efficiency=clamp(netUnits/Math.max(1,pathUnits),0,1);
  const oscillation=clamp(1-widthUnits/Math.max(widthUnits,pathUnits),0,1);
  const flipRate=clamp(flips/Math.max(1,p.length-2),0,1);
  const lateralScore=clamp((1-efficiency)*.46+oscillation*.29+flipRate*.25,0,1);
  const position=clamp((last-low)/Math.max(unit,high-low),0,1);
  const compressionBand=compression<.58?'COMPRESS':compression>.92?'EXPAND':'STABLE';
  const widthBand=widthUnits<=5?'TIGHT':widthUnits<=12?'NARROW':widthUnits<=28?'MID':'WIDE';
  const positionBand=position<.30?'LOW':position>.70?'HIGH':'MID';
  const lateralBand=lateralScore>=.72?'HIGH':lateralScore>=.52?'MID':'LOW';
  const corridor=rangeDigitCorridor(digits,endIndex);
  const motion=motionState||motionHist[endIndex]||null;
  const phase=marketPhaseFromMotion(motion);
  const toleranceUnits=Math.max(1,Math.round(widthUnits*.12));
  return {
    low,high,last,widthUnits,compression,lateralScore,position,
    compressionBand,widthBand,positionBand,lateralBand,corridor,
    phase,
    volatility:motion?.volatility||'MID',
    trendBand:motion?.trendBand||'STABLE',
    toleranceUnits
  };
}
function rangeContextKeys(snap,sourceDigit){
  if(!snap)return [];
  const keys=[
    {key:'R:'+snap.lateralBand+'|W'+snap.widthBand+'|C'+snap.compressionBand+'|P'+snap.positionBand,need:55,base:.92},
    {key:'RD:'+snap.lateralBand+'|W'+snap.widthBand+'|C'+snap.compressionBand+'>D'+sourceDigit,need:38,base:1.10},
    {key:'RV:'+snap.lateralBand+'|V'+snap.volatility+'|T'+snap.trendBand,need:50,base:.84}
  ];
  if(snap.corridor?.coverage>=.48){
    keys.push({
      key:'RC:'+snap.lateralBand+'|DG'+snap.corridor.low+'-'+snap.corridor.high+'|C'+snap.compressionBand,
      need:34,base:1.18
    });
  }
  return keys;
}
function ensureRangeNode(h,key){
  const bucket=mem.rangeModels[h];
  if(!bucket[key])bucket[key]={state:[1,1,1],p:blankP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function normalizeRangeState(xs){
  const a=Array.from({length:3},(_,i)=>Math.max(.000001,safeNum(xs?.[i],1)));
  const s=a.reduce((x,y)=>x+y,0)||1;
  return a.map(x=>x/s);
}
function rangeOutcomeIndex(snap,targetPrice){
  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  const tol=Math.max(unit,safeNum(snap?.toleranceUnits,1)*unit);
  if(Number(targetPrice)>safeNum(snap?.high,Number(targetPrice))+tol)return 2;
  if(Number(targetPrice)<safeNum(snap?.low,Number(targetPrice))-tol)return 1;
  return 0;
}
function learnRangeOutcome(targetPrice,targetDigit){
  if(!Number.isFinite(Number(targetPrice))||!Number.isInteger(targetDigit))return;
  for(const h of HORIZONS){
    const signalIndex=priceHist.length-h;
    if(signalIndex<7)continue;
    const snap=rangeSnapshotAt(priceHist,signalIndex,hist,motionHist[signalIndex]);
    const sourceDigit=hist[signalIndex];
    if(!snap||!Number.isInteger(sourceDigit)||snap.lateralScore<.34)continue;
    const outcome=rangeOutcomeIndex(snap,targetPrice);
    rangeContextKeys(snap,sourceDigit).forEach(entry=>{
      const node=ensureRangeNode(h,entry.key);
      const alpha=clamp(.030*(mem.shadow?.drift?.active?1.15:1)*(1-Math.min(.35,node.n/1400)),.008,.042);
      updateCategorical(node.state,outcome,alpha,3);
      updateProb(node.p,targetDigit,clamp(alpha*.86,.007,.036));
      node.n++;
      node.last=mem.tickCount;
    });
  }
}
function rangeForecast(h=1){
  h=clamp(Math.round(safeNum(h,1)),1,3);
  if(priceHist.length<8||!hist.length)return null;
  const end=priceHist.length-1;
  const snap=rangeSnapshotAt(priceHist,end,hist,motionHist[end]);
  const sourceDigit=hist[hist.length-1];
  if(!snap||!Number.isInteger(sourceDigit))return null;
  const stateNum=Array(3).fill(0),stateDen=Array(3).fill(0);
  const digitNum=Array(10).fill(0),digitDen=Array(10).fill(0);
  let supportSum=0,totalN=0,keyCount=0;
  rangeContextKeys(snap,sourceDigit).forEach(entry=>{
    const node=mem.rangeModels[h]?.[entry.key];
    if(!node)return;
    const support=1-Math.exp(-safeNum(node.n,0)/entry.need);
    const w=entry.base*support;
    if(w<=.01)return;
    const sp=normalizeRangeState(node.state);
    const dp=normalizeDist(node.p);
    for(let i=0;i<3;i++){stateNum[i]+=sp[i]*w;stateDen[i]+=w}
    for(let d=0;d<10;d++){digitNum[d]+=dp[d]*w;digitDen[d]+=w}
    supportSum+=support;totalN+=safeNum(node.n,0);keyCount++;
  });
  const stateP=keyCount?normalizeRangeState(stateNum.map((x,i)=>x/(stateDen[i]||1))):[.50,.25,.25];
  const digitP=keyCount?normalizeDist(digitNum.map((x,d)=>x/(digitDen[d]||1))):blankP();
  const perf=mem.rangePerf[h]||freshRangePerf();
  const digitPerf=mem.shadow.performance.range||{};
  const activeRange=snap.phase==='RANGE'||snap.lateralScore>=.56;
  const ready=
    activeRange &&
    safeNum(perf.samples,0)>=300 &&
    safeNum(perf.logLossEWMA,RANGE_BASE_LOGLOSS)<=1.08 &&
    safeNum(perf.brierEWMA,RANGE_BASE_BRIER)<=.218 &&
    safeNum(perf.accuracyEWMA,1/3)>=.40 &&
    safeNum(digitPerf.samples,0)>=300 &&
    safeNum(digitPerf.matchEWMA,UNIFORM)<=.1005 &&
    safeNum(digitPerf.logLossEWMA,Math.log(10))<=Math.log(10)+.015;
  const exposed=Array.from({length:10},(_,d)=>({d,p:digitP[d]})).sort((a,b)=>b.p-a.p).slice(0,3);
  return {
    h,stateP,digitP,n:totalN,
    support:clamp(supportSum/Math.max(1,keyCount),0,1),
    stayProbability:stateP[0],
    breakoutDownProbability:stateP[1],
    breakoutUpProbability:stateP[2],
    activeRange,ready,
    widthUnits:snap.widthUnits,
    compression:snap.compression,
    compressionBand:snap.compressionBand,
    lateralScore:snap.lateralScore,
    position:snap.position,
    positionBand:snap.positionBand,
    low:snap.low,high:snap.high,
    digitCorridor:snap.corridor,
    exposedDigits:exposed,
    phase:snap.phase,
    perf:{
      samples:safeNum(perf.samples,0),
      logLossEWMA:safeNum(perf.logLossEWMA,RANGE_BASE_LOGLOSS),
      brierEWMA:safeNum(perf.brierEWMA,RANGE_BASE_BRIER),
      accuracyEWMA:safeNum(perf.accuracyEWMA,1/3)
    }
  };
}
function scheduleRangeForecasts(counter){
  for(const h of HORIZONS){
    const f=rangeForecast(h);
    if(!f||!f.activeRange)continue;
    rangeQueue.push({
      due:counter+h,h,
      stateP:f.stateP.slice(),
      low:f.low,high:f.high,
      toleranceUnits:Math.max(1,Math.round(f.widthUnits*.12))
    });
  }
  if(rangeQueue.length>30)rangeQueue=rangeQueue.slice(-30);
}
function resolveRangeForecasts(targetPrice,counter){
  if(!rangeQueue.length||!Number.isFinite(Number(targetPrice)))return;
  const due=[],keep=[];
  rangeQueue.forEach(x=>(x.due<=counter?due:keep).push(x));
  rangeQueue=keep.slice(-30);
  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  due.forEach(item=>{
    const snap={low:item.low,high:item.high,toleranceUnits:item.toleranceUnits};
    const actual=rangeOutcomeIndex(snap,targetPrice);
    const p=normalizeRangeState(item.stateP);
    const prob=clamp(p[actual],.0001,.9999);
    const logLoss=-Math.log(prob);
    let brier=0;
    for(let i=0;i<3;i++){const y=i===actual?1:0,e=p[i]-y;brier+=e*e}
    brier/=3;
    const predicted=p.indexOf(Math.max(...p));
    const hit=predicted===actual?1:0;
    const perf=mem.rangePerf[item.h]||(mem.rangePerf[item.h]=freshRangePerf());
    perf.samples++;
    const a=perf.samples<180?.028:.010;
    perf.logLossEWMA=(1-a)*safeNum(perf.logLossEWMA,RANGE_BASE_LOGLOSS)+a*logLoss;
    perf.brierEWMA=(1-a)*safeNum(perf.brierEWMA,RANGE_BASE_BRIER)+a*brier;
    perf.accuracyEWMA=(1-a)*safeNum(perf.accuracyEWMA,1/3)+a*hit;
    perf.lastAt=Date.now();
  });
}
function bootstrapRangePredictor(){
  if(rangeBootstrapDone)return;
  rangeBootstrapDone=true;
  const n=Math.min(hist.length,priceHist.length,motionHist.length);
  if(n<150)return;
  let existing=0;
  HORIZONS.forEach(h=>existing+=Object.keys(mem.rangeModels[h]||{}).length);
  if(existing>15)return;
  const start=Math.max(20,n-12000);
  let samples=0;
  for(let targetIndex=start;targetIndex<n;targetIndex++){
    const targetPrice=Number(priceHist[targetIndex]),targetDigit=hist[targetIndex];
    if(!Number.isFinite(targetPrice)||!Number.isInteger(targetDigit))continue;
    for(const h of HORIZONS){
      const signalIndex=targetIndex-h;
      if(signalIndex<7)continue;
      const snap=rangeSnapshotAt(priceHist,signalIndex,hist,motionHist[signalIndex]);
      const sourceDigit=hist[signalIndex];
      if(!snap||!Number.isInteger(sourceDigit)||snap.lateralScore<.34)continue;
      const outcome=rangeOutcomeIndex(snap,targetPrice);
      rangeContextKeys(snap,sourceDigit).forEach(entry=>{
        const node=ensureRangeNode(h,entry.key);
        updateCategorical(node.state,outcome,.012,3);
        updateProb(node.p,targetDigit,.010);
        node.n++;
        node.last=Math.max(0,mem.tickCount-(n-targetIndex));
      });
      samples++;
    }
  }
  console.log('Range Intelligence bootstrapped from history:',samples,'training samples');
}

function learnDigit(targetDigit,sourceHist){
  if(sourceHist.length){
    updateProb(mem.globalP,targetDigit,.018*driftLearningBoost());
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
  learnMotion(targetDigit,sourceHist);
  learnPhase(targetDigit,sourceHist);
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
  HORIZONS.forEach(h=>{
    const bucket=mem.motionModels[h]||{};
    const keys=Object.keys(bucket);
    if(keys.length>2200){
      keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
      keys.slice(2200).forEach(k=>delete bucket[k]);
    }
  });
  HORIZONS.forEach(h=>{
    const bucket=mem.phaseModels[h]||{};
    const keys=Object.keys(bucket);
    if(keys.length>1600){
      keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
      keys.slice(1600).forEach(k=>delete bucket[k]);
    }
  });
  HORIZONS.forEach(h=>{
    const bucket=mem.rangeModels[h]||{};
    const keys=Object.keys(bucket);
    if(keys.length>1500){
      keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
      keys.slice(1500).forEach(k=>delete bucket[k]);
    }
  });
  HORIZONS.forEach(h=>{
    const move=mem.movementModels[h]||{};
    const mk=Object.keys(move);
    if(mk.length>1800){
      mk.sort((a,b)=>(move[b].last||0)-(move[a].last||0));
      mk.slice(1800).forEach(k=>delete move[k]);
    }
    const digit=mem.moveDigitModels[h]||{};
    const dk=Object.keys(digit);
    if(dk.length>120){
      dk.sort((a,b)=>(digit[b].last||0)-(digit[a].last||0));
      dk.slice(120).forEach(k=>delete digit[k]);
    }
  });
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
  return {
    p:normalizeDist(node.p),
    support:1-Math.exp(-safeNum(node.n,0)/(order===1?26:order===2?16:10)),
    n:safeNum(node.n,0)
  };
}

function expertWeight(name){
  const p=mem.shadow.performance[name];
  let w=clamp(safeNum(p?.weight,1),.12,5);

  if(mem.shadow.drift.boostRemaining>0){
    if(name==='recent25') w*=1.55;
    else if(name==='recent100') w*=1.30;
    else if(name==='global'||name==='recent300') w*=.72;
    else if(name==='ctx1') w*=1.10;
    else if(name==='ctx3') w*=.88;
    else if(name==='motion') w*=1.08;
    else if(name==='phase') w*=1.10;
    else if(name==='futureMove') w*=1.12;
    else if(name==='range') w*=1.10;
    else if(name==='collab') w*=.92;
  }
  return clamp(w,.10,6);
}

function collaborativeDist(){
  const col=mem.collaborative;
  if(!col || col.accepted<1) return {p:blankP(),support:0,n:0};

  const ctx=hist.slice(-2).join('');
  const risks=Array(10).fill(UNIFORM);

  for(let d=0;d<10;d++){
    const g=col.byDigit[d]||{n:0,matches:0};
    const globalRisk=(safeNum(g.matches,0)+18*UNIFORM)/(safeNum(g.n,0)+18);
    const node=ctx ? col.contexts[ctx+'>'+d] : null;

    if(node){
      const localRisk=(safeNum(node.matches,0)+28*globalRisk)/(safeNum(node.n,0)+28);
      const ev=1-Math.exp(-safeNum(node.n,0)/35);
      risks[d]=(1-ev)*globalRisk+ev*localRisk;
    }else{
      risks[d]=globalRisk;
    }
  }

  return {
    p:normalizeDist(risks),
    support:clamp(1-Math.exp(-col.accepted/280),0,1),
    n:col.accepted
  };
}

function modelViews(){
  const views=[];
  views.push({name:'global',p:normalizeDist(mem.globalP),support:Math.min(1,safeNum(mem.globalN,0)/500),base:.80});
  views.push({name:'recent25',p:frequencyDist(25),support:Math.min(1,hist.length/25),base:.75});
  views.push({name:'recent100',p:frequencyDist(100),support:Math.min(1,hist.length/100),base:.90});
  views.push({name:'recent300',p:frequencyDist(300),support:Math.min(1,hist.length/300),base:.75});
  const shared=collaborativeDist();
  if(shared.n>0) views.push({name:'collab',p:shared.p,support:shared.support,base:.62,n:shared.n});
  for(const o of ORDERS){
    const c=contextDist(o);
    if(c) views.push({name:'ctx'+o,p:c.p,support:c.support,base:o===1?.95:o===2?1.12:1.22,n:c.n});
  }
  const motion=motionDist();
  if(motion){
    // Se evalúa en shadow desde el primer tick, pero no altera el ensemble hasta probar utilidad.
    const mp=mem.shadow.performance.motion||{samples:0,matchEWMA:UNIFORM,logLossEWMA:Math.log(10)};
    const ready=
      safeNum(motion.n,0)>=400 &&
      safeNum(mp.samples,0)>=250 &&
      safeNum(mp.matchEWMA,UNIFORM)<UNIFORM-.0015 &&
      safeNum(mp.logLossEWMA,Math.log(10))<=Math.log(10)+.03;
    const maturity=clamp((safeNum(mp.samples,0)-250)/1200,0,1);
    const base=ready ? (.16+.26*maturity) : 0;
    views.push({name:'motion',p:motion.p,support:motion.support,base,n:motion.n,state:motion.state,ready});
  }

  const futureMove=movementForecast(1);
  if(futureMove){
    const fp=mem.shadow.performance.futureMove||{samples:0,matchEWMA:UNIFORM,logLossEWMA:Math.log(10)};
    const maturity=clamp((safeNum(fp.samples,0)-1200)/3200,0,1);
    const base=futureMove.ready ? (.08+.18*maturity) : 0;
    views.push({
      name:'futureMove',
      p:futureMove.digitP,
      support:futureMove.support,
      base,
      n:futureMove.n,
      ready:futureMove.ready,
      forecast:futureMove
    });
  }

  const phase=phaseDist();
  if(phase){
    // Nueva capa de estructura: impulso, agotamiento, retroceso, giro, continuación o rango.
    // Aprende siempre en shadow y solo vota cuando demuestra utilidad prequential.
    const pp=mem.shadow.performance.phase||{samples:0,matchEWMA:UNIFORM,logLossEWMA:Math.log(10)};
    const ready=
      safeNum(phase.n,0)>=1800 &&
      safeNum(pp.samples,0)>=1200 &&
      safeNum(pp.matchEWMA,UNIFORM)<=.0955 &&
      safeNum(pp.logLossEWMA,Math.log(10))<=Math.log(10)-.004;
    const maturity=clamp((safeNum(pp.samples,0)-1200)/2600,0,1);
    const base=ready ? (.08+.16*maturity) : 0;
    views.push({name:'phase',p:phase.p,support:phase.support,base,n:phase.n,phase:phase.phase,state:phase.state,ready});
  }

  const range=rangeForecast(1);
  if(range){
    const rp=mem.shadow.performance.range||{samples:0,matchEWMA:UNIFORM,logLossEWMA:Math.log(10)};
    const maturity=clamp((safeNum(rp.samples,0)-300)/1800,0,1);
    const persistence=clamp((safeNum(range.stayProbability,.5)-.40)/.45,0,1);
    const base=range.ready ? (.07+.17*maturity)*(.65+.35*persistence) : 0;
    views.push({
      name:'range',p:range.digitP,support:range.support,base,n:range.n,
      ready:range.ready,forecast:range
    });
  }
  return views;
}

function calibrationBin(rawRisk){
  return clamp(Math.floor(clamp(rawRisk,0,.199999)*100),0,CAL_BINS-1);
}
function calibrationECE(){
  const c=mem.shadow.calibration;
  let total=0,err=0;
  c.bins.forEach((b,i)=>{
    if(!b.n) return;
    const center=(i+.5)/100;
    const obs=b.matches/b.n;
    total+=b.n;
    err+=b.n*Math.abs(obs-center);
  });
  return total?err/total:0;
}
function calibrateRisk(rawRisk){
  const raw=clamp(safeNum(rawRisk,UNIFORM),.005,.30);
  const c=mem.shadow.calibration;
  const b=c.bins[calibrationBin(raw)];
  const prior=70;
  const posterior=(safeNum(b.matches,0)+prior*raw)/(safeNum(b.n,0)+prior);
  const evidence=1-Math.exp(-safeNum(b.n,0)/90);
  const globalRatio=clamp(
    safeNum(c.observedEWMA,UNIFORM)/Math.max(.01,safeNum(c.predictedEWMA,UNIFORM)),
    .65,1.55
  );
  const globalAdjusted=raw*globalRatio;
  const blended=(1-evidence)*globalAdjusted+evidence*posterior;
  return clamp(blended,Math.max(.005,raw*.55),Math.min(.30,raw*1.65));
}
function updateCalibration(rawRisk,match){
  const c=mem.shadow.calibration;
  const raw=clamp(safeNum(rawRisk,UNIFORM),.005,.30);
  const y=match?1:0;
  const b=c.bins[calibrationBin(raw)];
  b.n++;
  b.matches+=y;
  c.samples++;
  const a=c.samples<120?.035:.012;
  c.predictedEWMA=(1-a)*safeNum(c.predictedEWMA,UNIFORM)+a*raw;
  c.observedEWMA=(1-a)*safeNum(c.observedEWMA,UNIFORM)+a*y;
  c.brierEWMA=(1-a)*safeNum(c.brierEWMA,.09)+a*((raw-y)**2);
  c.ece=calibrationECE();
}

function normalizeHedgeWeights(activeNames){
  if(!activeNames.length) return;
  const vals=activeNames.map(name=>clamp(safeNum(mem.shadow.performance[name]?.weight,1),.0001,100));
  const avg=mean(vals)||1;
  activeNames.forEach(name=>{
    const p=mem.shadow.performance[name];
    p.weight=clamp(p.weight/avg,.12,5);
  });
}
function hedgeUpdate(pending,actual){
  const active=[];
  for(const mv of pending.modelVotes||[]){
    const perf=mem.shadow.performance[mv.name];
    const dist=(pending.modelDistributions||{})[mv.name];
    if(!perf||!Array.isArray(dist)||dist.length!==10) continue;

    const prob=clamp(safeNum(dist[actual],UNIFORM),.0001,.9999);
    const logLoss=-Math.log(prob);
    const normalizedLog=clamp(logLoss/(3*Math.log(10)),0,1);
    const ownMatch=actual===mv.digit?1:0;
    const hedgeLoss=.72*ownMatch+.28*normalizedLog;

    perf.samples++;
    perf.cumulativeLoss+=hedgeLoss;
    const a=perf.samples<100?.045:.016;
    perf.logLossEWMA=(1-a)*safeNum(perf.logLossEWMA,Math.log(10))+a*logLoss;
    perf.matchEWMA=(1-a)*safeNum(perf.matchEWMA,UNIFORM)+a*ownMatch;
    perf.weight=clamp(safeNum(perf.weight,1)*Math.exp(-HEDGE_ETA*hedgeLoss),.0001,100);
    active.push(mv.name);
  }
  normalizeHedgeWeights(active);
}

function detectDrift(pending,actual){
  const d=mem.shadow.drift;
  const prob=clamp(safeNum(pending?.probabilities?.[actual],UNIFORM),.0001,.9999);
  const normalizedLoss=clamp((-Math.log(prob))/(3*Math.log(10)),0,1);
  d.lossWindow.push(normalizedLoss);
  if(d.lossWindow.length>DRIFT_MAX_WINDOW) d.lossWindow.shift();

  if(d.boostRemaining>0){
    d.boostRemaining--;
    if(d.boostRemaining===0) d.active=false;
  }

  if(d.lossWindow.length<160 || mem.shadow.total%20!==0) return;

  const w=d.lossWindow;
  let best=null;
  const delta=.08;
  for(let cut=60;cut<=w.length-60;cut+=20){
    const left=w.slice(0,cut),right=w.slice(cut);
    const diff=Math.abs(mean(left)-mean(right));
    const eps=Math.sqrt(.5*Math.log(4/delta)*(1/left.length+1/right.length));
    const score=diff-eps;
    if(!best||score>best.score) best={cut,diff,eps,score};
  }

  if(!best) return;
  d.score=Math.max(0,best.diff);
  d.epsilon=best.eps;
  d.cut=best.cut;

  if(best.score>0 && mem.tickCount-d.lastTick>180){
    d.events++;
    d.active=true;
    d.boostRemaining=260;
    d.lastAt=Date.now();
    d.lastTick=mem.tickCount;
    d.lossWindow=w.slice(best.cut);

    MODEL_NAMES.forEach(name=>{
      const p=mem.shadow.performance[name];
      p.weight=.60*safeNum(p.weight,1)+.40;
    });

    console.log('Drift detected:',{
      tick:mem.tickCount,
      score:Number(best.diff.toFixed(4)),
      epsilon:Number(best.eps.toFixed(4)),
      events:d.events
    });
  }
}

function blendViews(views,multiplier){
  const num=Array(10).fill(0),den=Array(10).fill(0);
  for(const v of views){
    const ew=expertWeight(v.name);
    const mult=typeof multiplier==='function'?clamp(safeNum(multiplier(v),1),.08,3.5):1;
    const w=v.base*(.25+.75*v.support)*ew*mult;
    for(let d=0;d<10;d++){
      num[d]+=v.p[d]*w;
      den[d]+=w;
    }
  }
  return normalizeDist(num.map((x,d)=>x/(den[d]||1)));
}
function predictionFromDist(name,p,views){
  const ranked=p.map((risk,d)=>({d,risk})).sort((a,b)=>a.risk-b.risk);
  const best=ranked[0];
  const activeViews=views.filter(v=>safeNum(v.base,0)>0);
  const confidenceViews=activeViews.length?activeViews:views;
  const risks=confidenceViews.map(v=>v.p[best.d]);
  const m=mean(risks);
  const variance=risks.length?risks.reduce((s,x)=>s+(x-m)**2,0)/risks.length:0;
  const disagreement=Math.sqrt(variance);
  const support=confidenceViews.length?confidenceViews.reduce((s,v)=>s+v.support,0)/confidenceViews.length:0;
  const calibrationTrust=clamp(1-mem.shadow.calibration.ece*4,.45,1);
  const driftPenalty=mem.shadow.drift.active?.88:1;
  const confidence=clamp((.18+.82*support)*Math.exp(-disagreement*16)*calibrationTrust*driftPenalty,0,1);
  return {
    name,
    probabilities:p,
    digit:best.d,
    rawRisk:best.risk,
    risk:calibrateRisk(best.risk),
    confidence,
    disagreement
  };
}
function tournamentPredictions(views,baseP){
  const out={};
  out.base=predictionFromDist('base',baseP,views);

  const recentP=blendViews(views,v=>{
    if(v.name==='recent25')return 2.15;
    if(v.name==='recent100')return 1.55;
    if(v.name==='ctx1')return 1.45;
    if(v.name==='global'||v.name==='recent300')return .55;
    if(v.name==='ctx3')return .75;
    return 1;
  });
  out.recentFocus=predictionFromDist('recentFocus',recentP,views);

  const contextP=blendViews(views,v=>{
    if(v.name==='ctx2')return 1.75;
    if(v.name==='ctx3')return 2.10;
    if(v.name==='collab')return 1.25;
    if(v.name==='recent25')return .65;
    if(v.name==='global')return .75;
    return 1;
  });
  out.contextFocus=predictionFromDist('contextFocus',contextP,views);

  const avg=baseP;
  const robustRaw=avg.map((x,d)=>{
    const vals=views.map(v=>safeNum(v.p[d],UNIFORM)).sort((a,b)=>a-b);
    const upper=vals.length?vals[Math.min(vals.length-1,Math.floor(vals.length*.75))]:UNIFORM;
    return .62*x+.38*upper;
  });
  out.robust=predictionFromDist('robust',normalizeDist(robustRaw),views);
  return out;
}
function tournamentRecentRate(stat){
  if(!stat?.recent?.length)return UNIFORM;
  return stat.recent.reduce((a,b)=>a+b,0)/stat.recent.length;
}
function tournamentScore(stat){
  const recent=tournamentRecentRate(stat);
  return .68*recent+.32*safeNum(stat?.brierEWMA,.09);
}
function updateTournament(candidateSet,actual){
  const t=mem.shadow.tournament;
  if(!candidateSet||!t)return;
  TOURNAMENT_NAMES.forEach(name=>{
    const pred=candidateSet[name],st=t.candidates[name];
    if(!pred||!st||!Array.isArray(pred.probabilities))return;
    const match=actual===pred.digit?1:0;
    const prob=clamp(safeNum(pred.probabilities[actual],UNIFORM),.0001,.9999);
    const brier=pred.probabilities.reduce((sum,x,d)=>{
      const y=d===actual?1:0,err=safeNum(x,UNIFORM)-y;
      return sum+err*err;
    },0)/10;
    const logLoss=-Math.log(prob);
    st.samples++;
    st.matches+=match;
    st.wins+=match?0:1;
    st.matchRate=st.matches/st.samples;
    const a=st.samples<180?.035:.012;
    st.brierEWMA=(1-a)*safeNum(st.brierEWMA,.09)+a*brier;
    st.logLossEWMA=(1-a)*safeNum(st.logLossEWMA,Math.log(10))+a*logLoss;
    st.recent.push(match);
    if(st.recent.length>TOURNAMENT_RECENT)st.recent.shift();
  });

  const current=t.candidates[t.champion];
  if(!current||current.samples<TOURNAMENT_MIN_SAMPLES)return;
  if(mem.tickCount-safeNum(t.lastPromotionTick,0)<TOURNAMENT_COOLDOWN_TICKS)return;

  let bestName=t.champion,bestScore=tournamentScore(current);
  for(const name of TOURNAMENT_NAMES){
    if(name===t.champion)continue;
    const st=t.candidates[name];
    if(!st||st.samples<TOURNAMENT_MIN_SAMPLES||st.recent.length<TOURNAMENT_RECENT)continue;
    const score=tournamentScore(st);
    const recentGain=tournamentRecentRate(current)-tournamentRecentRate(st);
    const brierOkay=st.brierEWMA<=current.brierEWMA+.0015;
    const logOkay=st.logLossEWMA<=current.logLossEWMA+.025;
    if(recentGain>=.008 && brierOkay && logOkay && score<bestScore-.0045){
      bestName=name;bestScore=score;
    }
  }
  if(bestName!==t.champion){
    console.log('Champion promoted:',{from:t.champion,to:bestName,tick:mem.tickCount});
    t.champion=bestName;
    t.promotions++;
    t.lastPromotionAt=Date.now();
    t.lastPromotionTick=mem.tickCount;
  }
}
function tournamentSummary(){
  const t=mem.shadow.tournament;
  const candidates={};
  TOURNAMENT_NAMES.forEach(name=>{
    const s=t.candidates[name];
    candidates[name]={
      samples:s.samples,
      matchRate:Number(s.matchRate.toFixed(5)),
      recentMatchRate:Number(tournamentRecentRate(s).toFixed(5)),
      brierEWMA:Number(s.brierEWMA.toFixed(5)),
      logLossEWMA:Number(s.logLossEWMA.toFixed(4)),
      score:Number(tournamentScore(s).toFixed(5))
    };
  });
  const ranked=TOURNAMENT_NAMES.slice().sort((a,b)=>tournamentScore(t.candidates[a])-tournamentScore(t.candidates[b]));
  return {
    champion:t.champion,
    bestChallenger:ranked.find(x=>x!==t.champion)||t.champion,
    promotions:t.promotions,
    minSamples:TOURNAMENT_MIN_SAMPLES,
    candidates
  };
}

function ensemblePredict(){
  if(hist.length<8) return null;
  const views=modelViews();
  const futureMoveView=views.find(v=>v.name==='futureMove');
  const futureMove=futureMoveView?.forecast||movementForecast(1);
  const modelVotes=[];
  for(const v of views){
    const ew=expertWeight(v.name);
    const w=v.base*(.25+.75*v.support)*ew;
    const own=v.p.map((risk,d)=>({d,risk})).sort((a,b)=>a.risk-b.risk)[0];
    modelVotes.push({name:v.name,digit:own.d,risk:own.risk,weight:w,support:v.support,expertWeight:ew});
  }

  const baseP=blendViews(views,()=>1);
  const candidateSet=tournamentPredictions(views,baseP);
  const championName=mem.shadow.tournament?.champion||'base';
  const champion=candidateSet[championName]||candidateSet.base;

  return {
    horizon:1,
    signalEpoch:lastEpoch,
    digit:champion.digit,
    risk:champion.risk,
    rawRisk:champion.rawRisk,
    confidence:champion.confidence,
    probabilities:champion.probabilities,
    modelVotes,
    calibrationECE:mem.shadow.calibration.ece,
    driftActive:mem.shadow.drift.active,
    champion:championName,
    motion:motionSnapshot(),
    phase:marketPhaseFromMotion(motionSnapshot()),
    movementForecast:futureMove?{
      horizon:futureMove.h,
      direction:futureMove.direction,
      directionProbability:futureMove.directionProbability,
      expectedUnits:futureMove.expectedUnits,
      reversalProbability:futureMove.reversalProbability,
      continuationProbability:futureMove.continuationProbability,
      phase:futureMove.phase,
      support:futureMove.support,
      samples:futureMove.perf.samples,
      directionHitEWMA:futureMove.perf.directionHitEWMA,
      maeUnitsEWMA:futureMove.perf.maeUnitsEWMA,
      ready:futureMove.ready
    }:null,
    candidateSet,
    generatedAt:Date.now()
  };
}

function updateMasterCounterfactual(pred,actual){
  if(!pred||!Array.isArray(pred.probabilities)||pred.probabilities.length!==10)return;
  const master=mem.master||(mem.master=freshMasterBrain());
  const probs=normalizeDist(pred.probabilities);

  for(let d=0;d<10;d++){
    const st=master.digitCalibration[d];
    st.n++;
    if(actual===d)st.matches++;
    st.predictedSum+=clamp(safeNum(probs[d],UNIFORM),0,.5);
  }

  const ranking=probs.map((risk,d)=>({d,risk})).sort((a,b)=>a.risk-b.risk).map(x=>x.d);
  ranking.forEach((digit,rank)=>{
    const st=master.rankStats[rank];
    st.n++;
    if(actual===digit)st.matches++;
  });

  const ctx=hist.slice(-3).join('');
  if(ctx){
    master.errorContexts.push({
      ctx,
      digit:actual,
      ts:Date.now(),
      risk:clamp(safeNum(probs[actual],UNIFORM),0,.5)
    });
    if(master.errorContexts.length>220)master.errorContexts.shift();
  }

  master.counterfactualTicks++;
  master.revision++;
  master.updatedAt=Date.now();
}
function updateMasterStreak(streakBefore,loss){
  const master=mem.master||(mem.master=freshMasterBrain());
  const key=masterStreakBucket(streakBefore);
  const st=master.streakStats[key]||(master.streakStats[key]={n:0,matches:0});
  st.n++;
  if(loss)st.matches++;
  master.revision++;
  master.updatedAt=Date.now();
}
function updateMasterSessionAnalytics(sessionId,sessionOp,loss,sessionEnd){
  if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{6,64}$/.test(sessionId))return false;
  if(!Number.isInteger(sessionOp)||sessionOp<1||sessionOp>500)return false;
  const master=mem.master||(mem.master=freshMasterBrain());
  const sa=master.sessionAnalytics||(master.sessionAnalytics=freshSessionAnalytics());
  sa.seen=sa.seen&&typeof sa.seen==='object'?sa.seen:{};
  const eventKey=sessionId+':'+sessionOp;
  if(sa.seen[eventKey])return false;
  sa.seen[eventKey]=Date.now();

  const entries=Object.entries(sa.seen);
  if(entries.length>6000){
    entries.sort((a,b)=>safeNum(b[1],0)-safeNum(a[1],0));
    sa.seen=Object.fromEntries(entries.slice(0,6000));
  }

  if(sessionOp===1)sa.sessionsStarted++;
  sa.tradesObserved++;
  sa.maxPosition=Math.max(sa.maxPosition,sessionOp);

  const bucket=sessionOp<=50?sa.byPosition[sessionOp-1]:sa.overflow;
  bucket.trades++;

  if(loss){
    sa.matches++;
    sa.matchPositionSum+=sessionOp;
    sa.lastMatchPosition=sessionOp;
    bucket.matches++;
    if(sessionOp<=2)sa.earlyMatches++;
  }

  if(sessionEnd==='TARGET'){
    sa.sessionsCompleted++;
    sa.lastCompletionPosition=sessionOp;
    bucket.completions++;
  }else if(sessionEnd==='STOP'){
    sa.sessionsStopped++;
  }

  sa.updatedAt=Date.now();
  master.revision++;
  master.updatedAt=sa.updatedAt;
  return true;
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

  updateMasterCounterfactual(p,actual);
  updateEntryResearch(p,actual);
  updateCalibration(p.rawRisk??p.risk,match);
  hedgeUpdate(p,actual);
  detectDrift(p,actual);
  updateTournament(p.candidateSet,actual);

  sh.last={
    ts:Date.now(),
    candidate:p.digit,
    actual,
    match,
    risk:p.risk,
    rawRisk:p.rawRisk??p.risk,
    confidence:p.confidence,
    driftActive:sh.drift.active
  };
  sh.recent.push(sh.last);
  if(sh.recent.length>SHADOW_RECENT_MAX) sh.recent.shift();
}

function prepareShadow(){
  const pred=ensemblePredict();
  if(!pred){
    shadowPending=null;
    lastPrediction=null;
    return;
  }

  const distributions={};
  for(const v of modelViews()) distributions[v.name]=v.p.slice();
  shadowPending={...pred,modelDistributions:distributions};
  const {candidateSet,...publicPrediction}=pred;
  lastPrediction=publicPrediction;
}

function processDigit(d,epoch,quote){
  if(!Number.isInteger(d)||d<0||d>9) return;

  const q=Number(quote);
  const targetPrice=Number.isFinite(q)?q:(priceHist.length?priceHist[priceHist.length-1]:0);
  const nextCounter=liveTickCount+1;

  resolveMovementForecasts(targetPrice,nextCounter);
  resolveRangeForecasts(targetPrice,nextCounter);
  riseFallResolve(targetPrice,nextCounter);
  evaluateShadow(d);
  riseFallLearnOutcome(targetPrice);
  learnMovementOutcome(targetPrice,d);
  learnRangeOutcome(targetPrice,d);
  learnDigit(d,hist);

  hist.push(d);
  priceHist.push(targetPrice);
  motionHist.push(motionSnapshot(priceHist));
  if(hist.length>MAX_HIST){hist.shift();motionHist.shift()}
  if(priceHist.length>MAX_HIST)priceHist.shift();

  if(epoch){
    lastEpoch=Math.max(lastEpoch,epoch);
    mem.lastMarketEpoch=lastEpoch;
  }

  liveTickCount=nextCounter;
  lastTickAt=Date.now();
  lastDigit=d;

  if(mem.tickCount%250===0) pruneModels();
  if(mem.tickCount%25===0){
    mem.deepHistory=hist.slice(-MAX_HIST);
    mem.deepPrices=priceHist.slice(-MAX_HIST);
  }

  prepareShadow();
  scheduleMovementForecasts(liveTickCount);
  scheduleRangeForecasts(liveTickCount);
  riseFallSchedule(liveTickCount);
  if(riseFallMem.tickCount%250===0)pruneRiseFall();
  if(epoch)riseFallMem.lastEpoch=Math.max(safeNum(riseFallMem.lastEpoch,0),Number(epoch)||0);
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
      if(Number.isFinite(pip))marketPip=pip;
      bootstrapMovementPredictor();
      bootstrapRangePredictor();
      bootstrapRiseFall();

      for(let i=0;i<prices.length;i++){
        const ep=Number(times[i]||0);
        if(ep&&ep<=safeNum(mem.lastMarketEpoch,0)) continue;
        const d=digitFromQuote(prices[i],pip);
        if(d!==null) processDigit(d,ep,prices[i]);
      }

      saveMemory();
      ws.send(JSON.stringify({ticks:SYMBOL,subscribe:1}));
      return;
    }

    if(m.tick){
      const ep=Number(m.tick.epoch||0);
      if(ep&&ep<=lastEpoch) return;
      if(Number.isFinite(Number(m.tick.pip_size)))marketPip=Number(m.tick.pip_size);
      const d=digitFromQuote(m.tick.quote,m.tick.pip_size);
      if(d!==null) processDigit(d,ep,m.tick.quote);
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

function masterExpertWeights(){
  const perf=mem.shadow.performance||{};
  const w=name=>clamp(safeNum(perf[name]?.weight,1),.12,5);
  return {
    global:w('global'),
    recent:clamp((w('recent25')*1.2+w('recent100')+w('recent300')*.55)/2.75,.12,5),
    ctx1:w('ctx1'),
    ctx2:w('ctx2'),
    ctx3:w('ctx3'),
    motion:w('motion'),
    phase:w('phase'),
    futureMove:w('futureMove'),
    range:w('range'),
    collab:w('collab')
  };
}
function masterPublic(){
  const master=mem.master||freshMasterBrain();
  const champion=mem.shadow.tournament?.champion||'base';
  const champStat=mem.shadow.tournament?.candidates?.[champion];
  return {
    version:MASTER_BRAIN_VERSION,
    revision:master.revision,
    updatedAt:master.updatedAt,
    cloudTicks:mem.tickCount,
    signalEpoch:lastEpoch,
    counterfactualTicks:master.counterfactualTicks,
    digitCalibration:master.digitCalibration,
    rankStats:master.rankStats,
    errorContexts:master.errorContexts.slice(-160),
    streakStats:master.streakStats,
    sessionAnalytics:(()=>{
      const sa=master.sessionAnalytics||freshSessionAnalytics();
      return {
        sessionsStarted:sa.sessionsStarted,
        sessionsCompleted:sa.sessionsCompleted,
        sessionsStopped:sa.sessionsStopped,
        completionRate:sa.sessionsStarted?sa.sessionsCompleted/sa.sessionsStarted:0,
        tradesObserved:sa.tradesObserved,
        matches:sa.matches,
        earlyMatches:sa.earlyMatches,
        earlyMatchRate:sa.matches?sa.earlyMatches/sa.matches:0,
        avgMatchPosition:sa.matches?sa.matchPositionSum/sa.matches:0,
        maxPosition:sa.maxPosition,
        lastMatchPosition:sa.lastMatchPosition,
        lastCompletionPosition:sa.lastCompletionPosition,
        byPosition:sa.byPosition,
        overflow:sa.overflow,
        updatedAt:sa.updatedAt
      };
    })(),
    expertWeights:masterExpertWeights(),
    expertPerformance:Object.fromEntries(MODEL_NAMES.map(name=>{
      const p=mem.shadow.performance?.[name]||{};
      return [name,{
        samples:Math.max(0,Math.floor(safeNum(p.samples,0))),
        weight:clamp(safeNum(p.weight,1),.12,5),
        matchEWMA:clamp(safeNum(p.matchEWMA,UNIFORM),0,1),
        logLossEWMA:clamp(safeNum(p.logLossEWMA,Math.log(10)),.01,12)
      }];
    })),
    prequential:{
      samples:mem.shadow.total,
      brierEWMA:clamp(safeNum(mem.shadow.calibration?.brierEWMA,.09),0,1),
      logLossEWMA:clamp(safeNum(champStat?.logLossEWMA,Math.log(10)),.01,12)
    },
    drift:{
      active:!!mem.shadow.drift?.active,
      events:Math.max(0,safeNum(mem.shadow.drift?.events,0)),
      updatedAt:Math.max(safeNum(mem.shadow.drift?.lastAt,0),master.updatedAt)
    },
    champion,
    entryResearch:entryResearchPublic(),
    rangePredictor:(()=>{
      const f=rangeForecast(1),p=mem.rangePerf[1]||freshRangePerf();
      return {
        samples:p.samples,
        logLossEWMA:p.logLossEWMA,
        brierEWMA:p.brierEWMA,
        accuracyEWMA:p.accuracyEWMA,
        activeRange:!!f?.activeRange,
        stayProbability:f?.stayProbability||0,
        breakoutDownProbability:f?.breakoutDownProbability||0,
        breakoutUpProbability:f?.breakoutUpProbability||0,
        widthUnits:f?.widthUnits||0,
        compressionBand:f?.compressionBand||'UNKNOWN',
        lateralScore:f?.lateralScore||0,
        digitCorridor:f?.digitCorridor||null,
        exposedDigits:f?.exposedDigits||[],
        support:f?.support||0,
        ready:!!f?.ready
      };
    })(),
    movementPredictor:(()=>{
      const f=movementForecast(1),p=mem.movementPerf[1]||freshMovePerf();
      return {
        samples:p.samples,
        logLossEWMA:p.logLossEWMA,
        brierEWMA:p.brierEWMA,
        directionHitEWMA:p.directionHitEWMA,
        maeUnitsEWMA:p.maeUnitsEWMA,
        direction:f?.direction||'UNKNOWN',
        directionProbability:f?.directionProbability||0,
        expectedUnits:f?.expectedUnits||0,
        reversalProbability:f?.reversalProbability||0,
        continuationProbability:f?.continuationProbability||0,
        support:f?.support||0,
        phase:f?.phase||'UNKNOWN',
        ready:!!f?.ready
      };
    })(),
    shadowMatchRate:clamp(safeNum(mem.shadow.matchRate,UNIFORM),0,1),
    collaborativeAccepted:mem.collaborative.accepted,
    collaborativeMatchRate:mem.collaborative.accepted?clamp(safeNum(mem.collaborative.matchRate,UNIFORM),0,1):UNIFORM
  };
}

function browserMemory(){
  return {
    version:mem.version,
    createdAt:mem.createdAt,
    updatedAt:mem.updatedAt,
    tickCount:mem.tickCount,
    models:mem.models,
    motionModels:mem.motionModels,
    phaseModels:mem.phaseModels,
    movementModels:mem.movementModels,
    moveDigitModels:mem.moveDigitModels,
    movementBucketStats:mem.movementBucketStats,
    movementPerf:mem.movementPerf,
    rangeModels:mem.rangeModels,
    rangePerf:mem.rangePerf,
    globalP:mem.globalP,
    globalN:mem.globalN,
    modelLoss:mem.modelLoss,
    master:masterPublic(),
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
      logLossEWMA:Number(p.logLossEWMA.toFixed(4)),
      cumulativeLoss:Number(p.cumulativeLoss.toFixed(3))
    };
  });
  return out;
}
function calibrationSummary(){
  const c=mem.shadow.calibration;
  return {
    samples:c.samples,
    brierEWMA:Number(c.brierEWMA.toFixed(5)),
    predictedEWMA:Number(c.predictedEWMA.toFixed(5)),
    observedEWMA:Number(c.observedEWMA.toFixed(5)),
    ece:Number(c.ece.toFixed(5))
  };
}
function driftSummary(){
  const d=mem.shadow.drift;
  return {
    events:d.events,
    active:d.active,
    boostRemaining:d.boostRemaining,
    lastAt:d.lastAt,
    score:Number(d.score.toFixed(5)),
    epsilon:Number(d.epsilon.toFixed(5))
  };
}

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','https://quispillocharly-gif.github.io');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({limit:'8kb'}));
app.use(express.static(__dirname));

function collaborativePublic(){
  const col=mem.collaborative;
  return {
    received:col.received,
    accepted:col.accepted,
    duplicates:col.duplicates,
    wins:col.wins,
    matches:col.matches,
    matchRate:col.accepted?col.matches/col.accepted:UNIFORM,
    lastAt:col.lastAt,
    updatedAt:col.updatedAt,
    byDigit:col.byDigit,
    contexts:col.contexts
  };
}

function cleanCollaborativeSeen(){
  const col=mem.collaborative;
  const entries=Object.entries(col.seen);
  if(entries.length<=5000)return;
  entries.sort((a,b)=>safeNum(b[1],0)-safeNum(a[1],0));
  col.seen=Object.fromEntries(entries.slice(0,5000));
}

app.post('/api/cloud/experience',(req,res)=>{
  const b=req.body||{};
  const col=mem.collaborative;
  col.received++;

  const signalEpoch=Math.floor(safeNum(b.signalEpoch,0));
  const digit=Math.floor(safeNum(b.digit,-1));
  const loss=b.loss===true||b.loss===1;
  const risk=safeNum(b.risk,NaN);
  const confidence=safeNum(b.confidence,NaN);
  const elapsed=Math.floor(safeNum(b.elapsed,1));
  const streakBeforeRaw=safeNum(b.streakBefore,NaN);
  const streakBefore=Number.isFinite(streakBeforeRaw)?Math.max(0,Math.min(200,Math.floor(streakBeforeRaw))):null;
  const sessionId=typeof b.sessionId==='string'&&/^[A-Za-z0-9_-]{6,64}$/.test(b.sessionId)?b.sessionId:'';
  const sessionOpRaw=safeNum(b.sessionOp,NaN);
  const sessionOp=Number.isFinite(sessionOpRaw)?Math.max(1,Math.min(500,Math.floor(sessionOpRaw))):null;
  const sessionEnd=(b.sessionEnd==='TARGET'||b.sessionEnd==='STOP')?b.sessionEnd:'';
  const context=Array.isArray(b.context)
    ? b.context.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=9).slice(-6)
    : [];

  if(!signalEpoch || digit<0 || digit>9 || !Number.isFinite(risk) || risk<0 || risk>.5 ||
     !Number.isFinite(confidence) || confidence<0 || confidence>1 || elapsed<1 || elapsed>3 || context.length<1){
    return res.status(400).json({ok:false,error:'invalid experience'});
  }

  // Solo acepta experiencias cercanas al mercado vivo del cloud.
  if(lastEpoch && Math.abs(signalEpoch-lastEpoch)>90){
    return res.status(409).json({ok:false,error:'stale experience'});
  }

  // Analítica de sesión: cada sesión tiene su propio ID anónimo y cada posición cuenta una vez.
  // Va antes del dedupe de evidencia de mercado porque dos sesiones distintas pueden coincidir
  // en el mismo tick y ambas deben formar parte del estudio de sesiones.
  if(sessionId&&sessionOp!==null)updateMasterSessionAnalytics(sessionId,sessionOp,loss,sessionEnd);

  // Mismo tick + mismo dígito = una sola evidencia de mercado, aunque lo operen varias personas.
  const dedupKey=signalEpoch+':'+digit;
  if(col.seen[dedupKey]){
    col.duplicates++;
    return res.json({ok:true,accepted:false,duplicate:true,sharedAccepted:col.accepted});
  }
  col.seen[dedupKey]=Date.now();
  cleanCollaborativeSeen();

  col.accepted++;
  if(loss)col.matches++; else col.wins++;
  col.matchRate=col.matches/col.accepted;
  if(streakBefore!==null)updateMasterStreak(streakBefore,loss);
  col.lastAt=Date.now();
  col.updatedAt=Date.now();

  const g=col.byDigit[digit];
  g.n++;
  if(loss)g.matches++;
  g.last=signalEpoch;

  const ctx=context.slice(-2).join('');
  const key=ctx+'>'+digit;
  const node=col.contexts[key]||(col.contexts[key]={n:0,matches:0,last:0});
  node.n++;
  if(loss)node.matches++;
  node.last=signalEpoch;

  if(col.accepted%10===0)saveMemory();

  return res.json({
    ok:true,
    accepted:true,
    duplicate:false,
    sharedAccepted:col.accepted,
    sharedWins:col.wins,
    sharedMatches:col.matches
  });
});

app.get('/api/cloud/master',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,status,symbol:SYMBOL,master:masterPublic(),generatedAt:Date.now()});
});

app.get('/api/cloud/collaborative',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({ok:true,symbol:SYMBOL,collaborative:collaborativePublic()});
});

app.post('/api/rise-fall/experience',(req,res)=>{
  const result=recordRiseFallDemoOperation(req.body||{});
  if(!result.ok)return res.status(400).json(result);
  res.json(result);
});

app.get('/api/rise-fall/status',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json(riseFallStatus());
});

app.get('/api/rise-fall/prediction',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const h=clamp(Math.round(safeNum(req.query.h,1)),1,3);
  res.json({
    ok:true,
    status,
    symbol:SYMBOL,
    isolated:true,
    learnsWhenBrowserClosed:true,
    prediction:riseFallPredict(h),
    updatedAt:riseFallMem.updatedAt
  });
});

app.get('/api/cloud/status',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,status,symbol:SYMBOL,startedAt,
    uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),
    tickCount:mem.tickCount,
    deepHistorySize:hist.length,
    liveTickCount,lastTickAt,lastDigit,lastPrediction,
    motion:motionSnapshot(),
    master:{version:MASTER_BRAIN_VERSION,revision:mem.master.revision,updatedAt:mem.master.updatedAt,counterfactualTicks:mem.master.counterfactualTicks,sessionAnalytics:masterPublic().sessionAnalytics},
    shadow:{
      total:mem.shadow.total,
      wins:mem.shadow.wins,
      matches:mem.shadow.matches,
      matchRate:mem.shadow.matchRate,
      edgeVsBaseline:mem.shadow.edgeVsBaseline,
      last:mem.shadow.last,
      modelCount:MODEL_NAMES.length,
      hedgeEta:HEDGE_ETA,
      performance:performanceSummary(),
      calibration:calibrationSummary(),
      drift:driftSummary(),
      tournament:tournamentSummary()
    },
    collaborative:{
      accepted:mem.collaborative.accepted,
      received:mem.collaborative.received,
      duplicates:mem.collaborative.duplicates,
      wins:mem.collaborative.wins,
      matches:mem.collaborative.matches,
      matchRate:mem.collaborative.accepted?mem.collaborative.matches/mem.collaborative.accepted:UNIFORM,
      lastAt:mem.collaborative.lastAt
    },
    updatedAt:mem.updatedAt
  });
});

app.get('/api/cloud/prediction',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,
    prediction:lastPrediction,
    shadow:mem.shadow.last,
    calibration:calibrationSummary(),
    drift:driftSummary(),
    tournament:tournamentSummary(),
    master:{version:MASTER_BRAIN_VERSION,revision:mem.master.revision,updatedAt:mem.master.updatedAt}
  });
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
    performance:performanceSummary(),
    calibration:calibrationSummary(),
    drift:driftSummary(),
    tournament:tournamentSummary()
  });
});

app.get('/api/cloud/snapshot',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json({
    ok:true,status,symbol:SYMBOL,lastEpoch,lastTickAt,lastDigit,
    recentDigits:hist.slice(-120),
    recentPrices:priceHist.slice(-120),
    master:masterPublic(),
    memory:browserMemory()
  });
});

app.get('/health',(req,res)=>{
  res.status(status==='ONLINE'?200:503).json({
    ok:status==='ONLINE',
    status,
    ticks:mem.tickCount,
    shadowTrades:mem.shadow.total,
    history:hist.length,
    driftActive:mem.shadow.drift.active
  });
});

app.listen(PORT,()=>{
  console.log('Differ AI cloud Hedge+Drift+Calibration server listening on port',PORT);
  console.log('Persistent history restored:',hist.length,'ticks');
  console.log('Shadow trades restored:',mem.shadow.total);
  console.log('Drift events restored:',mem.shadow.drift.events);
  console.log('Collaborative experiences restored:',mem.collaborative.accepted);
  console.log('Master brain restored:',mem.master.counterfactualTicks,'counterfactual ticks · revision',mem.master.revision);
  console.log('Entry research restored:',mem.entryResearch.resolved,'resolved forecasts · recommendation',mem.entryResearch.recommended);
  console.log('Range Intelligence restored:',mem.rangePerf[1].samples,'validated 1T range forecasts');
  console.log('Rise/Fall memory restored:',riseFallMem.trainedSamples,'training samples ·',riseFallMem.performance[1].resolved,'validated 1T forecasts');
  prepareShadow();
  connectDeriv();
});

saveTimer=setInterval(()=>{
  saveMemory();
  saveRiseFallMemory();
},15000);

function shutdown(){
  clearInterval(saveTimer);
  saveMemory();
  saveRiseFallMemory();
  try{if(ws)ws.close()}catch(_){}
  process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
