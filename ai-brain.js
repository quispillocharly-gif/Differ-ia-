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
const EXPERTS=['global','recent','ctx1','ctx2','ctx3','collab','cloud'];
const BASELINE_LOGLOSS=Math.log(10);
const BASELINE_BRIER=.09;

let marketWS=null,reconnectTimer=null,lastEpoch=0;
let hist=[];                 // dígitos en vivo/históricos
let epochs=[];
let liveTickCounter=0;
let autoRunning=false;
let pendingTrade=null;
let session={pnl:0,wins:0,losses:0,ops:0};
let lastDecision=null;
let recentLogs=[];
let nextStake=null;
let sharedModel={accepted:0,wins:0,matches:0,matchRate:UNIFORM,byDigit:Array.from({length:10},()=>({n:0,matches:0})),contexts:{},updatedAt:0};
let sharedSyncTimer=null,sharedLogged=false,cloudPredictionTimer=null;
let predictionQueue=[];
let cloudLive={prediction:null,updatedAt:0};

function blankP(){return Array(10).fill(UNIFORM)}
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
    errorContexts:[],
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
  m.errorContexts=Array.isArray(m.errorContexts)?m.errorContexts.slice(-100).map(x=>({
    ctx:String(x?.ctx||'').slice(-3),
    digit:Math.max(0,Math.min(9,Math.floor(safeNum(x?.digit,0)))),
    ts:Math.max(0,safeNum(x?.ts,0)),
    risk:clamp(safeNum(x?.risk,UNIFORM),0,.5),
    confidence:clamp(safeNum(x?.confidence,0),0,1)
  })):[];
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
  const driftBoost=mem.drift?.active?1.30:1;
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
  if(mem.drift?.active){
    if(name==='recent')w*=1.35;
    else if(name==='ctx1')w*=1.15;
    else if(name==='ctx3')w*=.82;
    else if(name==='global')w*=.78;
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
function digitCalibratedRisk(d,risk){
  const raw=clamp(safeNum(risk,UNIFORM),.005,.30);
  const st=mem.digitCalibration?.[d];
  if(!st||st.n<20)return raw;
  const predAvg=safeNum(st.predictedSum,0)/Math.max(1,st.n);
  const observed=(safeNum(st.matches,0)+18*UNIFORM)/(safeNum(st.n,0)+18);
  const bias=clamp(observed-predAvg,-.018,.028);
  const evidence=1-Math.exp(-st.n/90);
  return clamp(raw+bias*evidence,Math.max(.005,raw*.72),Math.min(.30,raw*1.38));
}
function contextErrorPenalty(d){
  const ctx=contextSignature();
  if(!ctx||!Array.isArray(mem.errorContexts))return 0;
  const now=Date.now();
  let score=0;
  for(const x of mem.errorContexts){
    if(x.digit!==d||x.ctx!==ctx)continue;
    const ageDays=(now-safeNum(x.ts,now))/86400000;
    score+=Math.exp(-Math.max(0,ageDays)/3);
  }
  return clamp(score*.0014,0,.007);
}
function recordPredictionOutcome(item,target){
  if(!Number.isInteger(item?.digit)||item.digit<0||item.digit>9)return;
  const st=mem.digitCalibration[item.digit];
  st.n++;
  if(target===item.digit)st.matches++;
  st.predictedSum+=clamp(safeNum(item.risk,UNIFORM),0,.5);
  if(target===item.digit){
    mem.errorContexts.push({
      ctx:String(item.context||''),
      digit:item.digit,
      ts:Date.now(),
      risk:clamp(safeNum(item.risk,UNIFORM),0,.5),
      confidence:clamp(safeNum(item.confidence,0),0,1)
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
    experts:(decision.expertViews||[]).map(v=>({name:v.name,p:Array.isArray(v.p)?v.p.slice():blankP()}))
  });
  if(predictionQueue.length>18)predictionQueue=predictionQueue.slice(-18);
}

function predict(){
  if(hist.length<8)return null;
  const h=horizonNow();
  const dist=Array(10).fill(0);
  const denom=Array(10).fill(0);
  const modelViews=[];

  // Base adaptativa global, ponderada por rendimiento prequential.
  const gw=.45*expertWeight('global');
  for(let d=0;d<10;d++){
    dist[d]+=mem.globalP[d]*gw;
    denom[d]+=gw;
  }
  modelViews.push({name:'global',p:mem.globalP.slice(),w:gw,n:mem.globalN});

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
    for(let d=0;d<10;d++){
      dist[d]+=node.p[d]*w;
      denom[d]+=w;
    }
    modelViews.push({name:'ctx'+o,p:node.p.slice(),w,n:node.n});
  }

  // Frecuencia muy reciente: no manda, solo ayuda a detectar cambios rápidos.
  const recent=hist.slice(-50),counts=Array(10).fill(1.2);
  recent.forEach(d=>counts[d]++);
  const total=counts.reduce((a,b)=>a+b,0);
  const rp=counts.map(x=>x/total),rw=.28*expertWeight('recent');
  for(let d=0;d<10;d++){
    dist[d]+=rp[d]*rw;
    denom[d]+=rw;
  }
  modelViews.push({name:'recent',p:rp,w:rw,n:recent.length});

  // Ensemble cloud 24/7: solo participa si predijo exactamente el mismo tick.
  const cp=cloudLive.prediction;
  if(cp && Number(cp.signalEpoch)===Number(lastEpoch) && Date.now()-safeNum(cp.generatedAt,0)<3500){
    const cpp=normalizeDist(cp.probabilities);
    const freshness=clamp(1-(Date.now()-cp.generatedAt)/3500,.20,1);
    const cw=.34*(.25+.75*cp.confidence)*freshness*expertWeight('cloud')*(cp.driftActive?.78:1);
    for(let d=0;d<10;d++){
      dist[d]+=cpp[d]*cw;
      denom[d]+=cw;
    }
    modelViews.push({name:'cloud',p:cpp,w:cw,n:safeNum(mem.prequential.samples,0)});
  }

  const p=dist.map((x,d)=>x/(denom[d]||1));
  let sum=p.reduce((a,b)=>a+b,0)||1;
  for(let d=0;d<10;d++)p[d]/=sum;

  // Experiencias compartidas: aportan como un experto adicional, nunca dominan por sí solas.
  const shared=sharedDistribution();
  if(shared&&shared.support>0){
    const w=clamp(.24*shared.support*expertWeight('collab'),0,.34);
    for(let d=0;d<10;d++)p[d]=(1-w)*p[d]+w*shared.p[d];
    sum=p.reduce((a,b)=>a+b,0)||1;
    for(let d=0;d<10;d++)p[d]/=sum;
    modelViews.push({name:'collab',p:shared.p.slice(),w,n:sharedModel.accepted});
  }

  // Penalización suave por fijación: no bloquea ningún dígito.
  const recentPicks=mem.recentPicks.slice(-12);
  const exposure=Array(10).fill(0);recentPicks.forEach(d=>exposure[d]++);
  const maxExp=Math.max(1,...exposure);
  const scored=p.map((rawRisk,d)=>{
    const fixation=exposure[d]/maxExp;
    const risk=digitCalibratedRisk(d,rawRisk);
    const errorPenalty=contextErrorPenalty(d);
    const adjusted=risk + fixation*.0025 + errorPenalty;
    return {d,risk,rawRisk,adjusted,errorPenalty};
  }).sort((a,b)=>a.adjusted-b.adjusted||a.risk-b.risk);

  const best=scored[0],second=scored[1];
  const views=modelViews.filter(v=>Array.isArray(v.p)&&v.p.length===10);
  const wsum=views.reduce((s,v)=>s+Math.max(.01,safeNum(v.w,1)),0)||1;
  const mean=views.reduce((s,v)=>s+safeNum(v.p[best.d],best.risk)*Math.max(.01,safeNum(v.w,1)),0)/wsum;
  const variance=views.reduce((s,v)=>{
    const w=Math.max(.01,safeNum(v.w,1)),x=safeNum(v.p[best.d],best.risk);
    return s+w*(x-mean)*(x-mean);
  },0)/wsum;
  const disagreement=Math.sqrt(Math.max(0,variance));

  const contextNodes=modelViews.filter(v=>v.name.startsWith('ctx'));
  const support=contextNodes.length?contextNodes.reduce((s,v)=>s+Math.min(1,v.n/30),0)/contextNodes.length:0;
  const stability=Math.exp(-disagreement*18);
  const calibrationTrust=clamp(1-Math.max(0,mem.calibrationEWMA)*4.5,.25,1);
  const entropy=-p.reduce((s,x)=>s+(x>0?x*Math.log(x):0),0)/Math.log(10);
  const sharpness=clamp((1-entropy)/.075,0,1);
  const preqSamples=safeNum(mem.prequential.samples,0);
  const brier=safeNum(mem.prequential.brierEWMA,BASELINE_BRIER);
  const preqSkill=clamp((BASELINE_BRIER-brier)/.018,-1,1);
  const skillTrust=preqSamples<35?.72:clamp(.65+.35*Math.max(0,preqSkill),.58,1);
  const driftPenalty=mem.drift?.active?.78:1;
  const confidence=clamp((.18+.82*support)*stability*calibrationTrust*(.72+.28*sharpness)*skillTrust*driftPenalty,0,1);
  const edge=UNIFORM-best.risk;

  const recentLoss=Math.max(0,safeNum(mem.lossEWMA,.10)-UNIFORM);
  const contextCoverage=clamp(contextNodes.length/3,0,1);
  const oodScore=clamp((1-support)*.48+(1-contextCoverage)*.18+Math.min(1,disagreement/.03)*.22+(mem.drift?.active?.12:0),0,1);
  const recoveryRatio=clamp(safeNum(mem.recovery?.remaining,0)/12,0,1);
  const uncertaintyPenalty=disagreement*.18+(1-sharpness)*.0015+(mem.drift?.active?.0045:0)+oodScore*.0022+recoveryRatio*.0025;
  const requiredEdge=.0035+(1-confidence)*.012+recentLoss*.18+uncertaintyPenalty;
  const riskCeiling=UNIFORM-requiredEdge;
  const health=clamp(1-recentLoss*3.3-Math.max(0,mem.calibrationEWMA)*2.2-Math.max(0,brier-BASELINE_BRIER)*6-(mem.drift?.active?.10:0),0,1);
  const qualityScore=clamp(confidence*.43+health*.22+(1-oodScore)*.20+sharpness*.10+Math.max(0,preqSkill)*.05,0,1);
  const minConfidence=(mem.drift?.active?.38:.30)+recoveryRatio*.04;
  const minQuality=.34+recoveryRatio*.04;

  let action='WAIT',reason='La IA sigue observando: la ventaja todavía no compensa la incertidumbre.';
  if((mem.tradeCount>=8 && health<.46) || (preqSamples>=45 && brier>BASELINE_BRIER+.018)){
    action='PAUSE';
    reason='PAUSA IA: el rendimiento reciente del modelo perdió estabilidad. Continúa aprendiendo sin comprar.';
  }else if(oodScore>.74){
    reason='ESPERA IA: el contexto actual es poco conocido; necesito más evidencia antes de comprar.';
  }else if(qualityScore<minQuality){
    reason=`ESPERA IA: calidad de señal ${fmtPct(qualityScore)} todavía insuficiente para este contexto.`;
  }else if(best.risk<riskCeiling && confidence>=minConfidence && edge>requiredEdge){
    action='BUY';
    reason=`Compra aceptada: riesgo ${fmtPct(best.risk)}, calidad ${fmtPct(qualityScore)}, confianza ${fmtPct(confidence)} y contexto ${fmtPct(1-oodScore)}.`;
  }else if(mem.drift?.active){
    reason='ESPERA IA: detecté un cambio reciente en el flujo; estoy dando más peso a datos nuevos antes de comprar.';
  }else if(recoveryRatio>0){
    reason='ESPERA IA: recuperación posterior a MATCH; temporalmente exijo una señal más fuerte.';
  }else if(confidence<minConfidence){
    reason='ESPERA IA: todavía hay poca evidencia coincidente entre los modelos.';
  }else if(best.risk>=riskCeiling){
    reason=`ESPERA IA: riesgo ${fmtPct(best.risk)} por encima del límite adaptativo ${fmtPct(riskCeiling)}.`;
  }

  return {h,p,best,second,confidence,edge,requiredEdge,riskCeiling,health,qualityScore,oodScore,action,reason,disagreement,support,entropy,sharpness,preqSkill,expertViews:views};
}

function renderDecision(d){
  lastDecision=d;
  if(!d){
    $('decision').textContent='APRENDIENDO';
    $('decision').className='decision stateWait';
    $('reason').textContent='Aún no hay contexto suficiente.';
    $('pick').textContent='—';$('risk').textContent='—';$('confidence').textContent='—';
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

function enterTrade(decision,manual=false){
  if(pendingTrade||!decision||!canTradeMode())return;
  const digit=decision.best.d,stake=Math.max(.01,safeNum(nextStake,baseStake())),mode=$('mode').value;
  pendingTrade={digit,stake,mode,signalTick:liveTickCounter,signalEpoch:lastEpoch,context:hist.slice(-6),predictedRisk:decision.best.risk,confidence:decision.confidence,manual};
  session.ops++;
  mem.recentPicks.push(digit);if(mem.recentPicks.length>30)mem.recentPicks.shift();
  $('status').textContent=(manual?'MANUAL':'AUTO IA')+' · ENVIANDO D'+digit;
  log(`${manual?'MANUAL':'AUTO'} ${mode} · DIFFER D${digit} · $${stake.toFixed(2)} · riesgo ${fmtPct(decision.best.risk)} · conf ${fmtPct(decision.confidence)}`);
  renderSession();
  window.nexusTradeEffect?.('buy',{digit,stake,mode,manual});
  window.sendDemoTrade(digit,stake).catch(tradeError);
}

function tradeError(e){
  const failed=pendingTrade;
  log('ERROR DERIV · '+(e?.message||e));
  if(failed)window.nexusTradeEffect?.('error',failed);
  pendingTrade=null;
  $('status').textContent='ERROR DERIV · IA SIGUE APRENDIENDO';
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

function shareExperience(t,loss,elapsed){
  if(!t||!Number.isFinite(Number(t.signalEpoch))||Number(t.signalEpoch)<=0)return;
  const payload={
    signalEpoch:Number(t.signalEpoch),
    digit:Number(t.digit),
    loss:!!loss,
    risk:clamp(safeNum(t.predictedRisk,UNIFORM),0,.5),
    confidence:clamp(safeNum(t.confidence,0),0,1),
    elapsed:clamp(Math.round(safeNum(elapsed,1)),1,3),
    context:Array.isArray(t.context)?t.context.slice(-6):[],
    manual:!!t.manual
  };

  fetch(CLOUD_URL+'/api/cloud/experience',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    keepalive:true
  }).then(r=>r.ok?r.json():null).then(data=>{
    if(data?.accepted)syncCollaborative();
  }).catch(()=>{});
}

function settleTrade(profit){
  profit=Number(profit);
  if(!Number.isFinite(profit)){tradeError(new Error('Resultado inválido'));return}
  const t=pendingTrade;
  if(!t){log('RESULTADO RECIBIDO SIN OPERACIÓN PENDIENTE');return}

  const loss=profit<=0?1:0;
  session.pnl+=profit;
  if(loss){
    session.losses++;mem.digitStats[t.digit].l++;
    nextStake=baseStake();
    mem.recovery={remaining:12,lastMatchAt:Date.now()};
  }else{
    session.wins++;mem.digitStats[t.digit].w++;
    nextStake=Math.max(baseStake(),t.stake+Math.max(0,profit));
  }

  mem.tradeCount++;
  mem.lossEWMA=.92*safeNum(mem.lossEWMA,.10)+.08*loss;
  const calibrationError=loss-safeNum(t.predictedRisk,UNIFORM);
  mem.calibrationEWMA=.94*safeNum(mem.calibrationEWMA,0)+.06*calibrationError;

  const elapsed=clamp(liveTickCounter-t.signalTick,1,3);
  mem.delayEWMA=.82*safeNum(mem.delayEWMA,1)+.18*elapsed;
  shareExperience(t,loss,elapsed);
  mem.recentTrades.push({loss,d:t.digit,r:t.predictedRisk,c:t.confidence,p:profit,h:elapsed,ts:Date.now(),mode:t.mode,stake:t.stake,manual:!!t.manual});
  if(mem.recentTrades.length>60)mem.recentTrades.shift();

  log(`${loss?'MATCH':'WIN'} · D${t.digit} · ${(profit>=0?'+':'')}$${profit.toFixed(2)} · IA ajustó calibración y horizonte ${horizonNow()}T`);
  window.nexusOutcomeSound?.(loss?'loss':'win');
  window.nexusTradeEffect?.('result',{...t,loss:!!loss,profit});
  pendingTrade=null;
  saveMemory(true);
  renderSession();

  if(session.pnl>=target()){
    autoRunning=false;
    $('status').textContent='TP +$'+target().toFixed(2)+' · COMPRAS DETENIDAS · IA SIGUE APRENDIENDO';
  }else if(session.pnl<=-stopLoss()){
    autoRunning=false;
    $('status').textContent='SL -$'+stopLoss().toFixed(2)+' · COMPRAS DETENIDAS · IA SIGUE APRENDIENDO';
  }else if(autoRunning){
    $('status').textContent='AUTO IA ACTIVO';
  }
}

function processDigit(d,epoch,isLive){
  if(!Number.isInteger(d)||d<0||d>9)return;
  if(epoch&&epoch<=safeNum(mem.lastMarketEpoch,0) && !isLive)return;

  if(isLive)resolvePredictionQueue(d,liveTickCounter+1);
  learnDigit(d,hist);
  hist.push(d);epochs.push(epoch||0);
  if(hist.length>MAX_HIST){hist.shift();epochs.shift()}
  if(epoch)mem.lastMarketEpoch=Math.max(safeNum(mem.lastMarketEpoch,0),epoch);
  if(isLive){
    liveTickCounter++;
    if(mem.recovery?.remaining>0)mem.recovery.remaining--;
    $('tick').textContent='D'+d;
  }

  if(mem.tickCount%250===0)pruneModels(false);
  if(!isLive)return;

  saveMemory(false);
  renderSession();

  const decision=predict();
  schedulePrediction(decision,liveTickCounter);
  renderDecision(decision);

  if(autoRunning && !pendingTrade && decision?.action==='BUY'){
    enterTrade(decision,false);
  }else if(autoRunning && decision?.action==='PAUSE'){
    $('status').textContent='PAUSA IA · SIGUE APRENDIENDO';
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
    const localTicks=safeNum(mem.tickCount,0);
    const cloudTicks=safeNum(cloud.tickCount,0);
    const localEpoch=safeNum(mem.lastMarketEpoch,0);
    const cloudEpoch=Math.max(safeNum(cloud.lastMarketEpoch,0),safeNum(data.lastEpoch,0));
    const cloudIsFresher=cloudEpoch>localEpoch+1 || (cloudEpoch>=localEpoch && cloudTicks>localTicks);

    if(cloudIsFresher){
      // Solo reemplaza el aprendizaje predictivo. Conserva estadísticas de trading locales.
      mem.models=cloud.models;
      mem.globalP=cloud.globalP;
      mem.globalN=cloud.globalN;
      mem.modelLoss=cloud.modelLoss;
      if(data.memory.expertPerf)mem.expertPerf=cloud.expertPerf;
      if(data.memory.prequential)mem.prequential=cloud.prequential;
      if(data.memory.drift)mem.drift=cloud.drift;
      mem.tickCount=cloudTicks;
      mem.createdAt=Math.min(safeNum(mem.createdAt,Date.now()),safeNum(cloud.createdAt,Date.now()));
      mem.updatedAt=Math.max(safeNum(mem.updatedAt,0),safeNum(cloud.updatedAt,0));

      if(Array.isArray(data.recentDigits)&&data.recentDigits.length){
        hist=data.recentDigits.slice(-MAX_HIST).map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=9);
        epochs=[];
      }
      if(Number.isFinite(Number(data.lastEpoch))){
        mem.lastMarketEpoch=Math.max(safeNum(mem.lastMarketEpoch,0),Number(data.lastEpoch));
      }

      saveMemory(true);
      renderSession();
      renderDecision(predict());
      log('NUBE · memoria sincronizada: '+cloudTicks+' ticks aprendidos');
    }else{
      log('NUBE · memoria local ya está al día ('+localTicks+' ticks)');
    }
  }catch(e){
    log('NUBE · no disponible, continúo con memoria local · '+(e?.message||e));
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
      let added=0;
      for(let i=0;i<prices.length;i++){
        const ep=Number(times[i]||0);
        if(ep && ep<=safeNum(mem.lastMarketEpoch,0))continue;
        const d=digitFromQuote(prices[i],pip);
        if(d!==null){processDigit(d,ep,false);added++}
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
      const d=digitFromQuote(m.tick.quote,m.tick.pip_size);
      if(d!==null)processDigit(d,ep,true);
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
  session={pnl:0,wins:0,losses:0,ops:0};
  nextStake=baseStake();
  pendingTrade=null;
  autoRunning=true;
  $('status').textContent='AUTO IA ACTIVO';
  log(`NUEVA SESIÓN ${$('mode').value} · stake $${baseStake().toFixed(2)} · TP $${target().toFixed(2)} · SL $${stopLoss().toFixed(2)}`);
  renderSession();
};

$('stop').onclick=()=>{
  autoRunning=false;
  $('status').textContent='COMPRAS DETENIDAS · IA SIGUE APRENDIENDO';
  log('STOP MANUAL DE COMPRAS · aprendizaje continúa');
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
  mem=freshMemory();hist=[];epochs=[];predictionQueue=[];lastDecision=null;
  renderSession();renderDecision(null);
  log('MEMORIA IA BORRADA · comienza aprendizaje nuevo');
};

window.demoSettlement=settleTrade;
window.demoTradeError=tradeError;

renderSession();
renderDecision(null);
log(`IA cargada · memoria: ${mem.tickCount} ticks y ${mem.tradeCount} operaciones aprendidas`);
syncFromCloud().then(()=>Promise.all([syncCollaborative(),syncCloudPrediction()])).finally(()=>{
  clearInterval(sharedSyncTimer);
  clearInterval(cloudPredictionTimer);
  sharedSyncTimer=setInterval(syncCollaborative,30000);
  cloudPredictionTimer=setInterval(syncCloudPrediction,1600);
  connectMarket();
});
})();
