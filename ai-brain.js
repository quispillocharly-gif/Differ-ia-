(()=>{
'use strict';

const $=id=>document.getElementById(id);
const KEY='DIFFER_ONLINE_AI_V1_MEMORY';
const VERSION=1;
const ORDERS=[1,2,3];
const HORIZONS=[1,2,3];
const UNIFORM=.10;
const MAX_HIST=1200;
const LOG_MAX=180;
const CLOUD_URL='https://differ-ia-cloud-production.up.railway.app';
const EXPERTS=['global','recent','ctx1','ctx2','ctx3','motion','phase','futureMove','range','collab','cloud'];
const BASELINE_LOGLOSS=Math.log(10);
const BASELINE_BRIER=.09;
const MOVE_BUCKETS=['DOWN_JUMP','DOWN_MED','DOWN_SMALL','FLAT','UP_SMALL','UP_MED','UP_JUMP'];
const MOVE_CENTERS=[-14,-6,-2,0,2,6,14];
const MOVE_UNIFORM=1/MOVE_BUCKETS.length;
const MOVE_BASE_LOGLOSS=Math.log(MOVE_BUCKETS.length);
const MOVE_BASE_BRIER=6/49;
const RANGE_UNIFORM=1/3;
const RANGE_BASE_LOGLOSS=Math.log(3);
const RANGE_BASE_BRIER=2/9;
const NORMAL_RISK_CEILING=.0975;
const STRONG_RISK_CEILING=.0880;
const AUTO_CONFIRM_TICKS=2;
const ADAPTIVE_WAIT_START=8;
const ADAPTIVE_WAIT_FULL=28;
const DIFFER_POLICY_VERSION='DIFFER-RISK-FIRST-V1';

let marketWS=null,reconnectTimer=null,lastEpoch=0;
let hist=[];                 // dígitos en vivo/históricos
let epochs=[];
let priceHist=[];             // precios reales R_75 alineados con hist
let motionHist=[];            // estado de movimiento conocido en cada tick
let marketPip=4;              // precisión del quote para medir microdesplazamiento
let liveTickCounter=0;
let autoRunning=false;
let pendingTrade=null;
let session={pnl:0,wins:0,losses:0,ops:0,settled:0,streak:0,maxStreak:0};
let sessionStarted=false,sessionPaused=false,sessionClosed=false,sessionId='';
let lastDecision=null;
let recentLogs=[];
let nextStake=null;
let autoWaitTicks=0;
let autoSignal={
  digit:null,count:0,lastTick:-1,lastRisk:UNIFORM,lastScore:0,lastConfidence:0,
  lastOod:1,lastConsensus:0,lastRobustRisk:.30,needed:AUTO_CONFIRM_TICKS
};
let sharedModel={accepted:0,wins:0,matches:0,matchRate:UNIFORM,byDigit:Array.from({length:10},()=>({n:0,matches:0})),contexts:{},updatedAt:0};
let sharedSyncTimer=null,sharedLogged=false,cloudPredictionTimer=null,masterSyncTimer=null;
let predictionQueue=[];
let cloudLive={prediction:null,updatedAt:0};
let movementQueue=[];
let rangeQueue=[];
let cloudMaster={
  version:'',revision:0,updatedAt:0,receivedAt:0,cloudTicks:0,signalEpoch:0,
  counterfactualTicks:0,digitCalibration:null,rankStats:null,errorContexts:[],
  streakStats:null,expertWeights:{},expertPerformance:{},prequential:null,drift:null,champion:'',
  shadowMatchRate:UNIFORM,collaborativeAccepted:0,collaborativeMatchRate:UNIFORM,
  sessionAnalytics:null,movementPredictor:null,rangePredictor:null,entryResearch:null,calibration:null
};

function blankP(){return Array(10).fill(UNIFORM)}
function blankMoveP(){return Array(MOVE_BUCKETS.length).fill(MOVE_UNIFORM)}
function freshMovePerf(){return {samples:0,logLossEWMA:MOVE_BASE_LOGLOSS,brierEWMA:MOVE_BASE_BRIER,directionHitEWMA:1/3,maeUnitsEWMA:6,lastAt:0}}
function freshRangePerf(){return {samples:0,logLossEWMA:RANGE_BASE_LOGLOSS,brierEWMA:RANGE_BASE_BRIER,accuracyEWMA:1/3,lastAt:0}}
function freshExpertPerf(){
  const out={};
  EXPERTS.forEach(name=>out[name]={samples:0,logLossEWMA:BASELINE_LOGLOSS,skillEWMA:0,weight:1});
  return out;
}
function freshDrift(){
  return {samples:0,fast:BASELINE_BRIER,slow:BASELINE_BRIER,active:false,remaining:0,events:0,lastAt:0};
}
function freshMemory(){
  const models={};
  HORIZONS.forEach(h=>{
    models[h]={};
    ORDERS.forEach(o=>models[h][o]={});
  });
  return {
    version:VERSION,
    createdAt:Date.now(),
    updatedAt:Date.now(),
    tickCount:0,
    tradeCount:0,
    lastMarketEpoch:0,
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
    globalP:blankP(),
    globalN:0,
    modelLoss:{},
    expertPerf:freshExpertPerf(),
    prequential:{samples:0,brierEWMA:BASELINE_BRIER,logLossEWMA:BASELINE_LOGLOSS},
    drift:freshDrift(),
    lossEWMA:.10,
    calibrationEWMA:0,
    delayEWMA:1,
    recentTrades:[],
    recentPicks:[],
    digitStats:Array.from({length:10},()=>({w:0,l:0})),
    digitCalibration:Array.from({length:10},()=>({n:0,matches:0,predictedSum:0})),
    rankStats:Array.from({length:10},()=>({n:0,matches:0})),
    errorContexts:[],
    streakStats:{
      '0-2':{n:0,matches:0},
      '3-5':{n:0,matches:0},
      '6-8':{n:0,matches:0},
      '9-11':{n:0,matches:0},
      '12+':{n:0,matches:0}
    },
    recovery:{remaining:0,lastMatchAt:0},
    saves:0
  };
}

function normalizeMemory(x){
  if(!x||x.version!==VERSION)return freshMemory();
  const base=freshMemory();
  const m={...base,...x};
  m.models=m.models||base.models;
  HORIZONS.forEach(h=>{
    m.models[h]=m.models[h]||{};
    ORDERS.forEach(o=>m.models[h][o]=m.models[h][o]||{});
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
    const stats=Array.isArray(m.movementBucketStats[h])?m.movementBucketStats[h]:[];
    m.movementBucketStats[h]=Array.from({length:7},(_,i)=>({
      n:Math.max(0,Math.floor(safeNum(stats[i]?.n,0))),
      sum:safeNum(stats[i]?.sum,0)
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
  m.globalP=Array.isArray(m.globalP)&&m.globalP.length===10?m.globalP:blankP();
  m.recentTrades=Array.isArray(m.recentTrades)?m.recentTrades.slice(-60):[];
  m.recentPicks=Array.isArray(m.recentPicks)?m.recentPicks.slice(-30):[];
  m.digitStats=Array.isArray(m.digitStats)&&m.digitStats.length===10?m.digitStats:base.digitStats;
  m.modelLoss=m.modelLoss||{};
  const perf=freshExpertPerf();
  const oldPerf=m.expertPerf&&typeof m.expertPerf==='object'?m.expertPerf:{};
  EXPERTS.forEach(name=>{
    const p=oldPerf[name]||{};
    perf[name]={
      samples:Math.max(0,safeNum(p.samples,0)),
      logLossEWMA:clamp(safeNum(p.logLossEWMA,BASELINE_LOGLOSS),.05,8),
      skillEWMA:clamp(safeNum(p.skillEWMA,0),-2,2),
      weight:clamp(safeNum(p.weight,1),.35,2.8)
    };
  });
  m.expertPerf=perf;
  const pq=m.prequential||{};
  m.prequential={
    samples:Math.max(0,safeNum(pq.samples,0)),
    brierEWMA:clamp(safeNum(pq.brierEWMA,BASELINE_BRIER),0,1),
    logLossEWMA:clamp(safeNum(pq.logLossEWMA,BASELINE_LOGLOSS),.05,8)
  };
  const dr={...freshDrift(),...(m.drift||{})};
  dr.samples=Math.max(0,safeNum(dr.samples,0));
  dr.fast=clamp(safeNum(dr.fast,BASELINE_BRIER),0,1);
  dr.slow=clamp(safeNum(dr.slow,BASELINE_BRIER),0,1);
  dr.active=!!dr.active;
  dr.remaining=Math.max(0,Math.floor(safeNum(dr.remaining,0)));
  dr.events=Math.max(0,Math.floor(safeNum(dr.events,0)));
  dr.lastAt=Math.max(0,safeNum(dr.lastAt,0));
  m.drift=dr;
  m.digitCalibration=Array.from({length:10},(_,d)=>{
    const x=Array.isArray(m.digitCalibration)?m.digitCalibration[d]:null;
    return {
      n:Math.max(0,Math.floor(safeNum(x?.n,0))),
      matches:Math.max(0,Math.floor(safeNum(x?.matches,0))),
      predictedSum:Math.max(0,safeNum(x?.predictedSum,0))
    };
  });
  m.rankStats=Array.from({length:10},(_,i)=>{
    const x=Array.isArray(m.rankStats)?m.rankStats[i]:null;
    return {n:Math.max(0,Math.floor(safeNum(x?.n,0))),matches:Math.max(0,Math.floor(safeNum(x?.matches,0)))};
  });
  m.errorContexts=Array.isArray(m.errorContexts)?m.errorContexts.slice(-100).map(x=>({
    ctx:String(x?.ctx||'').slice(-3),
    digit:Math.max(0,Math.min(9,Math.floor(safeNum(x?.digit,0)))),
    ts:Math.max(0,safeNum(x?.ts,0)),
    risk:clamp(safeNum(x?.risk,UNIFORM),0,.5),
    confidence:clamp(safeNum(x?.confidence,0),0,1)
  })):[];
  const sb=base.streakStats,ss=m.streakStats&&typeof m.streakStats==='object'?m.streakStats:{};
  m.streakStats={};
  Object.keys(sb).forEach(k=>{
    const x=ss[k]||{};
    m.streakStats[k]={n:Math.max(0,Math.floor(safeNum(x.n,0))),matches:Math.max(0,Math.floor(safeNum(x.matches,0)))};
  });
  const streakSamples=Object.values(m.streakStats).reduce((s,x)=>s+safeNum(x.n,0),0);
  if(streakSamples===0 && Array.isArray(m.recentTrades) && m.recentTrades.length){
    let run=0;
    m.recentTrades.forEach(t=>{
      const key=run<=2?'0-2':run<=5?'3-5':run<=8?'6-8':run<=11?'9-11':'12+';
      const st=m.streakStats[key];
      st.n++;
      if(t?.loss){st.matches++;run=0}else run++;
    });
  }
  const rec=m.recovery||{};
  m.recovery={remaining:Math.max(0,Math.floor(safeNum(rec.remaining,0))),lastMatchAt:Math.max(0,safeNum(rec.lastMatchAt,0))};
  return m;
}

function loadMemory(){
  try{return normalizeMemory(JSON.parse(localStorage.getItem(KEY)||'null'))}
  catch(_){return freshMemory()}
}
let mem=loadMemory();

function saveMemory(force=false){
  if(!force && mem.tickCount%5!==0)return;
  mem.updatedAt=Date.now();
  mem.saves=(mem.saves||0)+1;
  try{localStorage.setItem(KEY,JSON.stringify(mem))}
  catch(e){
    pruneModels(true);
    try{localStorage.setItem(KEY,JSON.stringify(mem))}catch(_){}
  }
}

function log(s){
  const line=new Date().toLocaleTimeString()+' · '+s;
  recentLogs.unshift(line);
  if(recentLogs.length>LOG_MAX)recentLogs.length=LOG_MAX;
  $('log').textContent=recentLogs.join('\n');
}

function fmtPct(x){return Number.isFinite(x)?(x*100).toFixed(2)+'%':'—'}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function safeNum(x,d=0){x=Number(x);return Number.isFinite(x)?x:d}
function normalizeSessionAnalytics(x){
  const s=x&&typeof x==='object'?x:{};
  const by=Array.from({length:50},(_,i)=>{
    const v=Array.isArray(s.byPosition)?s.byPosition[i]:null;
    return {
      trades:Math.max(0,Math.floor(safeNum(v?.trades,0))),
      matches:Math.max(0,Math.floor(safeNum(v?.matches,0))),
      completions:Math.max(0,Math.floor(safeNum(v?.completions,0)))
    };
  });
  return {
    sessionsStarted:Math.max(0,Math.floor(safeNum(s.sessionsStarted,0))),
    sessionsCompleted:Math.max(0,Math.floor(safeNum(s.sessionsCompleted,0))),
    sessionsStopped:Math.max(0,Math.floor(safeNum(s.sessionsStopped,0))),
    completionRate:clamp(safeNum(s.completionRate,0),0,1),
    tradesObserved:Math.max(0,Math.floor(safeNum(s.tradesObserved,0))),
    matches:Math.max(0,Math.floor(safeNum(s.matches,0))),
    earlyMatches:Math.max(0,Math.floor(safeNum(s.earlyMatches,0))),
    earlyMatchRate:clamp(safeNum(s.earlyMatchRate,0),0,1),
    avgMatchPosition:Math.max(0,safeNum(s.avgMatchPosition,0)),
    maxPosition:Math.max(0,Math.floor(safeNum(s.maxPosition,0))),
    lastMatchPosition:Math.max(0,Math.floor(safeNum(s.lastMatchPosition,0))),
    lastCompletionPosition:Math.max(0,Math.floor(safeNum(s.lastCompletionPosition,0))),
    byPosition:by,
    overflow:{
      trades:Math.max(0,Math.floor(safeNum(s.overflow?.trades,0))),
      matches:Math.max(0,Math.floor(safeNum(s.overflow?.matches,0))),
      completions:Math.max(0,Math.floor(safeNum(s.overflow?.completions,0)))
    },
    updatedAt:Math.max(0,safeNum(s.updatedAt,0))
  };
}
function normalizeCloudMaster(x){
  if(!x||typeof x!=='object')return null;
  const dc=Array.from({length:10},(_,d)=>{
    const s=Array.isArray(x.digitCalibration)?x.digitCalibration[d]:null;
    return {n:Math.max(0,Math.floor(safeNum(s?.n,0))),matches:Math.max(0,Math.floor(safeNum(s?.matches,0))),predictedSum:Math.max(0,safeNum(s?.predictedSum,0))};
  });
  const rs=Array.from({length:10},(_,i)=>{
    const s=Array.isArray(x.rankStats)?x.rankStats[i]:null;
    return {n:Math.max(0,Math.floor(safeNum(s?.n,0))),matches:Math.max(0,Math.floor(safeNum(s?.matches,0)))};
  });
  const baseStreak={'0-2':{n:0,matches:0},'3-5':{n:0,matches:0},'6-8':{n:0,matches:0},'9-11':{n:0,matches:0},'12+':{n:0,matches:0}};
  const ss={};
  Object.keys(baseStreak).forEach(k=>{
    const s=x.streakStats?.[k]||{};
    ss[k]={n:Math.max(0,Math.floor(safeNum(s.n,0))),matches:Math.max(0,Math.floor(safeNum(s.matches,0)))};
  });
  const ew={};
  ['global','recent','ctx1','ctx2','ctx3','motion','phase','futureMove','range','collab'].forEach(name=>{
    if(Number.isFinite(Number(x.expertWeights?.[name])))ew[name]=clamp(Number(x.expertWeights[name]),.12,5);
  });
  return {
    version:String(x.version||''),
    revision:Math.max(0,Math.floor(safeNum(x.revision,0))),
    updatedAt:Math.max(0,safeNum(x.updatedAt,0)),
    receivedAt:Date.now(),
    cloudTicks:Math.max(0,Math.floor(safeNum(x.cloudTicks,0))),
    signalEpoch:Math.max(0,Math.floor(safeNum(x.signalEpoch,0))),
    counterfactualTicks:Math.max(0,Math.floor(safeNum(x.counterfactualTicks,0))),
    digitCalibration:dc,
    rankStats:rs,
    errorContexts:Array.isArray(x.errorContexts)?x.errorContexts.slice(-160).map(v=>({
      ctx:String(v?.ctx||'').slice(-3),
      digit:Math.max(0,Math.min(9,Math.floor(safeNum(v?.digit,0)))),
      ts:Math.max(0,safeNum(v?.ts,0)),
      risk:clamp(safeNum(v?.risk,UNIFORM),0,.5)
    })):[],
    streakStats:ss,
    expertWeights:ew,
    expertPerformance:(()=>{
      const out={};
      const raw=x.expertPerformance&&typeof x.expertPerformance==='object'?x.expertPerformance:{};
      Object.keys(raw).forEach(name=>{
        const p=raw[name]||{};
        out[name]={
          samples:Math.max(0,Math.floor(safeNum(p.samples,0))),
          weight:clamp(safeNum(p.weight,1),.12,5),
          matchEWMA:clamp(safeNum(p.matchEWMA,UNIFORM),0,1),
          logLossEWMA:clamp(safeNum(p.logLossEWMA,BASELINE_LOGLOSS),.01,12)
        };
      });
      return out;
    })(),
    prequential:{
      samples:Math.max(0,Math.floor(safeNum(x.prequential?.samples,0))),
      brierEWMA:clamp(safeNum(x.prequential?.brierEWMA,BASELINE_BRIER),0,1),
      logLossEWMA:clamp(safeNum(x.prequential?.logLossEWMA,BASELINE_LOGLOSS),.01,12)
    },
    calibration:(()=>{
      const q=x.calibration&&typeof x.calibration==='object'?x.calibration:{};
      return {
        samples:Math.max(0,Math.floor(safeNum(q.samples,0))),
        brierEWMA:clamp(safeNum(q.brierEWMA,BASELINE_BRIER),0,1),
        predictedEWMA:clamp(safeNum(q.predictedEWMA,UNIFORM),0,.5),
        observedEWMA:clamp(safeNum(q.observedEWMA,UNIFORM),0,.5),
        ece:clamp(safeNum(q.ece,0),0,.5)
      };
    })(),
    drift:{
      active:!!x.drift?.active,
      events:Math.max(0,Math.floor(safeNum(x.drift?.events,0))),
      updatedAt:Math.max(0,safeNum(x.drift?.updatedAt,0))
    },
    champion:String(x.champion||''),
    shadowMatchRate:clamp(safeNum(x.shadowMatchRate,UNIFORM),0,1),
    collaborativeAccepted:Math.max(0,Math.floor(safeNum(x.collaborativeAccepted,0))),
    collaborativeMatchRate:clamp(safeNum(x.collaborativeMatchRate,UNIFORM),0,1),
    sessionAnalytics:normalizeSessionAnalytics(x.sessionAnalytics),
    entryResearch:(()=>{
      const raw=x.entryResearch&&typeof x.entryResearch==='object'?x.entryResearch:{};
      const profile=raw.profile&&typeof raw.profile==='object'?raw.profile:{};
      const recommended=['balanced','strict','surgical'].includes(String(raw.recommended||''))?String(raw.recommended):'balanced';
      return {
        resolved:Math.max(0,Math.floor(safeNum(raw.resolved,0))),
        recommended,
        ready:!!raw.ready,
        profile:{
          riskCeiling:clamp(safeNum(profile.riskCeiling,NORMAL_RISK_CEILING),.07,NORMAL_RISK_CEILING),
          minConfidence:clamp(safeNum(profile.minConfidence,.22),0,1),
          minConsensus:clamp(safeNum(profile.minConsensus,.54),0,1),
          robustCeiling:clamp(safeNum(profile.robustCeiling,.118),.07,.20),
          accepted:Math.max(0,Math.floor(safeNum(profile.accepted,0))),
          matches:Math.max(0,Math.floor(safeNum(profile.matches,0))),
          matchRate:clamp(safeNum(profile.matchRate,UNIFORM),0,1),
          posteriorRate:clamp(safeNum(profile.posteriorRate,UNIFORM),0,1),
          coverage:clamp(safeNum(profile.coverage,0),0,1)
        }
      };
    })(),
    rangePredictor:(()=>{
      const p=x.rangePredictor&&typeof x.rangePredictor==='object'?x.rangePredictor:{};
      const corridor=p.digitCorridor&&typeof p.digitCorridor==='object'?p.digitCorridor:null;
      return {
        samples:Math.max(0,Math.floor(safeNum(p.samples,0))),
        logLossEWMA:clamp(safeNum(p.logLossEWMA,RANGE_BASE_LOGLOSS),.01,8),
        brierEWMA:clamp(safeNum(p.brierEWMA,RANGE_BASE_BRIER),0,1),
        accuracyEWMA:clamp(safeNum(p.accuracyEWMA,1/3),0,1),
        activeRange:!!p.activeRange,
        stayProbability:clamp(safeNum(p.stayProbability,0),0,1),
        breakoutDownProbability:clamp(safeNum(p.breakoutDownProbability,0),0,1),
        breakoutUpProbability:clamp(safeNum(p.breakoutUpProbability,0),0,1),
        widthUnits:Math.max(0,safeNum(p.widthUnits,0)),
        compressionBand:String(p.compressionBand||'UNKNOWN'),
        lateralScore:clamp(safeNum(p.lateralScore,0),0,1),
        digitCorridor:corridor?{
          low:Math.max(0,Math.min(9,Math.floor(safeNum(corridor.low,0)))),
          high:Math.max(0,Math.min(9,Math.floor(safeNum(corridor.high,9)))),
          coverage:clamp(safeNum(corridor.coverage,0),0,1)
        }:null,
        exposedDigits:Array.isArray(p.exposedDigits)?p.exposedDigits.slice(0,3).map(v=>({d:Math.max(0,Math.min(9,Math.floor(safeNum(v?.d,0)))),p:clamp(safeNum(v?.p,UNIFORM),0,1)})):[],
        support:clamp(safeNum(p.support,0),0,1),
        ready:!!p.ready
      };
    })(),
    movementPredictor:(()=>{
      const p=x.movementPredictor&&typeof x.movementPredictor==='object'?x.movementPredictor:{};
      return {
        samples:Math.max(0,Math.floor(safeNum(p.samples,0))),
        logLossEWMA:clamp(safeNum(p.logLossEWMA,MOVE_BASE_LOGLOSS),.01,12),
        brierEWMA:clamp(safeNum(p.brierEWMA,MOVE_BASE_BRIER),0,1),
        directionHitEWMA:clamp(safeNum(p.directionHitEWMA,1/3),0,1),
        maeUnitsEWMA:Math.max(0,safeNum(p.maeUnitsEWMA,6)),
        direction:String(p.direction||'UNKNOWN'),
        directionProbability:clamp(safeNum(p.directionProbability,0),0,1),
        expectedUnits:safeNum(p.expectedUnits,0),
        reversalProbability:clamp(safeNum(p.reversalProbability,0),0,1),
        continuationProbability:clamp(safeNum(p.continuationProbability,0),0,1),
        support:clamp(safeNum(p.support,0),0,1),
        phase:String(p.phase||'UNKNOWN'),
        ready:!!p.ready
      };
    })()
  };
}
function cloudMasterFresh(){
  return !!cloudMaster.version && Date.now()-safeNum(cloudMaster.receivedAt,0)<60000;
}
function brainDriftActive(){
  return cloudMasterFresh()?!!cloudMaster.drift?.active:!!mem.drift?.active;
}
function brainPrequential(){
  if(cloudMasterFresh()&&safeNum(cloudMaster.prequential?.samples,0)>=60)return cloudMaster.prequential;
  return mem.prequential;
}
function renderMasterState(){
  const el=$('masterState');
  const study=$('sessionStudyState');
  if(!cloudMasterFresh()){
    if(el)el.textContent='LOCAL BACKUP';
    if(study)study.textContent='ESPERANDO MASTER';
    return;
  }
  if(el){
    const cal=cloudMaster.calibration||{};
    const bias=safeNum(cal.observedEWMA,UNIFORM)-safeNum(cal.predictedEWMA,UNIFORM);
    el.textContent=(cloudMaster.version||'MASTER')+' · R'+cloudMaster.revision+' · '+cloudMaster.cloudTicks+'T'+
      (safeNum(cal.samples,0)>100?(' · CAL '+(bias>0?'+':'')+(bias*100).toFixed(1)+'pp'):'');
  }
  if(study){
    const s=cloudMaster.sessionAnalytics||{};
    if(safeNum(s.matches,0)>0){
      study.textContent='MATCH 1-2 '+Math.round(clamp(safeNum(s.earlyMatchRate,0),0,1)*100)+'% · PROM #'+safeNum(s.avgMatchPosition,0).toFixed(1);
    }else{
      study.textContent='REUNIENDO SESIONES';
    }
  }
}

function normalizeShared(x){
  const base={accepted:0,wins:0,matches:0,matchRate:UNIFORM,byDigit:Array.from({length:10},()=>({n:0,matches:0})),contexts:{},updatedAt:0};
  if(!x||typeof x!=='object')return base;
  const out={...base,...x};
  out.accepted=Math.max(0,safeNum(out.accepted,0));
  out.wins=Math.max(0,safeNum(out.wins,0));
  out.matches=Math.max(0,safeNum(out.matches,0));
  out.matchRate=out.accepted?out.matches/out.accepted:UNIFORM;
  out.byDigit=Array.from({length:10},(_,d)=>{
    const n=x.byDigit?.[d]||{};
    return {n:Math.max(0,safeNum(n.n,0)),matches:Math.max(0,safeNum(n.matches,0))};
  });
  out.contexts=x.contexts&&typeof x.contexts==='object'?x.contexts:{};
  out.updatedAt=Math.max(0,safeNum(out.updatedAt,0));
  return out;
}

function sharedDistribution(){
  if(!sharedModel||sharedModel.accepted<1)return null;
  const ctx=hist.slice(-2).join('');
  const risks=Array(10).fill(UNIFORM);

  for(let d=0;d<10;d++){
    const g=sharedModel.byDigit[d]||{n:0,matches:0};
    const globalRisk=(safeNum(g.matches,0)+18*UNIFORM)/(safeNum(g.n,0)+18);
    const node=ctx?sharedModel.contexts[ctx+'>'+d]:null;
    if(node){
      const localRisk=(safeNum(node.matches,0)+28*globalRisk)/(safeNum(node.n,0)+28);
      const ev=1-Math.exp(-safeNum(node.n,0)/35);
      risks[d]=(1-ev)*globalRisk+ev*localRisk;
    }else{
      risks[d]=globalRisk;
    }
  }

  const sum=risks.reduce((a,b)=>a+b,0)||1;
  return {
    p:risks.map(x=>x/sum),
    support:clamp(1-Math.exp(-sharedModel.accepted/280),0,1)
  };
}
function contextKey(arr,endIndex,order){
  const start=endIndex-order+1;
  if(start<0)return null;
  return arr.slice(start,endIndex+1).join('');
}
function modelLossKey(h,o){return h+':'+o}
function learningRate(order,n){
  const base=order===1?.035:order===2?.050:.070;
  const support=Math.min(1,Math.max(0,n)/80);
  const driftBoost=brainDriftActive()?1.30:1;
  return clamp(base*(1-.25*support)*driftBoost,.012,.11);
}
function ensureNode(h,o,key){
  const bucket=mem.models[h][o];
  if(!bucket[key])bucket[key]={p:blankP(),n:0,last:mem.tickCount};
  return bucket[key];
}
function updateProb(p,target,alpha){
  for(let d=0;d<10;d++)p[d]=(1-alpha)*p[d]+alpha*(d===target?1:0);
  const sum=p.reduce((a,b)=>a+b,0)||1;
  for(let d=0;d<10;d++)p[d]/=sum;
}

function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0}
function std(xs){
  if(xs.length<2)return 0;
  const m=avg(xs);
  return Math.sqrt(avg(xs.map(x=>(x-m)*(x-m))));
}
function motionSnapshot(prices=priceHist){
  if(!Array.isArray(prices)||prices.length<8)return null;
  const p=prices.slice(-24).map(Number).filter(Number.isFinite);
  if(p.length<8)return null;
  const diffs=[];
  for(let i=1;i<p.length;i++)diffs.push(p[i]-p[i-1]);

  const scale=Math.max(1e-8,avg(diffs.slice(-12).map(Math.abs)));
  const slope=(n)=>{
    if(p.length<=n)return 0;
    return (p[p.length-1]-p[p.length-1-n])/(n*scale);
  };
  const s3=slope(3),s6=slope(6),s10=slope(Math.min(10,p.length-1));
  const velocity=.55*s3+.30*s6+.15*s10;
  const acceleration=s3-s6;
  const absV=Math.abs(velocity);
  const direction=velocity>.22?'UP':velocity<-.22?'DOWN':'FLAT';
  const strength=absV>.95?'STRONG':absV>.42?'MED':'WEAK';
  const accel=acceleration>.35?'ACCEL':acceleration<-.35?'DECEL':'STEADY';

  const recentDiffs=diffs.slice(-12);
  const volRatio=std(recentDiffs)/scale;
  const volatility=volRatio>1.25?'HIGH':volRatio<.72?'LOW':'MID';
  const signs=recentDiffs.slice(-5).map(x=>x>0?1:x<0?-1:0);
  const prior=signs.slice(0,-1).filter(Boolean);
  const last=signs[signs.length-1]||0;
  const majority=prior.length?Math.sign(prior.reduce((a,b)=>a+b,0)):0;
  const turn=last&&majority&&last!==majority?'TURN':'FLOW';

  // Micro-movimiento en unidades del último decimal visible del quote.
  const pip=Math.max(0,Math.min(8,Math.floor(safeNum(marketPip,4))));
  const unit=Math.pow(10,-pip);
  const lastMoveUnits=Math.round((p[p.length-1]-p[p.length-2])/unit);
  const moves3=diffs.slice(-3).map(x=>Math.round(x/unit));
  const mean3=avg(moves3);
  const absUnits=Math.abs(lastMoveUnits);
  const microForce=absUnits<=1?'TINY':absUnits<=3?'SMALL':absUnits<=8?'MED':absUnits<=20?'LARGE':'JUMP';
  const microDir=lastMoveUnits>0?'UP':lastMoveUnits<0?'DOWN':'FLAT';
  const residue=((lastMoveUnits%10)+10)%10;
  const trendUnits=Math.round(mean3);
  const trendBand=trendUnits>=5?'UPFAST':trendUnits>=1?'UPSLOW':trendUnits<=-5?'DOWNFAST':trendUnits<=-1?'DOWNSLOW':'STABLE';
  const quoteText=p[p.length-1].toFixed(pip);
  const currentDigit=Number(quoteText[quoteText.length-1]);
  const microKey=[currentDigit,microDir,microForce,'R'+residue,trendBand].join('|');

  return {
    direction,strength,accel,volatility,turn,
    velocity,acceleration,volRatio,
    currentDigit,lastMoveUnits,microForce,microDir,residue,trendUnits,trendBand,microKey,
    key:[direction,strength,accel,volatility,turn].join('|')
  };
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
      const alpha=entry.base*(brainDriftActive()?1.20:1);
      updateProb(node.p,targetDigit,clamp(alpha*(1-Math.min(.35,node.n/900)),.012,.055));
      node.n++;
      node.last=mem.tickCount;
    });
  }
}
function motionDistribution(h){
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
    const node=mem.motionModels[h]?.[entry.key];
    if(!node)return;
    const support=1-Math.exp(-safeNum(node.n,0)/entry.need);
    const w=entry.base*support;
    if(w<=.01)return;
    for(let d=0;d<10;d++){num[d]+=safeNum(node.p[d],UNIFORM)*w;den[d]+=w}
    evidence+=support;totalN+=safeNum(node.n,0);
  });
  if(totalN<1)return null;
  return {
    p:normalizeDist(num.map((x,d)=>x/(den[d]||1))),
    support:clamp(evidence/keys.length,0,1),
    n:totalN,
    state:snap
  };
}

function marketPhaseFromMotion(s){
  if(!s)return 'UNKNOWN';
  const dir=s.direction,micro=s.microDir,turn=s.turn;
  const v=Math.abs(safeNum(s.velocity,0));
  const a=safeNum(s.acceleration,0);

  if(turn==='TURN'&&micro==='UP')return 'TURN_UP';
  if(turn==='TURN'&&micro==='DOWN')return 'TURN_DOWN';
  if(dir==='FLAT'||(v<.28&&Math.abs(safeNum(s.trendUnits,0))<=1))return 'RANGE';

  if(dir==='UP'&&micro==='DOWN')return 'PULLBACK_DOWN';
  if(dir==='DOWN'&&micro==='UP')return 'PULLBACK_UP';

  if(dir==='UP'&&a<-.20)return 'EXHAUST_UP';
  if(dir==='DOWN'&&a>.20)return 'EXHAUST_DOWN';

  if(dir==='UP'&&(s.strength==='STRONG'||a>.35||s.trendBand==='UPFAST'))return 'IMPULSE_UP';
  if(dir==='DOWN'&&(s.strength==='STRONG'||a<-.35||s.trendBand==='DOWNFAST'))return 'IMPULSE_DOWN';

  if(dir==='UP')return 'CONTINUE_UP';
  if(dir==='DOWN')return 'CONTINUE_DOWN';
  return 'RANGE';
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
      const alpha=entry.base*(brainDriftActive()?1.18:1);
      updateProb(node.p,targetDigit,clamp(alpha*(1-Math.min(.35,node.n/1000)),.010,.058));
      node.n++;
      node.last=mem.tickCount;
    });
  }
}
function phaseDistribution(h){
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
    const node=mem.phaseModels[h]?.[entry.key];
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
      const alpha=.032*(brainDriftActive()?1.18:1);
      updateCategorical(node.p,bucketIndex,clamp(alpha*(1-Math.min(.35,node.n/1400)),.008,.045),MOVE_BUCKETS.length);
      node.n++;
      node.last=mem.tickCount;
    });
    const stats=mem.movementBucketStats[h][bucketIndex];
    stats.n++;
    stats.sum+=units;
    [
      {key:'B:'+bucketIndex,alpha:.022},
      {key:'BD:'+bucketIndex+'>D'+sourceDigit,alpha:.032}
    ].forEach(entry=>{
      const node=ensureMoveDigitNode(h,entry.key);
      updateProb(node.p,targetDigit,clamp(entry.alpha*(1-Math.min(.35,node.n/1500)),.008,.040));
      node.n++;
      node.last=mem.tickCount;
    });
  }
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
    cond=weight>0?normalizeDist(cond.map(x=>x/weight)):blankP();
    for(let d=0;d<10;d++)digitP[d]+=moveP[b]*cond[d];
  }
  const projectedDigits=normalizeDist(digitP);
  const means=mem.movementBucketStats[h].map((st,b)=>safeNum(st.n,0)>=20?safeNum(st.sum,0)/st.n:MOVE_CENTERS[b]);
  const expectedUnits=moveP.reduce((sum,p,b)=>sum+p*means[b],0);
  const down=moveP[0]+moveP[1]+moveP[2],flat=moveP[3],up=moveP[4]+moveP[5]+moveP[6];
  const dirs=[{name:'DOWN',p:down},{name:'FLAT',p:flat},{name:'UP',p:up}].sort((a,b)=>b.p-a.p);
  const reversal=snap.direction==='UP'?down:snap.direction==='DOWN'?up:Math.max(up,down);
  const continuation=snap.direction==='UP'?up:snap.direction==='DOWN'?down:flat;
  const localPerf=mem.movementPerf[h]||freshMovePerf();
  const masterMove=(h===1&&cloudMasterFresh())?cloudMaster.movementPredictor:null;
  const perf=masterMove&&safeNum(masterMove.samples,0)>safeNum(localPerf.samples,0)?masterMove:localPerf;
  const localDigitPerf=mem.expertPerf?.futureMove||{};
  const masterDigitPerf=cloudMasterFresh()?cloudMaster.expertPerformance?.futureMove:null;
  const digitPerf=masterDigitPerf&&safeNum(masterDigitPerf.samples,0)>safeNum(localDigitPerf.samples,0)?masterDigitPerf:localDigitPerf;
  const ready=masterMove?.ready===true || (
    safeNum(perf.samples,0)>=1500 &&
    safeNum(perf.logLossEWMA,MOVE_BASE_LOGLOSS)<=MOVE_BASE_LOGLOSS-.010 &&
    safeNum(perf.brierEWMA,MOVE_BASE_BRIER)<=MOVE_BASE_BRIER-.0008 &&
    safeNum(perf.directionHitEWMA,1/3)>=.39 &&
    safeNum(digitPerf.samples,0)>=1200 &&
    safeNum(digitPerf.matchEWMA,UNIFORM)<=.096 &&
    safeNum(digitPerf.logLossEWMA,BASELINE_LOGLOSS)<=BASELINE_LOGLOSS-.003
  );
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
    movementQueue.push({due:counter+h,h,sourcePrice:Number(priceHist[priceHist.length-1]),moveP:f.moveP.slice(),expectedUnits:f.expectedUnits});
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
      if(coverage>=.42&&(score>best.score||(score===best.score&&width<best.width))){
        best={low,high,coverage,width,score};
      }
    }
  }
  return {low:best.low,high:best.high,coverage:best.coverage,width:best.width};
}
function rangeSnapshotAt(prices,endIndex,digits=hist,motionState=null){
  if(!Array.isArray(prices)||endIndex<7)return null;
  const p=prices.slice(Math.max(0,endIndex-15),endIndex+1).map(Number).filter(Number.isFinite);
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
  return {
    low,high,last,widthUnits,compression,lateralScore,position,
    compressionBand,widthBand,positionBand,lateralBand,corridor,
    phase:marketPhaseFromMotion(motion),
    volatility:motion?.volatility||'MID',
    trendBand:motion?.trendBand||'STABLE',
    toleranceUnits:Math.max(1,Math.round(widthUnits*.12))
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
    keys.push({key:'RC:'+snap.lateralBand+'|DG'+snap.corridor.low+'-'+snap.corridor.high+'|C'+snap.compressionBand,need:34,base:1.18});
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
      const alpha=clamp(.030*(brainDriftActive()?1.15:1)*(1-Math.min(.35,node.n/1400)),.008,.042);
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
    const sp=normalizeRangeState(node.state),dp=normalizeDist(node.p);
    for(let i=0;i<3;i++){stateNum[i]+=sp[i]*w;stateDen[i]+=w}
    for(let d=0;d<10;d++){digitNum[d]+=dp[d]*w;digitDen[d]+=w}
    supportSum+=support;totalN+=safeNum(node.n,0);keyCount++;
  });
  const stateP=keyCount?normalizeRangeState(stateNum.map((x,i)=>x/(stateDen[i]||1))):[.50,.25,.25];
  const digitP=keyCount?normalizeDist(digitNum.map((x,d)=>x/(digitDen[d]||1))):blankP();
  const localPerf=mem.rangePerf[h]||freshRangePerf();
  const masterPerf=(h===1&&cloudMasterFresh())?cloudMaster.rangePredictor:null;
  const perf=masterPerf&&safeNum(masterPerf.samples,0)>safeNum(localPerf.samples,0)?masterPerf:localPerf;
  const localDigit=mem.expertPerf?.range||{};
  const masterDigit=cloudMasterFresh()?cloudMaster.expertPerformance?.range:null;
  const digitPerf=masterDigit&&safeNum(masterDigit.samples,0)>safeNum(localDigit.samples,0)?masterDigit:localDigit;
  const activeRange=snap.phase==='RANGE'||snap.lateralScore>=.56;
  // Range puede estudiar desde el primer tick, pero no influye en compras
  // hasta demostrar utilidad FUERA de muestra con margen real sobre 10%.
  const ready=(masterPerf?.ready===true&&
      safeNum(masterPerf.samples,0)>=1200&&
      safeNum(masterPerf.accuracyEWMA,1/3)>=.42) || (
    activeRange &&
    safeNum(perf.samples,0)>=1200 &&
    safeNum(perf.logLossEWMA,RANGE_BASE_LOGLOSS)<=RANGE_BASE_LOGLOSS-.008 &&
    safeNum(perf.brierEWMA,RANGE_BASE_BRIER)<=RANGE_BASE_BRIER-.004 &&
    safeNum(perf.accuracyEWMA,1/3)>=.42 &&
    safeNum(digitPerf.samples,0)>=1200 &&
    safeNum(digitPerf.matchEWMA,UNIFORM)<=.0975 &&
    safeNum(digitPerf.logLossEWMA,BASELINE_LOGLOSS)<=BASELINE_LOGLOSS-.002
  );
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
    rangeQueue.push({due:counter+h,h,stateP:f.stateP.slice(),low:f.low,high:f.high,toleranceUnits:Math.max(1,Math.round(f.widthUnits*.12))});
  }
  if(rangeQueue.length>30)rangeQueue=rangeQueue.slice(-30);
}
function resolveRangeForecasts(targetPrice,counter){
  if(!rangeQueue.length||!Number.isFinite(Number(targetPrice)))return;
  const due=[],keep=[];
  rangeQueue.forEach(x=>(x.due<=counter?due:keep).push(x));
  rangeQueue=keep.slice(-30);
  due.forEach(item=>{
    const actual=rangeOutcomeIndex({low:item.low,high:item.high,toleranceUnits:item.toleranceUnits},targetPrice);
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

// Aprende P(dígito futuro | contexto actual) para horizontes 1, 2 y 3 ticks.
function learnDigit(targetDigit,sourceHist){
  if(sourceHist.length){
    updateProb(mem.globalP,targetDigit,.018);
    mem.globalN++;
  }

  for(const h of HORIZONS){
    const signalEnd=sourceHist.length-h;
    if(signalEnd<0)continue;
    for(const o of ORDERS){
      const key=contextKey(sourceHist,signalEnd,o);
      if(key===null)continue;
      const node=ensureNode(h,o,key);
      const before=clamp(node.p[targetDigit]||UNIFORM,.0001,.9999);
      const loss=-Math.log(before);
      const lk=modelLossKey(h,o);
      mem.modelLoss[lk]=Number.isFinite(mem.modelLoss[lk]) ? .985*mem.modelLoss[lk]+.015*loss : loss;
      updateProb(node.p,targetDigit,learningRate(o,node.n));
      node.n++;
      node.last=mem.tickCount;
    }
  }
  learnMotion(targetDigit,sourceHist);
  learnPhase(targetDigit,sourceHist);
  mem.tickCount++;
}

function pruneModels(aggressive=false){
  const limits=aggressive?{1:10,2:100,3:550}:{1:10,2:100,3:900};
  HORIZONS.forEach(h=>ORDERS.forEach(o=>{
    const bucket=mem.models[h][o];
    const keys=Object.keys(bucket);
    const limit=limits[o];
    if(keys.length<=limit)return;
    keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
    keys.slice(limit).forEach(k=>delete bucket[k]);
  }));
  HORIZONS.forEach(h=>{
    const bucket=mem.motionModels[h]||{};
    const keys=Object.keys(bucket);
    const limit=aggressive?950:1900;
    if(keys.length>limit){
      keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
      keys.slice(limit).forEach(k=>delete bucket[k]);
    }
  });
  HORIZONS.forEach(h=>{
    const bucket=mem.phaseModels[h]||{};
    const keys=Object.keys(bucket);
    const limit=aggressive?700:1500;
    if(keys.length>limit){
      keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
      keys.slice(limit).forEach(k=>delete bucket[k]);
    }
  });
  HORIZONS.forEach(h=>{
    const bucket=mem.rangeModels[h]||{};
    const keys=Object.keys(bucket);
    const limit=aggressive?750:1500;
    if(keys.length>limit){
      keys.sort((a,b)=>(bucket[b].last||0)-(bucket[a].last||0));
      keys.slice(limit).forEach(k=>delete bucket[k]);
    }
  });
  HORIZONS.forEach(h=>{
    const move=mem.movementModels[h]||{};
    const mk=Object.keys(move),ml=aggressive?800:1700;
    if(mk.length>ml){
      mk.sort((a,b)=>(move[b].last||0)-(move[a].last||0));
      mk.slice(ml).forEach(k=>delete move[k]);
    }
    const digit=mem.moveDigitModels[h]||{};
    const dk=Object.keys(digit);
    if(dk.length>120){
      dk.sort((a,b)=>(digit[b].last||0)-(digit[a].last||0));
      dk.slice(120).forEach(k=>delete digit[k]);
    }
  });
}

function horizonNow(){return clamp(Math.round(safeNum(mem.delayEWMA,1)),1,3)}

function normalizeDist(p){
  const out=Array.from({length:10},(_,i)=>Math.max(.000001,safeNum(p?.[i],UNIFORM)));
  const sum=out.reduce((a,b)=>a+b,0)||1;
  return out.map(x=>x/sum);
}
function expertWeight(name){
  const p=mem.expertPerf?.[name];
  let w=clamp(safeNum(p?.weight,1),.35,2.8);
  if(cloudMasterFresh()&&Number.isFinite(Number(cloudMaster.expertWeights?.[name]))){
    w=clamp(Number(cloudMaster.expertWeights[name]),.25,3.2);
  }
  if(brainDriftActive()){
    if(name==='recent')w*=1.35;
    else if(name==='ctx1')w*=1.15;
    else if(name==='ctx3')w*=.82;
    else if(name==='global')w*=.78;
    else if(name==='phase')w*=1.10;
    else if(name==='futureMove')w*=1.12;
    else if(name==='range')w*=1.10;
    else if(name==='collab')w*=.92;
  }
  return clamp(w,.25,3.2);
}
function brierScore(p,target){
  let s=0;
  for(let d=0;d<10;d++){
    const y=d===target?1:0,err=safeNum(p?.[d],UNIFORM)-y;
    s+=err*err;
  }
  return s/10;
}
function updateExpertPerformance(name,p,target){
  if(!EXPERTS.includes(name)||!Array.isArray(p)||p.length!==10)return;
  const perf=mem.expertPerf[name]||(mem.expertPerf[name]={samples:0,logLossEWMA:BASELINE_LOGLOSS,skillEWMA:0,weight:1});
  const prob=clamp(safeNum(p[target],UNIFORM),.0001,.9999);
  const loss=-Math.log(prob);
  const skill=BASELINE_LOGLOSS-loss;
  perf.samples++;
  perf.logLossEWMA=.97*safeNum(perf.logLossEWMA,BASELINE_LOGLOSS)+.03*loss;
  perf.skillEWMA=.96*safeNum(perf.skillEWMA,0)+.04*skill;
  perf.weight=clamp(Math.exp(clamp(perf.skillEWMA,-.75,.75)*1.25),.35,2.8);
}
function updateDrift(score){
  const d=mem.drift;
  d.samples++;
  d.fast=.86*safeNum(d.fast,BASELINE_BRIER)+.14*score;
  d.slow=.985*safeNum(d.slow,BASELINE_BRIER)+.015*score;
  if(d.remaining>0)d.remaining--;
  if(d.samples>=45 && d.fast>d.slow+.0105 && d.remaining===0){
    d.events++;
    d.active=true;
    d.remaining=70;
    d.lastAt=Date.now();
    log('IA · cambio de régimen detectado: priorizo memoria reciente y aumento cautela');
  }else if(d.remaining===0 && d.fast<=d.slow+.004){
    d.active=false;
  }else if(d.remaining===0){
    d.active=false;
  }
}
function contextSignature(arr=hist){
  return arr.slice(-3).join('');
}
function streakBucket(n){
  n=Math.max(0,Math.floor(safeNum(n,0)));
  if(n<=2)return '0-2';
  if(n<=5)return '3-5';
  if(n<=8)return '6-8';
  if(n<=11)return '9-11';
  return '12+';
}
function updateStreakStats(streakBefore,loss){
  const key=streakBucket(streakBefore);
  const st=mem.streakStats[key]||(mem.streakStats[key]={n:0,matches:0});
  st.n++;
  if(loss)st.matches++;
}
function streakRiskInfo(streak=session.streak){
  const key=streakBucket(streak);
  let source=mem.streakStats||{};
  if(cloudMasterFresh()&&cloudMaster.streakStats){
    const cloudN=Object.values(cloudMaster.streakStats).reduce((s,x)=>s+safeNum(x?.n,0),0);
    if(cloudN>=20)source=cloudMaster.streakStats;
  }
  const st=source?.[key]||{n:0,matches:0};
  let totalN=0,totalM=0;
  Object.values(source||{}).forEach(x=>{totalN+=safeNum(x.n,0);totalM+=safeNum(x.matches,0)});
  const baseline=(totalM+45*UNIFORM)/(totalN+45);
  const local=(safeNum(st.matches,0)+30*baseline)/(safeNum(st.n,0)+30);
  const evidence=clamp(1-Math.exp(-safeNum(st.n,0)/24),0,1);
  const excess=clamp(local-baseline,0,.08);
  const active=safeNum(st.n,0)>=14 && excess>.012;
  const edgePenalty=active?clamp(excess*evidence*.16,0,.0028):0;
  const qualityPenalty=active?clamp(excess*evidence*.75,0,.025):0;
  return {key,n:safeNum(st.n,0),matches:safeNum(st.matches,0),baseline,rate:local,evidence,excess,active,edgePenalty,qualityPenalty,streak:Math.max(0,Math.floor(safeNum(streak,0)))};
}
function digitCalibratedRisk(d,risk){
  const raw=clamp(safeNum(risk,UNIFORM),.005,.30);
  let st=mem.digitCalibration?.[d];
  const cloudSt=cloudMasterFresh()?cloudMaster.digitCalibration?.[d]:null;
  if(cloudSt&&safeNum(cloudSt.n,0)>=20)st=cloudSt;
  if(!st||safeNum(st.n,0)<20)return raw;
  const predAvg=safeNum(st.predictedSum,0)/Math.max(1,safeNum(st.n,0));
  const observed=(safeNum(st.matches,0)+18*UNIFORM)/(safeNum(st.n,0)+18);
  const bias=clamp(observed-predAvg,-.018,.028);
  const evidence=1-Math.exp(-safeNum(st.n,0)/90);
  return clamp(raw+bias*evidence,Math.max(.005,raw*.72),Math.min(.30,raw*1.38));
}
function contextErrorPenalty(d){
  const ctx=contextSignature();
  if(!ctx)return 0;
  const source=(cloudMasterFresh()&&cloudMaster.counterfactualTicks>=30)?cloudMaster.errorContexts:mem.errorContexts;
  if(!Array.isArray(source))return 0;
  const now=Date.now();
  let score=0;
  for(const x of source){
    if(x.digit!==d||x.ctx!==ctx)continue;
    const ageDays=(now-safeNum(x.ts,now))/86400000;
    score+=Math.exp(-Math.max(0,ageDays)/3);
  }
  return clamp(score*.0014,0,.007);
}
function rankRiskAdjustment(rank){
  let st=mem.rankStats?.[rank];
  const cloudSt=cloudMasterFresh()?cloudMaster.rankStats?.[rank]:null;
  if(cloudSt&&safeNum(cloudSt.n,0)>=35)st=cloudSt;
  if(!st||safeNum(st.n,0)<35)return 0;
  const observed=(safeNum(st.matches,0)+22*UNIFORM)/(safeNum(st.n,0)+22);
  const evidence=clamp(1-Math.exp(-safeNum(st.n,0)/90),0,1);
  const delta=clamp(observed-UNIFORM,-.035,.055);
  return clamp(delta*evidence*.34,-.006,.012);
}
function recordPredictionOutcome(item,target){
  const probs=normalizeDist(Array.isArray(item?.p)?item.p:blankP());

  // Aprendizaje contrafactual completo: en cada tick sabemos el resultado de los 10 DIGITDIFF.
  for(let d=0;d<10;d++){
    const st=mem.digitCalibration[d];
    st.n++;
    if(target===d)st.matches++;
    st.predictedSum+=clamp(safeNum(probs[d],UNIFORM),0,.5);
  }

  // Aprende si el puesto #1, #2, #3... del ranking bruto realmente evita MATCH.
  if(Array.isArray(item?.ranking)&&item.ranking.length===10){
    item.ranking.forEach((digit,rank)=>{
      if(!Number.isInteger(digit)||digit<0||digit>9)return;
      const st=mem.rankStats[rank]||(mem.rankStats[rank]={n:0,matches:0});
      st.n++;
      if(target===digit)st.matches++;
    });
  }

  // El dígito que realmente salió se guarda como contexto peligroso aunque no hubiera sido elegido.
  if(Number.isInteger(target)&&target>=0&&target<=9){
    mem.errorContexts.push({
      ctx:String(item?.context||''),
      digit:target,
      ts:Date.now(),
      risk:clamp(safeNum(probs[target],UNIFORM),0,.5),
      confidence:clamp(safeNum(item?.confidence,0),0,1)
    });
    if(mem.errorContexts.length>100)mem.errorContexts.shift();
  }
}
function resolvePredictionQueue(target,counter){
  if(!predictionQueue.length)return;
  const due=[],keep=[];
  predictionQueue.forEach(item=>(item.due<=counter?due:keep).push(item));
  predictionQueue=keep.slice(-18);
  due.forEach(item=>{
    const p=normalizeDist(item.p);
    const prob=clamp(p[target],.0001,.9999);
    const logLoss=-Math.log(prob);
    const brier=brierScore(p,target);
    mem.prequential.samples++;
    mem.prequential.brierEWMA=.97*safeNum(mem.prequential.brierEWMA,BASELINE_BRIER)+.03*brier;
    mem.prequential.logLossEWMA=.97*safeNum(mem.prequential.logLossEWMA,BASELINE_LOGLOSS)+.03*logLoss;
    (item.experts||[]).forEach(v=>updateExpertPerformance(v.name,v.p,target));
    recordPredictionOutcome(item,target);
    updateDrift(brier);
  });
}
function schedulePrediction(decision,counter){
  if(!decision||!Array.isArray(decision.p))return;
  predictionQueue.push({
    due:counter+clamp(Math.round(safeNum(decision.h,1)),1,3),
    p:decision.p.slice(),
    digit:decision.best?.d,
    risk:decision.best?.risk,
    confidence:decision.confidence,
    context:contextSignature(),
    ranking:Array.isArray(decision.counterfactualRanking)?decision.counterfactualRanking.slice(0,10):[],
    experts:(()=>{
      const xs=(decision.expertViews||[]).map(v=>({name:v.name,p:Array.isArray(v.p)?v.p.slice():blankP()}));
      if(decision.motionEval && !xs.some(v=>v.name==='motion')){
        xs.push({name:'motion',p:Array.isArray(decision.motionEval.p)?decision.motionEval.p.slice():blankP()});
      }
      if(decision.phaseEval && !xs.some(v=>v.name==='phase')){
        xs.push({name:'phase',p:Array.isArray(decision.phaseEval.p)?decision.phaseEval.p.slice():blankP()});
      }
      if(decision.futureMoveEval && !xs.some(v=>v.name==='futureMove')){
        xs.push({name:'futureMove',p:Array.isArray(decision.futureMoveEval.p)?decision.futureMoveEval.p.slice():blankP()});
      }
      if(decision.rangeEval && !xs.some(v=>v.name==='range')){
        xs.push({name:'range',p:Array.isArray(decision.rangeEval.p)?decision.rangeEval.p.slice():blankP()});
      }
      return xs;
    })()
  });
  if(predictionQueue.length>18)predictionQueue=predictionQueue.slice(-18);
}

function weightedRiskQuantile(items,q){
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
function committeeForCandidate(views,digit){
  const items=[];
  for(const v of views){
    const w=Math.max(.001,safeNum(v?.w,0));
    if(w<=.005||!Array.isArray(v?.p)||v.p.length!==10)continue;
    items.push({
      value:clamp(safeNum(v.p[digit],UNIFORM),.001,.40),
      weight:w,
      name:String(v.name||'model')
    });
  }
  if(!items.length)return {consensus:0,robustRisk:.30,dangerShare:1,spread:.30,models:0};
  const total=items.reduce((s,x)=>s+x.weight,0)||1;
  const safeWeight=items.reduce((s,x)=>s+(x.value<=UNIFORM?x.weight:0),0);
  const dangerWeight=items.reduce((s,x)=>s+(x.value>=.115?x.weight:0),0);
  const meanRisk=items.reduce((s,x)=>s+x.value*x.weight,0)/total;
  const variance=items.reduce((s,x)=>s+x.weight*(x.value-meanRisk)*(x.value-meanRisk),0)/total;
  return {
    consensus:clamp(safeWeight/total,0,1),
    robustRisk:weightedRiskQuantile(items,.75),
    dangerShare:clamp(dangerWeight/total,0,1),
    spread:Math.sqrt(Math.max(0,variance)),
    models:items.length
  };
}

function predict(){
  if(hist.length<8)return null;
  const h=horizonNow();
  const dist=Array(10).fill(0);
  const denom=Array(10).fill(0);
  const modelViews=[];

  // Base global.
  const gw=.45*expertWeight('global');
  for(let d=0;d<10;d++){dist[d]+=mem.globalP[d]*gw;denom[d]+=gw}
  modelViews.push({name:'global',p:mem.globalP.slice(),w:gw,n:mem.globalN});

  // Contextos de dígitos 1/2/3.
  for(const o of ORDERS){
    const key=contextKey(hist,hist.length-1,o);
    if(key===null)continue;
    const node=mem.models[h][o][key];
    if(!node)continue;
    const err=safeNum(mem.modelLoss[modelLossKey(h,o)],Math.log(10));
    const reliability=1/(.35+err);
    const support=1-Math.exp(-node.n/(o===1?24:o===2?15:9));
    const w=reliability*support*(o===1?.8:o===2?1.05:1.20)*expertWeight('ctx'+o);
    if(w<=.01)continue;
    for(let d=0;d<10;d++){dist[d]+=node.p[d]*w;denom[d]+=w}
    modelViews.push({name:'ctx'+o,p:node.p.slice(),w,n:node.n});
  }

  // Frecuencia reciente.
  const recent=hist.slice(-50),counts=Array(10).fill(1.2);
  recent.forEach(d=>counts[d]++);
  const total=counts.reduce((a,b)=>a+b,0);
  const rp=counts.map(x=>x/total),rw=.28*expertWeight('recent');
  for(let d=0;d<10;d++){dist[d]+=rp[d]*rw;denom[d]+=rw}
  modelViews.push({name:'recent',p:rp,w:rw,n:recent.length});

  // Movimiento: aprende siempre, solo influye cuando ya demostró utilidad.
  const motion=motionDistribution(h);
  const localMotionPerf=mem.expertPerf?.motion||{samples:0,skillEWMA:0,weight:1};
  const masterMotionPerf=cloudMasterFresh()?cloudMaster.expertPerformance?.motion:null;
  const motionMature=!!motion &&
    safeNum(motion.n,0)>=180 &&
    (masterMotionPerf
      ?(safeNum(masterMotionPerf.samples,0)>=120 && safeNum(masterMotionPerf.matchEWMA,UNIFORM)<UNIFORM)
      :(safeNum(localMotionPerf.samples,0)>=120 && safeNum(localMotionPerf.skillEWMA,0)>.005));
  if(motionMature){
    const motionSamples=masterMotionPerf?safeNum(masterMotionPerf.samples,0):safeNum(localMotionPerf.samples,0);
    const maturity=clamp((motionSamples-120)/500,0,1);
    const mw=(.10+.20*maturity)*motion.support*expertWeight('motion');
    if(mw>.01){
      for(let d=0;d<10;d++){dist[d]+=motion.p[d]*mw;denom[d]+=mw}
      modelViews.push({name:'motion',p:motion.p.slice(),w:mw,n:motion.n,state:motion.state});
    }
  }

  // Estructura de mercado: impulso / agotamiento / retroceso / giro / continuación / rango.
  const phase=phaseDistribution(h);
  const localPhasePerf=mem.expertPerf?.phase||{samples:0,skillEWMA:0,weight:1};
  const masterPhasePerf=cloudMasterFresh()?cloudMaster.expertPerformance?.phase:null;
  const phaseMature=!!phase &&
    safeNum(phase.n,0)>=900 &&
    (masterPhasePerf
      ?(safeNum(masterPhasePerf.samples,0)>=1200 && safeNum(masterPhasePerf.matchEWMA,UNIFORM)<=.0955 && safeNum(masterPhasePerf.logLossEWMA,BASELINE_LOGLOSS)<=BASELINE_LOGLOSS-.004)
      :(safeNum(localPhasePerf.samples,0)>=600 && safeNum(localPhasePerf.skillEWMA,0)>.012));
  if(phaseMature){
    const phaseSamples=masterPhasePerf?safeNum(masterPhasePerf.samples,0):safeNum(localPhasePerf.samples,0);
    const maturity=clamp((phaseSamples-600)/1800,0,1);
    const pw=(.06+.12*maturity)*phase.support*expertWeight('phase');
    if(pw>.01){
      for(let d=0;d<10;d++){dist[d]+=phase.p[d]*pw;denom[d]+=pw}
      modelViews.push({name:'phase',p:phase.p.slice(),w:pw,n:phase.n,phase:phase.phase,state:phase.state});
    }
  }

  // Predictor futuro en dos etapas: movimiento -> proyección de riesgo por dígito.
  const futureMove=movementForecast(h);
  if(futureMove?.ready){
    const samples=safeNum(futureMove.perf?.samples,0);
    const maturity=clamp((samples-1500)/3000,0,1);
    const fw=(.07+.16*maturity)*futureMove.support*expertWeight('futureMove');
    if(fw>.01){
      for(let d=0;d<10;d++){dist[d]+=futureMove.digitP[d]*fw;denom[d]+=fw}
      modelViews.push({name:'futureMove',p:futureMove.digitP.slice(),w:fw,n:futureMove.n,forecast:futureMove});
    }
  }

  // Range Intelligence: estima si la lateralización continuará, sus límites
  // y qué dígitos quedan más expuestos dentro de ese régimen.
  const range=rangeForecast(h);
  if(range?.ready&&range.activeRange){
    const samples=safeNum(range.perf?.samples,0);
    const maturity=clamp((samples-300)/1800,0,1);
    const persistence=clamp((safeNum(range.stayProbability,.5)-.40)/.45,0,1);
    // Incluso ya validado, Range entra con peso moderado: una capa nueva
    // nunca debe dominar a los expertos que ya estaban funcionando.
    const rw=(.04+.10*maturity)*(.70+.30*persistence)*range.support*expertWeight('range');
    if(rw>.01){
      for(let d=0;d<10;d++){dist[d]+=range.digitP[d]*rw;denom[d]+=rw}
      modelViews.push({name:'range',p:range.digitP.slice(),w:rw,n:range.n,forecast:range});
    }
  }

  // Cloud maestro freshness-matched: cuando coincide con el tick actual es el ancla principal.
  const cp=cloudLive.prediction;
  let cloudAnchor=null;
  if(cp && Number(cp.signalEpoch)===Number(lastEpoch) && Date.now()-safeNum(cp.generatedAt,0)<3500){
    const cpp=normalizeDist(cp.probabilities);
    const freshness=clamp(1-(Date.now()-cp.generatedAt)/3500,.35,1);
    const strength=clamp((.62+.18*clamp(safeNum(cp.confidence,0),0,1))*freshness,.35,.82);
    cloudAnchor={
      p:cpp,
      strength,
      calibratedRisks:Array.isArray(cp.calibratedRisks)&&cp.calibratedRisks.length===10
        ?cp.calibratedRisks.slice()
        :null
    };
    modelViews.push({name:'cloud',p:cpp,w:1.35*strength,n:safeNum(cloudMaster.prequential?.samples,mem.prequential.samples)});
  }

  const p=dist.map((x,d)=>x/(denom[d]||1));
  let sum=p.reduce((a,b)=>a+b,0)||1;
  for(let d=0;d<10;d++)p[d]/=sum;
  if(cloudAnchor){
    for(let d=0;d<10;d++)p[d]=(1-cloudAnchor.strength)*p[d]+cloudAnchor.strength*cloudAnchor.p[d];
    sum=p.reduce((a,b)=>a+b,0)||1;
    for(let d=0;d<10;d++)p[d]/=sum;
  }

  // Experiencias compartidas.
  const shared=sharedDistribution();
  if(shared&&shared.support>0){
    const w=clamp(.24*shared.support*expertWeight('collab'),0,.34);
    for(let d=0;d<10;d++)p[d]=(1-w)*p[d]+w*shared.p[d];
    sum=p.reduce((a,b)=>a+b,0)||1;
    for(let d=0;d<10;d++)p[d]/=sum;
    modelViews.push({name:'collab',p:shared.p.slice(),w,n:sharedModel.accepted});
  }

  const views=modelViews.filter(v=>Array.isArray(v.p)&&v.p.length===10);
  const wsum=views.reduce((s,v)=>s+Math.max(.01,safeNum(v.w,1)),0)||1;
  const contextNodes=modelViews.filter(v=>v.name.startsWith('ctx'));
  const support=contextNodes.length?contextNodes.reduce((s,v)=>s+Math.min(1,v.n/30),0)/contextNodes.length:0;
  const entropy=-p.reduce((s,x)=>s+(x>0?x*Math.log(x):0),0)/Math.log(10);
  const sharpness=clamp((1-entropy)/.075,0,1);
  const brainPreq=brainPrequential();
  const preqSamples=safeNum(brainPreq.samples,0);
  const brier=safeNum(brainPreq.brierEWMA,BASELINE_BRIER);
  const preqSkill=clamp((BASELINE_BRIER-brier)/.018,-1,1);
  const skillTrust=preqSamples<35?.72:clamp(.65+.35*Math.max(0,preqSkill),.58,1);
  const driftActive=brainDriftActive();
  const driftPenalty=driftActive?.78:1;
  const masterOnline=cloudMasterFresh();
  const calibrationPenalty=masterOnline?Math.max(0,brier-BASELINE_BRIER):Math.max(0,safeNum(mem.calibrationEWMA,0));
  const calibrationTrust=masterOnline
    ?clamp(1-calibrationPenalty*8,.45,1)
    :clamp(1-calibrationPenalty*4.5,.25,1);
  const recentLoss=masterOnline
    ?Math.max(0,safeNum(cloudMaster.shadowMatchRate,UNIFORM)-UNIFORM)
    :Math.max(0,safeNum(mem.lossEWMA,.10)-UNIFORM);
  const contextCoverage=clamp(contextNodes.length/3,0,1);
  const recoveryRatio=clamp(safeNum(mem.recovery?.remaining,0)/12,0,1);
  const streakInfo=streakRiskInfo(session.streak);
  const cloudCalBias=cloudMasterFresh()
    ?Math.max(0,safeNum(cloudMaster.calibration?.observedEWMA,UNIFORM)-safeNum(cloudMaster.calibration?.predictedEWMA,UNIFORM))
    :0;
  const health=clamp(
    1-recentLoss*3.3-calibrationPenalty*2.2-Math.max(0,brier-BASELINE_BRIER)*6-cloudCalBias*2.4-(driftActive?.10:0),
    0,1
  );

  // Cautela adaptativa: si aparecen varios MATCH recientes, no seguimos comprando
  // con el mismo umbral. Se vuelve temporalmente más exigente sin bloquear para siempre.
  const recentSettled=(mem.recentTrades||[]).slice(-6);
  const recentMatches=recentSettled.reduce((n,t)=>n+(t?.loss?1:0),0);
  const clusterGuard=recentMatches>=3?1:recentMatches>=2?.65:0;

  // Primero construimos un ranking bruto para poder aprender si el "#1" realmente es mejor.
  const recentPicks=mem.recentPicks.slice(-12);
  const exposure=Array(10).fill(0);recentPicks.forEach(d=>exposure[d]++);
  const maxExp=Math.max(1,...exposure);
  const preliminary=p.map((rawRisk,d)=>{
    const fixation=exposure[d]/maxExp;
    const localRisk=digitCalibratedRisk(d,rawRisk);
    const cloudRiskCal=Array.isArray(cloudAnchor?.calibratedRisks)
      ?safeNum(cloudAnchor.calibratedRisks[d],NaN)
      :NaN;
    // El riesgo no puede verse artificialmente bajo si el validador cloud
    // ya observó que esa probabilidad estaba subestimada.
    const risk=Number.isFinite(cloudRiskCal)
      ?Math.max(localRisk,cloudRiskCal)
      :localRisk;
    const errorPenalty=contextErrorPenalty(d);
    const baseAdjusted=risk+fixation*.0025+errorPenalty;
    return {d,risk,rawRisk,localRisk,cloudRiskCal,fixation,errorPenalty,baseAdjusted};
  }).sort((a,b)=>a.baseAdjusted-b.baseAdjusted||a.risk-b.risk);
  preliminary.forEach((x,i)=>x.rawRank=i);
  const counterfactualRanking=preliminary.map(x=>x.d);

  // El laboratorio cloud solo puede endurecer la entrada; nunca volverla más permisiva.
  const research=cloudMasterFresh()?cloudMaster.entryResearch:null;
  const researchProfile=research?.ready?research.profile:null;
  // El laboratorio solo gana autoridad en proporción a la cobertura que
  // realmente haya demostrado sobre datos futuros.
  const researchCoverage=clamp(safeNum(researchProfile?.coverage,0),0,1);
  const researchStrength=researchProfile
    ?clamp((researchCoverage-.05)/.25,0,1)
    :0;
  const learnedRiskCeiling=
    NORMAL_RISK_CEILING-
    researchStrength*(NORMAL_RISK_CEILING-safeNum(researchProfile?.riskCeiling,NORMAL_RISK_CEILING));

  // Protección especial contra MATCH temprano: las primeras dos operaciones
  // necesitan evidencia más robusta, no simplemente más tiempo de espera.
  // Protección por posición de sesión: el problema reportado se concentra
  // en MATCH tempranos. Las primeras entradas reciben un poco más de cautela,
  // sin bloquear toda la sesión.
  const earlyGuard=session.settled<=1?1:session.settled<7?.38:0;

  // El tiempo esperando NO vuelve más permisiva a la IA.
  // autoWaitTicks queda solo para diagnóstico visual, nunca para forzar una compra.
  const adaptivePatience=0;

  // Ahora la IA puntúa LOS 10 candidatos. Un primero malo no detiene la búsqueda.
  const candidates=preliminary.map(x=>{
    const mean=views.reduce((s,v)=>s+safeNum(v.p[x.d],x.risk)*Math.max(.01,safeNum(v.w,1)),0)/wsum;
    const variance=views.reduce((s,v)=>{
      const w=Math.max(.01,safeNum(v.w,1)),z=safeNum(v.p[x.d],x.risk);
      return s+w*(z-mean)*(z-mean);
    },0)/wsum;
    const disagreement=Math.sqrt(Math.max(0,variance));
    const stability=Math.exp(-disagreement*18);
    const confidence=clamp((.18+.82*support)*stability*calibrationTrust*(.72+.28*sharpness)*skillTrust*driftPenalty,0,1);
    const oodScore=clamp((1-support)*.48+(1-contextCoverage)*.18+Math.min(1,disagreement/.03)*.22+(driftActive?.12:0),0,1);
    const qualityScore=clamp(confidence*.43+health*.22+(1-oodScore)*.20+sharpness*.10+Math.max(0,preqSkill)*.05,0,1);
    const rankAdjustment=rankRiskAdjustment(x.rawRank);
    const effectiveRisk=clamp(x.baseAdjusted+rankAdjustment,.005,.30);
    const edge=UNIFORM-effectiveRisk;

    const riskValue=clamp((.11-effectiveRisk)/.04,0,1);
    const consensus=clamp(stability,0,1);
    const contextSafety=clamp(1-x.errorPenalty/.007,0,1);
    const exposureSafety=clamp(1-x.fixation,0,1);
    const rankTrust=clamp(1-Math.max(0,rankAdjustment)/.012,0,1);
    const score=clamp(
      riskValue*.44+
      confidence*.18+
      qualityScore*.14+
      consensus*.10+
      contextSafety*.07+
      exposureSafety*.04+
      rankTrust*.03,
      0,1
    );

    const committee=committeeForCandidate(views,x.d);
    const riskCeiling=clamp(
      learnedRiskCeiling-clusterGuard*.006-earlyGuard*.0025,
      .084,
      NORMAL_RISK_CEILING
    );

    // Umbrales fijos: la IA no baja su estándar solo porque haya esperado.
    // Queda un punto medio entre el modo excesivamente estricto y el modo
    // adaptativo que estaba aceptando entradas demasiado pronto.
    const minScore=
      .462+
      (driftActive?.035:0)+
      recoveryRatio*.030+
      streakInfo.qualityPenalty*.45+
      clusterGuard*.055+
      earlyGuard*.018;

    const researchMinConf=.22+researchStrength*(safeNum(researchProfile?.minConfidence,.22)-.22);
    const minConf=Math.max(
      researchMinConf,
      (driftActive?.27:.23)+recoveryRatio*.030+clusterGuard*.065+earlyGuard*.018
    );

    const researchMinConsensus=.54+researchStrength*(safeNum(researchProfile?.minConsensus,.54)-.54);
    const minConsensus=Math.max(
      researchMinConsensus,
      .54+clusterGuard*.05+earlyGuard*.040
    );

    const researchRobust=.118-researchStrength*(.118-safeNum(researchProfile?.robustCeiling,.118));
    const robustCeiling=Math.min(
      researchRobust,
      .114-clusterGuard*.005-earlyGuard*.003
    );
    const maxOod=.80-clusterGuard*.07-earlyGuard*.035;

    const movementRisk=futureMove?.ready&&Array.isArray(futureMove.digitP)
      ?safeNum(futureMove.digitP[x.d],UNIFORM)
      :null;
    const movementConflict=Number.isFinite(movementRisk)&&movementRisk>.115;

    const cloudRisk=cloudAnchor?safeNum(cloudAnchor.p[x.d],UNIFORM):null;
    const cloudConflict=Number.isFinite(cloudRisk)&&cloudRisk>.115;

    const expertVeto=committee.models>=4 && committee.dangerShare>.36;

    const usable=
      score>=minScore &&
      effectiveRisk<=riskCeiling &&
      edge>=UNIFORM-riskCeiling &&
      confidence>=minConf &&
      oodScore<maxOod &&
      committee.consensus>=minConsensus &&
      committee.robustRisk<=robustCeiling &&
      !expertVeto &&
      !movementConflict &&
      !cloudConflict

    return {
      ...x,
      disagreement,confidence,oodScore,qualityScore,rankAdjustment,
      effectiveRisk,edge,score,minScore,minConf,usable,
      committee,minConsensus,robustCeiling,movementRisk,cloudRisk,
      movementConflict,cloudConflict,expertVeto
    };
  // Para DIFFER el objetivo directo es NO coincidir con el próximo dígito.
  // Por eso, entre señales que ya pasaron los filtros, manda el menor riesgo
  // calibrado de MATCH. Score/consenso solo desempatan: nunca justifican
  // escoger un candidato con mayor riesgo estimado.
  }).sort((a,b)=>
    a.effectiveRisk-b.effectiveRisk ||
    safeNum(a.committee?.robustRisk,.30)-safeNum(b.committee?.robustRisk,.30) ||
    b.score-a.score
  );

  let selected=candidates.find(x=>x.usable)||candidates[0];
  const usableCount=candidates.filter(x=>x.usable).length;
  const second=candidates.find(x=>x.d!==selected.d)||candidates[1]||selected;

  // Solo PAUSA con deterioro severo; el resto se resuelve buscando entre los 10.
  let action='WAIT';
  let reason=`Revisé los 10 candidatos; ninguno alcanzó todavía el mínimo adaptable. Mejor actual D${selected.d} · score ${(selected.score*100).toFixed(0)}/100 · análisis ${autoWaitTicks}T.`;
  const severeInstability=(preqSamples>=80&&health<.20)||(preqSamples>=80&&brier>BASELINE_BRIER+.035);
  if(severeInstability){
    action='PAUSE';
    reason='PAUSA IA: deterioro severo del modelo. Sigo aprendiendo los 10 candidatos sin comprar.';
  }else if(usableCount>0){
    action='BUY';
    const skipped=Math.max(0,selected.rawRank);
    reason=`Compra D${selected.d}: score ${(selected.score*100).toFixed(0)}/100 · riesgo CAL ${fmtPct(selected.effectiveRisk)} · comité ${Math.round(selected.committee.consensus*100)}% · robusto ${fmtPct(selected.committee.robustRisk)} · revisé 10 candidatos${skipped?'; descarté '+skipped+' opción'+(skipped===1?'':'es')+' de menor riesgo bruto por peor contexto/consenso':''}.`;
  }else if(clusterGuard>0){
    reason=`CAUTELA ANTI-MATCH: detecté ${recentMatches} MATCH en las últimas ${recentSettled.length} operaciones; sigo analizando pero exijo más calidad antes de comprar.`;
  }else if(recoveryRatio>0){
    reason=`Revisé los 10 candidatos durante recuperación; D${selected.d} quedó más cerca con score ${(selected.score*100).toFixed(0)}/100.`;
  }else if(streakInfo.active){
    reason=`Revisé los 10 candidatos con racha de ${streakInfo.streak} wins; ninguno superó todavía el score mínimo adaptable.`;
  }

  // Compatibilidad con el resto del bot: best es ahora el candidato ELEGIDO por búsqueda completa.
  const best={
    d:selected.d,
    risk:selected.effectiveRisk,
    rawRisk:selected.rawRisk,
    adjusted:selected.effectiveRisk,
    errorPenalty:selected.errorPenalty,
    score:selected.score,
    rawRank:selected.rawRank
  };

  return {
    h,p,best,second,
    confidence:selected.confidence,
    edge:selected.edge,
    requiredEdge:Math.max(0,UNIFORM-clamp(learnedRiskCeiling-clusterGuard*.006-earlyGuard*.0025,.084,NORMAL_RISK_CEILING)),
    riskCeiling:clamp(learnedRiskCeiling-clusterGuard*.006-earlyGuard*.0025,.084,NORMAL_RISK_CEILING),
    clusterGuard,
    earlyGuard,
    adaptivePatience,
    waitTicks:autoWaitTicks,
    entryResearch:research?{
      ready:!!research.ready,
      recommended:String(research.recommended||'balanced'),
      resolved:safeNum(research.resolved,0),
      riskCeiling:safeNum(research.profile?.riskCeiling,NORMAL_RISK_CEILING),
      coverage:researchCoverage,
      strength:researchStrength
    }:null,
    recentMatches,
    health,
    qualityScore:selected.qualityScore,
    oodScore:selected.oodScore,
    action,reason,
    disagreement:selected.disagreement,
    entryCommittee:selected.committee,
    minConsensus:selected.minConsensus,
    robustCeiling:selected.robustCeiling,
    movementConflict:selected.movementConflict,
    cloudConflict:selected.cloudConflict,
    expertVeto:selected.expertVeto,
    support,entropy,sharpness,preqSkill,
    motion:motion?.state||null,
    motionSupport:motion?.support||0,
    motionMature,
    motionEval:motion?{p:motion.p.slice()}:null,
    phase:phase?.phase||marketPhaseFromMotion(motion?.state||motionSnapshot()),
    phaseSupport:phase?.support||0,
    phaseMature,
    phaseEval:phase?{p:phase.p.slice()}:null,
    futureMove:(()=>{
      const cf=cloudLive.prediction?.movementForecast;
      const cloudCurrent=cf && Number(cloudLive.prediction?.signalEpoch)===Number(lastEpoch) && Date.now()-safeNum(cloudLive.prediction?.generatedAt,0)<3500;
      return cloudCurrent?cf:futureMove;
    })(),
    futureMoveMature:!!futureMove?.ready,
    futureMoveEval:futureMove?{p:futureMove.digitP.slice()}:null,
    range,
    rangeMature:!!range?.ready,
    rangeEval:range?{p:range.digitP.slice()}:null,
    streakInfo,
    candidates,
    usableCount,
    counterfactualRanking,
    expertViews:views
  };
}
function renderDecision(d){
  lastDecision=d;
  if(!d){
    $('decision').textContent='APRENDIENDO';
    $('decision').className='decision stateWait';
    $('reason').textContent='Aún no hay contexto suficiente.';
    $('pick').textContent='—';$('risk').textContent='—';$('confidence').textContent='—';
    if($('candidateState'))$('candidateState').textContent='BUSCANDO 10/10';
    $('meter').style.width='0%';
    return;
  }
  $('pick').textContent='D'+d.best.d;
  $('risk').textContent=fmtPct(d.best.risk);
  $('confidence').textContent=fmtPct(d.confidence);
  $('horizon').textContent=d.h+'T';
  $('health').textContent=fmtPct(d.health);
  if($('quality'))$('quality').textContent=fmtPct(d.qualityScore);
  if($('contextState'))$('contextState').textContent=d.oodScore>.74?'NUEVO':d.oodScore>.52?'MIXTO':'CONOCIDO';
  if($('candidateState')){
    const sc=Math.round(clamp(safeNum(d.best?.score,0),0,1)*100);
    $('candidateState').textContent='D'+d.best.d+' · '+sc+'/100 · '+safeNum(d.usableCount,0)+'/10 OK';
  }
  if($('entryCommitteeState')){
    const ec=d.entryCommittee||{};
    $('entryCommitteeState').textContent=
      Math.round(clamp(safeNum(ec.consensus,0),0,1)*100)+'% ACUERDO · R '+fmtPct(safeNum(ec.robustRisk,.30));
  }
  if($('researchState')){
    const er=d.entryResearch;
    $('researchState').textContent=!er?'CLOUD APRENDE':
      (String(er.recommended||'balanced').toUpperCase()+' · '+Math.round(safeNum(er.resolved,0))+' TESTS'+
        (er.ready?' · PESO '+Math.round(clamp(safeNum(er.strength,0),0,1)*100)+'%':' · SHADOW'));
  }
  if($('motionState')){
    const m=d.motion;
    $('motionState').textContent=!m?'APRENDIENDO':(m.microDir==='UP'?'↑':m.microDir==='DOWN'?'↓':'↔')+' '+m.microForce+' · '+(m.lastMoveUnits>0?'+':'')+m.lastMoveUnits+'U'+(d.motionMature?' · ACTIVO':' · APRENDE');
  }
  if($('phaseState')){
    const labels={
      IMPULSE_UP:'IMPULSO ↑',IMPULSE_DOWN:'IMPULSO ↓',
      EXHAUST_UP:'AGOTAMIENTO ↑',EXHAUST_DOWN:'AGOTAMIENTO ↓',
      PULLBACK_UP:'RETROCESO ↑',PULLBACK_DOWN:'RETROCESO ↓',
      CONTINUE_UP:'CONTINÚA ↑',CONTINUE_DOWN:'CONTINÚA ↓',
      TURN_UP:'GIRO ↑',TURN_DOWN:'GIRO ↓',RANGE:'RANGO',UNKNOWN:'APRENDIENDO'
    };
    $('phaseState').textContent=(labels[d.phase]||d.phase||'APRENDIENDO')+(d.phaseMature?' · ACTIVO':' · APRENDE');
  }
  if($('rangeState')){
    const r=d.range;
    if(!r){
      $('rangeState').textContent='APRENDIENDO';
    }else{
      const stay=Math.round(clamp(safeNum(r.stayProbability,0),0,1)*100);
      const up=Math.round(clamp(safeNum(r.breakoutUpProbability,0),0,1)*100);
      const down=Math.round(clamp(safeNum(r.breakoutDownProbability,0),0,1)*100);
      const cor=r.digitCorridor;
      const corridor=cor&&safeNum(cor.coverage,0)>=.42?(' · D'+cor.low+'–D'+cor.high):'';
      const exp=Array.isArray(r.exposedDigits)&&r.exposedDigits.length
        ?' · EXP '+r.exposedDigits.map(x=>'D'+x.d).join(',')
        :'';
      $('rangeState').textContent=
        (r.activeRange?'LATERAL ':'NO LATERAL ')+stay+'% · ↑'+up+'% ↓'+down+'% · '+Math.round(safeNum(r.widthUnits,0))+'U'+corridor+exp+(r.ready?' · ACTIVO':' · SHADOW');
    }
  }
  if($('futureMoveState')){
    const f=d.futureMove;
    if(!f){
      $('futureMoveState').textContent='APRENDIENDO';
    }else{
      const arrow=f.direction==='UP'?'↑':f.direction==='DOWN'?'↓':'↔';
      const units=safeNum(f.expectedUnits,0);
      $('futureMoveState').textContent=(f.h||d.h)+'T '+arrow+' '+Math.round(clamp(safeNum(f.directionProbability,0),0,1)*100)+'% · '+(units>0?'+':'')+units.toFixed(1)+'U'+(f.ready?' · ACTIVO':' · SHADOW');
    }
  }
  if($('reversalState')){
    const f=d.futureMove;
    $('reversalState').textContent=!f?'APRENDIENDO':('GIRO '+Math.round(clamp(safeNum(f.reversalProbability,0),0,1)*100)+'% · CONT '+Math.round(clamp(safeNum(f.continuationProbability,0),0,1)*100)+'%');
  }
  if($('futureMoveSkill')){
    const f=d.futureMove,p=f?.perf||cloudMaster.movementPredictor||{};
    $('futureMoveSkill').textContent=safeNum(p.samples,0)>0?('HIT '+Math.round(clamp(safeNum(p.directionHitEWMA,0),0,1)*100)+'% · '+Math.round(safeNum(p.samples,0))+' TESTS'):'REUNIENDO DATOS';
  }
  $('meter').style.width=(d.confidence*100).toFixed(0)+'%';
  if(d.action==='BUY'){
    $('decision').textContent='COMPRAR DIFFER D'+d.best.d;
    $('decision').className='decision stateBuy';
  }else if(d.action==='PAUSE'){
    $('decision').textContent='PAUSA AUTOMÁTICA IA';
    $('decision').className='decision statePause';
  }else{
    $('decision').textContent='ESPERAR';
    $('decision').className='decision stateWait';
  }
  $('reason').textContent=d.reason;
  $('manualBuy').textContent='COMPRA MANUAL · D'+d.best.d+' · RIESGO '+fmtPct(d.best.risk);
}

function renderHistory(){
  const list=$('historyList'),count=$('historyCount');
  if(!list||!count)return;
  const rows=Array.isArray(mem.recentTrades)?mem.recentTrades.slice().reverse():[];
  count.textContent=rows.length;
  if(!rows.length){
    list.innerHTML='<div class="historyEmpty">Aún no hay operaciones guardadas en este navegador.</div>';
    return;
  }
  const cash=String.fromCharCode(36);
  list.innerHTML=rows.map(t=>{
    const ts=safeNum(t.ts,0);
    const time=ts?new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
    const loss=!!t.loss;
    const profit=safeNum(t.p,0);
    const risk=fmtPct(safeNum(t.r,NaN));
    const conf=fmtPct(safeNum(t.c,NaN));
    const digit=Number.isInteger(Number(t.d))?'D'+Number(t.d):'—';
    const rawMode=String(t.mode||'').toUpperCase();
    const mode=rawMode==='REAL'?'REAL':rawMode==='DEMO'?'DEMO':'';
    const stake=Number.isFinite(Number(t.stake))?' · '+cash+Number(t.stake).toFixed(2):'';
    const origin=t.manual?'MANUAL':'IA';
    return '<div class="historyRow">'
      +'<span class="hTime">'+time+'</span>'
      +'<span class="hDigit">'+digit+'</span>'
      +'<span class="hResult '+(loss?'match':'win')+'">'+(loss?'MATCH':'WIN')+'</span>'
      +'<span class="hProfit '+(profit>=0?'pos':'neg')+'">'+(profit>=0?'+':'')+cash+profit.toFixed(2)+'</span>'
      +'<span class="hMeta">'+risk+'</span>'
      +'<span class="hMeta">'+conf+(mode?' · '+mode:'')+stake+' · '+origin+'</span>'
      +'</div>';
  }).join('');
}

function renderSession(){
  const cash=String.fromCharCode(36);
  $('pnl').textContent=(session.pnl>=0?'+':'')+cash+session.pnl.toFixed(2);
  $('wins').textContent=session.wins;
  $('losses').textContent=session.losses;
  $('ops').textContent=session.ops;
  if($('streakState')){
    const si=streakRiskInfo(session.streak);
    $('streakState').textContent=session.streak+' WIN'+(session.streak===1?'':'S')+(si.active?' · CAUTELA':' · NORMAL');
  }
  $('learnedTicks').textContent=mem.tickCount;
  $('learnedTrades').textContent=mem.tradeCount;
  $('horizon').textContent=horizonNow()+'T';
  renderHistory();
}

function baseStake(){return Math.max(.01,safeNum($('baseStake').value,1))}
function target(){return Math.max(.01,safeNum($('targetInput').value,3))}
function stopLoss(){return Math.max(.01,safeNum($('stopLossInput').value,5))}

function canTradeMode(){
  const mode=$('mode').value;
  if(!window.demoReady){$('status').textContent='CONECTA DERIV PRIMERO';return false}
  if(window.currentAccountType!==mode.toLowerCase()){
    $('status').textContent='RECONECTA DERIV EN '+mode;
    return false;
  }
  return true;
}

function resetAutoSignal(){
  autoSignal={
    digit:null,count:0,lastTick:-1,lastRisk:UNIFORM,lastScore:0,lastConfidence:0,
    lastOod:1,lastConsensus:0,lastRobustRisk:.30,needed:AUTO_CONFIRM_TICKS
  };
}
function confirmAutoEntry(decision){
  if(!decision||decision.action!=='BUY'||!decision.best){
    resetAutoSignal();
    return {ready:false,count:0,needed:AUTO_CONFIRM_TICKS,strong:false,stable:false};
  }

  const risk=safeNum(decision.best.risk,UNIFORM);
  const conf=safeNum(decision.confidence,0);
  const score=safeNum(decision.best.score,0);
  const ood=safeNum(decision.oodScore,1);
  const consensus=safeNum(decision.entryCommittee?.consensus,0);
  const robustRisk=safeNum(decision.entryCommittee?.robustRisk,.30);
  const needed=AUTO_CONFIRM_TICKS;

  // Vuelve a exigir el MISMO candidato en dos ticks consecutivos.
  // No existe bypass de 1 tick, ni siquiera para una señal fuerte.
  const sameCandidate=
    autoSignal.digit===decision.best.d &&
    autoSignal.lastTick===liveTickCounter-1;

  let stable=false;
  if(sameCandidate){
    const riskStable=risk<=safeNum(autoSignal.lastRisk,UNIFORM)+.0008;
    const scoreStable=score>=safeNum(autoSignal.lastScore,0)-.025;
    const confStable=conf>=safeNum(autoSignal.lastConfidence,0)-.035;
    const oodStable=ood<=safeNum(autoSignal.lastOod,1)+.040;
    const consensusStable=consensus>=safeNum(autoSignal.lastConsensus,0)-.050;
    const robustStable=robustRisk<=safeNum(autoSignal.lastRobustRisk,.30)+.0035;
    stable=riskStable&&scoreStable&&confStable&&oodStable&&consensusStable&&robustStable;
    autoSignal.count=stable?Math.min(needed,autoSignal.count+1):1;
  }else{
    autoSignal.count=1;
  }

  autoSignal.digit=decision.best.d;
  autoSignal.lastTick=liveTickCounter;
  autoSignal.lastRisk=risk;
  autoSignal.lastScore=score;
  autoSignal.lastConfidence=conf;
  autoSignal.lastOod=ood;
  autoSignal.lastConsensus=consensus;
  autoSignal.lastRobustRisk=robustRisk;
  autoSignal.needed=needed;

  return {
    ready:autoSignal.count>=needed,
    count:autoSignal.count,
    needed,
    strong:false,
    stable:sameCandidate?stable:true,
    consensus,
    robustRisk
  };
}
function enterTrade(decision,manual=false){
  if(pendingTrade||!decision||!canTradeMode())return;
  autoWaitTicks=0;
  const digit=decision.best.d,stake=Math.max(.01,safeNum(nextStake,baseStake())),mode=$('mode').value;
  const sessionOp=Math.max(1,Math.floor(safeNum(session.settled,0))+1);
  pendingTrade={digit,stake,mode,signalTick:liveTickCounter,signalEpoch:lastEpoch,context:hist.slice(-6),predictedRisk:decision.best.risk,confidence:decision.confidence,streakBefore:Math.max(0,Math.floor(safeNum(session.streak,0))),sessionOp,manual,policy:DIFFER_POLICY_VERSION};
  if(!manual)resetAutoSignal();
  session.ops++;
  mem.recentPicks.push(digit);if(mem.recentPicks.length>30)mem.recentPicks.shift();
  $('status').textContent=(manual?'MANUAL':'AUTO IA')+' · ENVIANDO D'+digit;
  log(`${manual?'MANUAL':'AUTO'} ${mode} · DIFFER D${digit} · $${stake.toFixed(2)} · riesgo ${fmtPct(decision.best.risk)} · conf ${fmtPct(decision.confidence)} · ${DIFFER_POLICY_VERSION}`);
  renderSession();
  window.nexusTradeEffect?.('buy',{digit,stake,mode,manual});
  window.sendDemoTrade(digit,stake).catch(tradeError);
}

function tradeError(e){
  const failed=pendingTrade;
  log('ERROR DERIV · '+(e?.message||e));
  if(failed)window.nexusTradeEffect?.('error',failed);
  pendingTrade=null;
  resetAutoSignal();
  $('status').textContent='ERROR DERIV · IA SIGUE APRENDIENDO';
}

async function syncMasterBrain(silent=true){
  try{
    const r=await fetch(CLOUD_URL+'/api/cloud/master?ts='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    const normalized=normalizeCloudMaster(data?.master);
    if(!data?.ok||!normalized)throw new Error('respuesta master inválida');
    const previous=cloudMaster.revision;
    cloudMaster=normalized;
    renderMasterState();
    if(!silent||cloudMaster.revision!==previous){
      log('MASTER CLOUD · '+cloudMaster.version+' · revisión '+cloudMaster.revision+' · '+cloudMaster.counterfactualTicks+' ticks contrafactuales');
    }
    return true;
  }catch(e){
    renderMasterState();
    if(!silent)log('MASTER CLOUD · usando copia local de respaldo · '+(e?.message||e));
    return false;
  }
}

async function syncCloudPrediction(){
  try{
    const r=await fetch(CLOUD_URL+'/api/cloud/prediction?ts='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json(),p=data?.prediction;
    if(!data?.ok||!p||!Array.isArray(p.probabilities)||p.probabilities.length!==10)return;
    const signalEpoch=Math.floor(safeNum(p.signalEpoch,0));
    const generatedAt=safeNum(p.generatedAt,0);
    if(!signalEpoch||!generatedAt)return;
    cloudLive={prediction:{
      ...p,
      probabilities:normalizeDist(p.probabilities),
      calibratedRisks:Array.isArray(p.calibratedRisks)&&p.calibratedRisks.length===10
        ?p.calibratedRisks.map(x=>clamp(safeNum(x,UNIFORM),.005,.30))
        :null,
      signalEpoch,
      generatedAt,
      confidence:clamp(safeNum(p.confidence,0),0,1),
      driftActive:!!p.driftActive
    },updatedAt:Date.now()};
  }catch(_){}
}

async function syncCollaborative(){
  try{
    const r=await fetch(CLOUD_URL+'/api/cloud/collaborative?ts='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    if(!data?.ok||!data.collaborative)throw new Error('respuesta inválida');
    sharedModel=normalizeShared(data.collaborative);
    if(!sharedLogged){
      sharedLogged=true;
      log('COLAB · '+sharedModel.accepted+' experiencias compartidas disponibles para la IA');
    }
  }catch(e){
    if(!sharedLogged){
      sharedLogged=true;
      log('COLAB · nube colaborativa no disponible · '+(e?.message||e));
    }
  }
}

function shareExperience(t,loss,elapsed,sessionEnd=''){
  if(!t||!Number.isFinite(Number(t.signalEpoch))||Number(t.signalEpoch)<=0)return;
  const payload={
    signalEpoch:Number(t.signalEpoch),
    digit:Number(t.digit),
    loss:!!loss,
    risk:clamp(safeNum(t.predictedRisk,UNIFORM),0,.5),
    confidence:clamp(safeNum(t.confidence,0),0,1),
    elapsed:clamp(Math.round(safeNum(elapsed,1)),1,3),
    streakBefore:Math.max(0,Math.floor(safeNum(t.streakBefore,0))),
    sessionId:String(sessionId||'').slice(0,64),
    sessionOp:Math.max(1,Math.min(500,Math.floor(safeNum(t.sessionOp,1)))),
    sessionEnd:(sessionEnd==='TARGET'||sessionEnd==='STOP')?sessionEnd:'',
    context:Array.isArray(t.context)?t.context.slice(-6):[],
    manual:!!t.manual,
    policy:String(t.policy||DIFFER_POLICY_VERSION).slice(0,48)
  };

  fetch(CLOUD_URL+'/api/cloud/experience',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    keepalive:true
  }).then(r=>r.ok?r.json():null).then(data=>{
    if(data?.accepted)syncCollaborative();
    if(data?.ok)syncMasterBrain(true);
  }).catch(()=>{});
}

function settleTrade(profit){
  profit=Number(profit);
  if(!Number.isFinite(profit)){tradeError(new Error('Resultado inválido'));return}
  const t=pendingTrade;
  if(!t){log('RESULTADO RECIBIDO SIN OPERACIÓN PENDIENTE');return}

  const loss=profit<=0?1:0;
  session.pnl+=profit;
  updateStreakStats(t.streakBefore,loss);
  if(loss){
    session.losses++;mem.digitStats[t.digit].l++;
    session.streak=0;
    nextStake=baseStake();
    mem.recovery={remaining:12,lastMatchAt:Date.now()};
  }else{
    session.wins++;mem.digitStats[t.digit].w++;
    session.streak=Math.max(0,Math.floor(safeNum(t.streakBefore,session.streak)))+1;
    session.maxStreak=Math.max(safeNum(session.maxStreak,0),session.streak);
    nextStake=Math.max(baseStake(),t.stake+Math.max(0,profit));
  }

  mem.tradeCount++;
  mem.lossEWMA=.92*safeNum(mem.lossEWMA,.10)+.08*loss;
  const calibrationError=loss-safeNum(t.predictedRisk,UNIFORM);
  mem.calibrationEWMA=.94*safeNum(mem.calibrationEWMA,0)+.06*calibrationError;

  const elapsed=clamp(liveTickCounter-t.signalTick,1,3);
  mem.delayEWMA=.82*safeNum(mem.delayEWMA,1)+.18*elapsed;
  session.settled=Math.max(Math.floor(safeNum(session.settled,0)),Math.floor(safeNum(t.sessionOp,1)));
  const sessionEnd=session.pnl>=target()?'TARGET':session.pnl<=-stopLoss()?'STOP':'';
  shareExperience(t,loss,elapsed,sessionEnd);
  mem.recentTrades.push({loss,d:t.digit,r:t.predictedRisk,c:t.confidence,p:profit,h:elapsed,op:t.sessionOp,streakBefore:t.streakBefore,ts:Date.now(),mode:t.mode,stake:t.stake,manual:!!t.manual});
  if(mem.recentTrades.length>60)mem.recentTrades.shift();

  log(`${loss?'MATCH':'WIN'} · OP #${t.sessionOp} · D${t.digit} · ${(profit>=0?'+':'')}$${profit.toFixed(2)} · IA ajustó calibración y horizonte ${horizonNow()}T`);
  window.nexusOutcomeSound?.(loss?'loss':'win');
  window.nexusTradeEffect?.('result',{...t,loss:!!loss,profit});
  pendingTrade=null;
  resetAutoSignal();
  saveMemory(true);
  renderSession();

  if(sessionEnd==='TARGET'){
    autoRunning=false;
    sessionPaused=false;
    sessionClosed=true;
    $('status').textContent='TP +$'+target().toFixed(2)+' · SESIÓN COMPLETADA EN #'+t.sessionOp+' · IA SIGUE APRENDIENDO';
  }else if(sessionEnd==='STOP'){
    autoRunning=false;
    sessionPaused=false;
    sessionClosed=true;
    $('status').textContent='SL -$'+stopLoss().toFixed(2)+' · SESIÓN CERRADA EN #'+t.sessionOp+' · IA SIGUE APRENDIENDO';
  }else if(autoRunning){
    $('status').textContent='AUTO IA ACTIVO';
  }
}

function processDigit(d,epoch,isLive,quote){
  if(!Number.isInteger(d)||d<0||d>9)return;
  if(epoch&&epoch<=safeNum(mem.lastMarketEpoch,0) && !isLive)return;

  const q=Number(quote);
  const targetPrice=Number.isFinite(q)?q:(priceHist.length?priceHist[priceHist.length-1]:0);
  const nextCounter=liveTickCounter+(isLive?1:0);

  if(isLive){
    resolvePredictionQueue(d,nextCounter);
    resolveMovementForecasts(targetPrice,nextCounter);
    resolveRangeForecasts(targetPrice,nextCounter);
  }
  learnMovementOutcome(targetPrice,d);
  learnRangeOutcome(targetPrice,d);
  learnDigit(d,hist);

  hist.push(d);epochs.push(epoch||0);
  priceHist.push(targetPrice);
  motionHist.push(motionSnapshot(priceHist));
  if(hist.length>MAX_HIST){hist.shift();epochs.shift();motionHist.shift()}
  if(priceHist.length>MAX_HIST)priceHist.shift();
  if(epoch)mem.lastMarketEpoch=Math.max(safeNum(mem.lastMarketEpoch,0),epoch);
  if(isLive){
    liveTickCounter=nextCounter;
    if(mem.recovery?.remaining>0)mem.recovery.remaining--;
    $('tick').textContent='D'+d;
  }

  if(mem.tickCount%250===0)pruneModels(false);
  if(!isLive)return;

  saveMemory(false);
  renderSession();

  if(autoRunning&&!pendingTrade)autoWaitTicks=Math.min(999,autoWaitTicks+1);
  const decision=predict();
  schedulePrediction(decision,liveTickCounter);
  scheduleMovementForecasts(liveTickCounter);
  scheduleRangeForecasts(liveTickCounter);
  renderDecision(decision);

  if(autoRunning && !pendingTrade && decision?.action==='BUY'){
    const confirmation=confirmAutoEntry(decision);
    decision.autoConfirmation=confirmation;
    if(confirmation.ready){
      enterTrade(decision,false);
    }else{
      $('status').textContent='VALIDANDO D'+decision.best.d+' '+confirmation.count+'/'+confirmation.needed;
      if($('decision')){
        $('decision').textContent='VALIDANDO D'+decision.best.d+' · '+confirmation.count+'/'+confirmation.needed;
        $('decision').className='decision stateWait';
      }
      if($('reason'))$('reason').textContent=
        'La señal pasó el primer filtro. La IA exige el mismo candidato dos ticks seguidos y confirma que riesgo, contexto y consenso no empeoren · comité '+
        Math.round(safeNum(confirmation.consensus,0)*100)+'% · robusto '+fmtPct(confirmation.robustRisk)+'.';
    }
  }else if(autoRunning && decision?.action==='PAUSE'){
    resetAutoSignal();
    $('status').textContent='PAUSA IA · SIGUE APRENDIENDO';
  }else if(decision?.action!=='BUY'){
    resetAutoSignal();
  }
}

function digitFromQuote(q,pip){
  const n=Number(q);if(!Number.isFinite(n))return null;
  const p=Number.isFinite(Number(pip))?Number(pip):4;
  const s=n.toFixed(p);
  return Number(s[s.length-1]);
}

async function syncFromCloud(){
  try{
    const r=await fetch(CLOUD_URL+'/api/cloud/snapshot?ts='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    if(!data?.ok||!data.memory)throw new Error('respuesta inválida');

    const cloud=normalizeMemory(data.memory);
    const cloudTicks=safeNum(cloud.tickCount,0);

    // Railway es el cerebro predictivo maestro. Lo personal de trading permanece local.
    if(cloudTicks>0){
      mem.models=cloud.models;
      mem.globalP=cloud.globalP;
      mem.globalN=cloud.globalN;
      mem.modelLoss=cloud.modelLoss;
      if(data.memory.motionModels)mem.motionModels=cloud.motionModels;
      if(data.memory.phaseModels)mem.phaseModels=cloud.phaseModels;
      if(data.memory.movementModels)mem.movementModels=cloud.movementModels;
      if(data.memory.moveDigitModels)mem.moveDigitModels=cloud.moveDigitModels;
      if(data.memory.movementBucketStats)mem.movementBucketStats=cloud.movementBucketStats;
      if(data.memory.movementPerf)mem.movementPerf=cloud.movementPerf;
      if(data.memory.rangeModels)mem.rangeModels=cloud.rangeModels;
      if(data.memory.rangePerf)mem.rangePerf=cloud.rangePerf;
      mem.tickCount=cloudTicks;
      mem.createdAt=Math.min(safeNum(mem.createdAt,Date.now()),safeNum(cloud.createdAt,Date.now()));
      mem.updatedAt=Math.max(safeNum(mem.updatedAt,0),safeNum(cloud.updatedAt,0));

      if(Array.isArray(data.recentDigits)&&data.recentDigits.length){
        hist=data.recentDigits.slice(-MAX_HIST).map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=9);
        epochs=[];
        if(Array.isArray(data.recentPrices)&&data.recentPrices.length){
          priceHist=data.recentPrices.slice(-hist.length).map(Number).filter(Number.isFinite);
          motionHist=[];
          const build=[];
          priceHist.forEach(v=>{build.push(v);motionHist.push(motionSnapshot(build))});
          if(motionHist.length<hist.length){
            const miss=hist.length-motionHist.length;
            motionHist=Array(miss).fill(null).concat(motionHist);
          }
        }else{
          priceHist=[];
          motionHist=Array(hist.length).fill(null);
        }
      }
      if(Number.isFinite(Number(data.lastEpoch))){
        mem.lastMarketEpoch=Math.max(safeNum(mem.lastMarketEpoch,0),Number(data.lastEpoch));
      }
    }

    const master=normalizeCloudMaster(data.master||data.memory?.master);
    if(master)cloudMaster=master;

    saveMemory(true);
    renderMasterState();
    renderSession();
    renderDecision(predict());
    log('NUBE MAESTRA · cerebro sincronizado: '+cloudTicks+' ticks · master R'+safeNum(cloudMaster.revision,0));
  }catch(e){
    renderMasterState();
    log('NUBE · no disponible, continúo con la última copia local · '+(e?.message||e));
  }
}
function connectMarket(){
  clearTimeout(reconnectTimer);
  try{marketWS?.close()}catch(_){}
  marketWS=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');
  marketWS.onopen=()=>{
    $('status').textContent=autoRunning?'AUTO IA ACTIVO':'IA APRENDIENDO · COMPRAS DETENIDAS';
    marketWS.send(JSON.stringify({ticks_history:'R_75',count:700,end:'latest',style:'ticks'}));
  };
  marketWS.onmessage=e=>{
    let m;try{m=JSON.parse(e.data)}catch(_){return}
    if(m.error){log('MERCADO ERROR · '+(m.error.message||'desconocido'));return}
    if(m.history?.prices){
      const prices=m.history.prices;
      const times=Array.isArray(m.history.times)?m.history.times:[];
      const pip=Number(m.pip_size||4);
      if(Number.isFinite(pip))marketPip=pip;
      let added=0;
      for(let i=0;i<prices.length;i++){
        const ep=Number(times[i]||0);
        if(ep && ep<=safeNum(mem.lastMarketEpoch,0))continue;
        const d=digitFromQuote(prices[i],pip);
        if(d!==null){processDigit(d,ep,false,prices[i]);added++}
      }
      pruneModels(false);
      saveMemory(true);
      renderSession();
      renderDecision(predict());
      log(`MERCADO · historial recibido · ${added} ticks nuevos incorporados a memoria`);
      marketWS.send(JSON.stringify({ticks:'R_75',subscribe:1}));
    }
    if(m.tick){
      const ep=Number(m.tick.epoch||0);
      if(ep && ep===lastEpoch)return;
      lastEpoch=ep;
      if(Number.isFinite(Number(m.tick.pip_size)))marketPip=Number(m.tick.pip_size);
      const d=digitFromQuote(m.tick.quote,m.tick.pip_size);
      if(d!==null)processDigit(d,ep,true,m.tick.quote);
    }
  };
  marketWS.onerror=()=>log('MERCADO · error WebSocket público');
  marketWS.onclose=()=>{
    $('status').textContent='MERCADO DESCONECTADO · RECONECTANDO';
    reconnectTimer=setTimeout(connectMarket,2500);
  };
}

$('start').onclick=()=>{
  if(!canTradeMode())return;
  if(pendingTrade){$('status').textContent='ESPERA RESULTADO DE OPERACIÓN ACTUAL';return}
  session={pnl:0,wins:0,losses:0,ops:0,settled:0,streak:0,maxStreak:0};
  nextStake=baseStake();
  pendingTrade=null;
  sessionId='S'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
  resetAutoSignal();
  autoWaitTicks=0;
  sessionStarted=true;
  sessionPaused=false;
  sessionClosed=false;
  autoRunning=true;
  $('status').textContent='AUTO IA ACTIVO · SESIÓN NUEVA';
  log(`NUEVA SESIÓN ${$('mode').value} · stake $${baseStake().toFixed(2)} · TP $${target().toFixed(2)} · SL $${stopLoss().toFixed(2)}`);
  renderSession();
};

$('stop').onclick=()=>{
  autoRunning=false;
  resetAutoSignal();
  if(sessionStarted&&!sessionClosed)sessionPaused=true;
  $('status').textContent='SESIÓN PAUSADA · IA SIGUE APRENDIENDO';
  log('PAUSA MANUAL · sesión conservada · usa CONTINUAR IA para retomarla');
};

if($('continue'))$('continue').onclick=()=>{
  if(!canTradeMode())return;
  if(!sessionStarted){$('status').textContent='PRIMERO INICIA UNA SESIÓN';return}
  if(sessionClosed){$('status').textContent='SESIÓN FINALIZADA · USA INICIAR IA PARA UNA NUEVA';return}
  resetAutoSignal();
  autoWaitTicks=0;
  autoRunning=true;
  sessionPaused=false;
  $('status').textContent='AUTO IA CONTINUADA · OP #'+(Math.floor(safeNum(session.settled,0))+1);
  log('CONTINUAR IA · misma sesión · PNL '+(session.pnl>=0?'+':'')+'$'+session.pnl.toFixed(2)+' · próxima OP #'+(Math.floor(safeNum(session.settled,0))+1));
  renderSession();
};

$('manualBuy').onclick=()=>{
  if(pendingTrade){$('status').textContent='OPERACIÓN EN CURSO';return}
  if(!lastDecision){$('status').textContent='AÚN SIN CANDIDATO';return}
  enterTrade(lastDecision,true);
};

$('resetMemory').onclick=()=>{
  const ok=confirm('¿Borrar toda la memoria aprendida por esta IA?');
  if(!ok)return;
  localStorage.removeItem(KEY);
  mem=freshMemory();hist=[];epochs=[];priceHist=[];motionHist=[];predictionQueue=[];lastDecision=null;
  renderSession();renderDecision(null);
  log('MEMORIA IA BORRADA · comienza aprendizaje nuevo');
};

window.demoSettlement=settleTrade;
window.demoTradeError=tradeError;

renderSession();
renderDecision(null);
log(`IA cargada · memoria: ${mem.tickCount} ticks y ${mem.tradeCount} operaciones aprendidas`);
syncFromCloud().then(()=>Promise.all([syncMasterBrain(false),syncCollaborative(),syncCloudPrediction()])).finally(()=>{
  clearInterval(sharedSyncTimer);
  clearInterval(cloudPredictionTimer);
  clearInterval(masterSyncTimer);
  sharedSyncTimer=setInterval(syncCollaborative,30000);
  masterSyncTimer=setInterval(()=>syncMasterBrain(true),15000);
  cloudPredictionTimer=setInterval(syncCloudPrediction,1600);
  renderMasterState();
  connectMarket();
});
})();
