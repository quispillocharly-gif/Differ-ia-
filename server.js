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
const MODEL_NAMES = ['global','recent25','recent100','recent300','ctx1','ctx2','ctx3','motion','phase','collab'];
const HEDGE_ETA = 0.34;
const CAL_BINS = 20;
const DRIFT_MAX_WINDOW = 360;
const TOURNAMENT_NAMES = ['base','recentFocus','contextFocus','robust'];
const TOURNAMENT_MIN_SAMPLES = 2000;
const TOURNAMENT_RECENT = 600;
const TOURNAMENT_COOLDOWN_TICKS = 1800;
const MASTER_BRAIN_VERSION = 'NEXUS-MASTER-1';

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
let status = 'BOOTING';

function blankP(){ return Array(10).fill(UNIFORM); }
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
    globalP: blankP(),
    globalN: 0,
    modelLoss: {},
    delayEWMA: 1,
    lastMarketEpoch: 0,
    deepHistory: [],
    deepPrices: [],
    collaborative: freshCollaborative(),
    master: freshMasterBrain(),
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

  const phase=phaseDist();
  if(phase){
    // Nueva capa de estructura: impulso, agotamiento, retroceso, giro, continuación o rango.
    // Aprende siempre en shadow y solo vota cuando demuestra utilidad prequential.
    const pp=mem.shadow.performance.phase||{samples:0,matchEWMA:UNIFORM,logLossEWMA:Math.log(10)};
    const ready=
      safeNum(phase.n,0)>=500 &&
      safeNum(pp.samples,0)>=300 &&
      safeNum(pp.matchEWMA,UNIFORM)<UNIFORM-.0018 &&
      safeNum(pp.logLossEWMA,Math.log(10))<=Math.log(10)+.025;
    const maturity=clamp((safeNum(pp.samples,0)-300)/1400,0,1);
    const base=ready ? (.15+.30*maturity) : 0;
    views.push({name:'phase',p:phase.p,support:phase.support,base,n:phase.n,phase:phase.phase,state:phase.state,ready});
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
  const risks=views.map(v=>v.p[best.d]);
  const m=mean(risks);
  const variance=risks.length?risks.reduce((s,x)=>s+(x-m)**2,0)/risks.length:0;
  const disagreement=Math.sqrt(variance);
  const support=views.length?views.reduce((s,v)=>s+v.support,0)/views.length:0;
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
    if(!st||st.samples<TOURNAMENT_MIN_SAMPLES||st.recent.length<TOURNAMENT_RECENT)return;
    const score=tournamentScore(st);
    const recentGain=tournamentRecentRate(current)-tournamentRecentRate(st);
    const brierOkay=st.brierEWMA<=current.brierEWMA+.0015;
    const logOkay=st.logLossEWMA<=current.logLossEWMA+.025;
    if(recentGain>=.006 && brierOkay && logOkay && score<bestScore-.003){
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

  evaluateShadow(d);

  learnDigit(d,hist);
  hist.push(d);
  const q=Number(quote);
  priceHist.push(Number.isFinite(q)?q:(priceHist.length?priceHist[priceHist.length-1]:0));
  motionHist.push(motionSnapshot(priceHist));
  if(hist.length>MAX_HIST){hist.shift();motionHist.shift()}
  if(priceHist.length>MAX_HIST)priceHist.shift();

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
      if(Number.isFinite(pip))marketPip=pip;

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
