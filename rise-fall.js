(()=>{
'use strict';

const CLOUD_URL='https://differ-ia-cloud-production.up.railway.app';
const RF_KEY='NEXUS_RISE_FALL_SESSION_V1';
const $=id=>document.getElementById(id);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)||0));
const money=x=>Number.isFinite(Number(x))?Number(x).toFixed(2):'0.00';

let rfSocket=null;
let rfReady=false;
let rfBusy=false;
let rfAccountType='demo';
let rfCurrency='USD';
let rfAccountId=null;
let rfPing=null;
let rfProposalReq=7000;
let rfBuyReq=8000;
let rfPendingProposal=null;
let rfActiveContract=null;
let rfActiveTrade=null;
let rfSettled=new Set();

let rfAuto=false;
let rfPrediction=null;
let rfLastEpoch=0;
let rfConfirm={action:null,count:0,lastEpoch:0};
let rfNextStake=1;
let rfSession={pnl:0,wins:0,losses:0,ops:0};
let pollTimer=null;

function selected(){
  return $('strategyMode')?.value==='RISE_FALL';
}
function val(id,fallback){
  const n=Number($(id)?.value);
  return Number.isFinite(n)?n:fallback;
}
function stakeBase(){return Math.max(.01,val('rfStake',1))}
function target(){return Math.max(.01,val('rfTarget',3))}
function stopLoss(){return Math.max(.01,val('rfStopLoss',5))}
function horizon(){return Math.max(1,Math.min(3,Math.round(val('rfHorizon',1))))}
function setText(id,v){const e=$(id);if(e)e.textContent=v}
function pct(x){return Number.isFinite(Number(x))?(Number(x)*100).toFixed(1)+'%':'—'}

function saveSession(){
  try{
    localStorage.setItem(RF_KEY,JSON.stringify({
      pnl:rfSession.pnl,wins:rfSession.wins,losses:rfSession.losses,ops:rfSession.ops,
      nextStake:rfNextStake
    }));
  }catch(_){}
}
function render(){
  const p=rfPrediction;
  setText('rfPnl',(rfSession.pnl>=0?'+':'')+'$'+money(rfSession.pnl));
  setText('rfWins',rfSession.wins);
  setText('rfLosses',rfSession.losses);
  setText('rfOps',rfSession.ops);
  setText('rfNextStake','$'+money(rfNextStake));

  if(!p){
    setText('rfDecision','APRENDIENDO');
    setText('rfProbability','—');
    setText('rfMove','—');
    setText('rfValidation','REUNIENDO DATOS');
    setText('rfCloudMode','SHADOW');
    return;
  }

  const arrow=p.direction==='RISE'?'↑':'↓';
  const learningDemo=!p.ready&&$('mode')?.value==='DEMO';
  const visibleAction=learningDemo?(p.learningAction||p.action):p.action;
  const action=visibleAction==='RISE'?'RISE ↑':visibleAction==='FALL'?'FALL ↓':'ESPERAR';
  setText('rfDecision',action);
  setText('rfProbability',pct(p.directionProbability));
  setText('rfMove',arrow+' '+(Number(p.expectedUnits)>=0?'+':'')+Number(p.expectedUnits||0).toFixed(1)+'U');
  const v=p.validation||{};
  const op=p.operationLearning||{};
  setText('rfValidation','HIT '+pct(v.directionHitEWMA)+' · '+Number(v.resolved||0).toLocaleString()+' TESTS · OPS '+Number(op.totalOperations||0).toLocaleString());
  setText('rfCloudMode',p.ready?'ACTIVO':(($('mode')?.value==='DEMO')?'SHADOW + DEMO LEARNING':'SHADOW'));
  setText('rfPhase',String(p.phase||'—').replaceAll('_',' '));
  setText('rfTurn','GIRO '+pct(p.reversalProbability)+' · CONT '+pct(p.continuationProbability));
}

function resetConfirmation(){
  rfConfirm={action:null,count:0,lastEpoch:0};
}

function stopDifferSafely(){
  const stop=$('stop');
  if(stop && !stop.disabled) stop.click();
}

function applyStrategy(){
  const rf=selected();
  const panel=$('rfPanel'),stats=$('rfStatsGrid');
  if(panel)panel.style.display=rf?'block':'none';
  if(stats)stats.style.display=rf?'grid':'none';

  ['start','continue','manualBuy'].forEach(id=>{
    const e=$(id); if(e)e.disabled=rf;
  });

  if(rf){
    stopDifferSafely();
    setText('strategyState','RISE/FALL AISLADO');
    const bd=document.querySelector('.brandDiffer');
    if(bd)bd.textContent='RISE/FALL AI';
    if($('app')?.value.trim()&&$('pat')?.value.trim())connectRf().catch(()=>{});
  }else{
    rfAuto=false;
    resetConfirmation();
    setText('strategyState','DIFFER');
    const bd=document.querySelector('.brandDiffer');
    if(bd)bd.textContent='DIFFER AI';
    ['start','continue','manualBuy'].forEach(id=>{
      const e=$(id); if(e)e.disabled=false;
    });
  }
}

async function api(path,opts={}){
  const pat=$('pat')?.value.trim(),app=$('app')?.value.trim();
  const r=await fetch('https://api.derivws.com'+path,{
    ...opts,
    headers:{
      'Authorization':'Bearer '+pat,
      'Deriv-App-ID':app,
      'Content-Type':'application/json',
      ...(opts.headers||{})
    }
  });
  let j={};try{j=await r.json()}catch(_){}
  if(!r.ok)throw new Error(j?.errors?.[0]?.message||j?.error?.message||'HTTP '+r.status);
  return j;
}

function closeRfSocket(){
  clearInterval(rfPing);
  rfPing=null;
  try{rfSocket?.close()}catch(_){}
  rfSocket=null;
  rfReady=false;
  rfBusy=false;
  rfPendingProposal=null;
  rfActiveContract=null;
  rfActiveTrade=null;
  setText('rfConnState','DESCONECTADO');
}

async function connectRf(){
  if(rfReady||rfBusy)return;
  const pat=$('pat')?.value.trim(),app=$('app')?.value.trim();
  if(!pat||!app)return;
  rfBusy=true;
  setText('rfConnState','CONECTANDO…');

  const targetMode=$('mode')?.value==='REAL'?'real':'demo';
  try{
    const a=await api('/trading/v1/options/accounts',{method:'GET'});
    const rows=Array.isArray(a.data)?a.data:(a.data?[a.data]:[]);
    const acc=rows.find(x=>String(x.account_type||'').toLowerCase()===targetMode&&String(x.status||'active').toLowerCase()==='active');
    if(!acc)throw new Error('No encontré cuenta Options '+targetMode.toUpperCase()+' activa');

    rfAccountId=acc.account_id;
    rfAccountType=targetMode;
    rfCurrency=acc.currency||'USD';

    const o=await api('/trading/v1/options/accounts/'+encodeURIComponent(rfAccountId)+'/otp',{method:'POST'});
    const url=o?.data?.url;
    if(!url)throw new Error('Deriv no devolvió OTP');
    if(targetMode==='demo'&&!/\/ws\/demo\?otp=/i.test(url))throw new Error('Cuenta no DEMO');
    if(targetMode==='real'&&!/\/ws\/real\?otp=/i.test(url))throw new Error('Cuenta no REAL');

    try{rfSocket?.close()}catch(_){}
    rfSocket=new WebSocket(url);

    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Timeout WebSocket')),10000);
      rfSocket.onopen=()=>{
        clearTimeout(timer);
        rfReady=true;
        rfBusy=false;
        setText('rfConnState',targetMode.toUpperCase()+' CONECTADO');
        clearInterval(rfPing);
        rfPing=setInterval(()=>{
          if(rfSocket?.readyState===WebSocket.OPEN)rfSocket.send(JSON.stringify({ping:1}));
        },20000);
        resolve();
      };
      rfSocket.onerror=()=>{
        clearTimeout(timer);
        rfBusy=false;
        rfReady=false;
        setText('rfConnState','ERROR WEBSOCKET');
        reject(new Error('Error WebSocket'));
      };
    });

    rfSocket.onmessage=onRfMessage;
    rfSocket.onclose=()=>{
      rfReady=false;
      clearInterval(rfPing);
      setText('rfConnState','DESCONECTADO');
    };
  }catch(e){
    rfBusy=false;
    rfReady=false;
    setText('rfConnState','ERROR · '+(e?.message||e));
    throw e;
  }
}

function onRfMessage(ev){
  let m;try{m=JSON.parse(ev.data)}catch(_){return}

  if(m.error){
    if(rfPendingProposal){
      const p=rfPendingProposal;rfPendingProposal=null;
      p.reject(new Error(m.error.message||'Error Deriv'));
    }else{
      setText('rfStatus','ERROR DERIV · '+(m.error.message||''));
      rfActiveTrade=null;
    }
    return;
  }

  if(m.msg_type==='proposal'&&rfPendingProposal){
    const p=rfPendingProposal;
    rfPendingProposal=null;
    const id=m.proposal?.id;
    const ask=Number(m.proposal?.ask_price);
    const payout=Number(m.proposal?.payout);
    if(!id||!Number.isFinite(ask)||!Number.isFinite(payout)||payout<=0){
      p.reject(new Error('Propuesta Rise/Fall inválida'));return;
    }

    const breakEven=ask/payout;
    const learningDemo=rfAccountType==='demo'&&!!p.learningDemo;
    const safetyMargin=learningDemo?.004:.025;
    if(p.probability<breakEven+safetyMargin){
      p.resolve({bought:false,breakEven,required:breakEven+safetyMargin,learningDemo});
      return;
    }

    rfActiveTrade={
      action:p.action,
      probability:p.probability,
      stake:p.stake,
      horizon:p.horizon,
      breakEven,
      signalEpoch:p.signalEpoch,
      phase:p.phase,
      ready:p.ready,
      learningDemo:!!p.learningDemo,
      contractId:''
    };
    rfSocket.send(JSON.stringify({buy:id,price:ask,req_id:++rfBuyReq}));
    p.resolve({bought:true,breakEven});
  }

  if(m.msg_type==='buy'&&m.buy?.contract_id){
    rfActiveContract=m.buy.contract_id;
    if(rfActiveTrade)rfActiveTrade.contractId=String(m.buy.contract_id);
    rfSession.ops++;
    saveSession();
    render();
    setText('rfStatus','OPERACIÓN '+rfActiveTrade?.action+' · CONTRATO '+rfActiveContract);
    rfSocket.send(JSON.stringify({
      proposal_open_contract:1,
      contract_id:rfActiveContract,
      subscribe:1,
      req_id:9001
    }));
  }

  if(m.msg_type==='proposal_open_contract'&&m.proposal_open_contract){
    const c=m.proposal_open_contract,id=c.contract_id;
    if(c.is_sold&&!rfSettled.has(id)){
      rfSettled.add(id);
      const profit=Number(c.profit);
      const t=rfActiveTrade;
      rfActiveContract=null;
      rfActiveTrade=null;
      settleRfTrade(Number.isFinite(profit)?profit:0,t);
      if(m.subscription?.id){
        try{rfSocket.send(JSON.stringify({forget:m.subscription.id}))}catch(_){}
      }
    }
  }
}

function sendRfTrade(pred){
  return new Promise((resolve,reject)=>{
    if(!rfReady||!rfSocket||rfSocket.readyState!==WebSocket.OPEN){
      reject(new Error('Rise/Fall no conectado'));
      return;
    }
    if(rfActiveContract||rfPendingProposal||rfActiveTrade){
      resolve({bought:false,busy:true});
      return;
    }
    const action=pred.action;
    if(action!=='RISE'&&action!=='FALL'){
      resolve({bought:false});
      return;
    }
    const stake=Math.max(.01,Number(rfNextStake)||stakeBase());
    const h=horizon();
    rfPendingProposal={
      resolve,reject,
      action,
      probability:clamp(pred.directionProbability,0,1),
      stake,
      horizon:h,
      signalEpoch:Number(pred.signalEpoch||0),
      phase:String(pred.phase||'UNKNOWN'),
      ready:!!pred.ready,
      learningDemo:!!pred.learningDemo
    };
    rfSocket.send(JSON.stringify({
      proposal:1,
      amount:Number(stake.toFixed(2)),
      basis:'stake',
      contract_type:action==='RISE'?'CALL':'PUT',
      currency:rfCurrency||'USD',
      duration:h,
      duration_unit:'t',
      underlying_symbol:'R_75',
      req_id:++rfProposalReq
    }));
  });
}

async function reportRfDemoExperience(t,profit){
  if(!t||rfAccountType!=='demo')return;
  const id=String(t.contractId||('RF:'+t.signalEpoch+':'+t.action+':'+t.horizon));
  try{
    await fetch(CLOUD_URL+'/api/rise-fall/experience',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        id,
        mode:'demo',
        action:t.action,
        horizon:t.horizon,
        probability:t.probability,
        breakEven:t.breakEven,
        signalEpoch:t.signalEpoch,
        phase:t.phase,
        profit:Number(profit)||0
      })
    });
  }catch(_){}
}

function settleRfTrade(profit,t){
  rfSession.pnl+=profit;
  if(profit>0){
    rfSession.wins++;
    rfNextStake=Math.max(stakeBase(),Number(t?.stake||stakeBase())+profit);
  }else{
    rfSession.losses++;
    rfNextStake=stakeBase();
  }
  saveSession();
  render();
  reportRfDemoExperience(t,profit);

  if(rfSession.pnl>=target()){
    rfAuto=false;
    setText('rfStatus','TP +$'+money(target())+' · SESIÓN RISE/FALL COMPLETADA');
  }else if(rfSession.pnl<=-stopLoss()){
    rfAuto=false;
    setText('rfStatus','SL -$'+money(stopLoss())+' · SESIÓN RISE/FALL CERRADA');
  }else if(rfAuto){
    setText('rfStatus','AUTO RISE/FALL ACTIVO');
  }
}

async function evaluateAuto(pred){
  if(!selected()||!rfAuto||!pred||rfActiveContract||rfPendingProposal||rfActiveTrade)return;

  const learningDemo=!pred.ready && rfAccountType==='demo';

  if(!pred.ready && !learningDemo){
    resetConfirmation();
    setText('rfStatus','SHADOW · APRENDIENDO · REAL BLOQUEADO HASTA VALIDACIÓN');
    return;
  }

  const effectiveAction=learningDemo
    ?(pred.learningAction||pred.action||'WAIT')
    :(pred.action||'WAIT');

  if(effectiveAction!=='RISE'&&effectiveAction!=='FALL'){
    resetConfirmation();
    const p=pct(pred.directionProbability);
    const min=pct(learningDemo?pred.learningMinProbability:pred.strictMinProbability);
    setText(
      'rfStatus',
      (learningDemo?'DEMO APRENDIENDO · ':'')+
      'ESPERANDO · P '+p+' / MIN '+min
    );
    return;
  }

  const epoch=Number(pred.signalEpoch||0);
  if(!epoch||epoch===rfConfirm.lastEpoch)return;

  if(rfConfirm.action===effectiveAction){
    rfConfirm.count++;
  }else{
    rfConfirm={action:effectiveAction,count:1,lastEpoch:epoch};
  }
  rfConfirm.lastEpoch=epoch;

  // Dos lecturas bastan: queremos confirmar dirección, no congelar la IA.
  const needed=2;
  if(rfConfirm.count<needed){
    setText(
      'rfStatus',
      (learningDemo?'DEMO APRENDIENDO · ':'')+
      'CONFIRMANDO '+effectiveAction+' · '+rfConfirm.count+'/'+needed
    );
    return;
  }

  resetConfirmation();
  try{
    const tradePred={
      ...pred,
      action:effectiveAction,
      learningDemo
    };
    const out=await sendRfTrade(tradePred);
    if(out?.bought){
      setText(
        'rfStatus',
        (learningDemo?'DEMO LEARNING · ':'')+
        'ENVIANDO '+effectiveAction+' · P '+pct(pred.directionProbability)+' · BE '+pct(out.breakEven)
      );
    }else if(Number.isFinite(out?.breakEven)){
      setText(
        'rfStatus',
        'SIN COMPRA · P '+pct(pred.directionProbability)+
        ' < REQUERIDO '+pct(out.required||out.breakEven)
      );
    }
  }catch(e){
    setText('rfStatus','ERROR · '+(e?.message||e));
  }
}
async function poll(){
  try{
    const h=horizon();
    const r=await fetch(CLOUD_URL+'/api/rise-fall/prediction?h='+h+'&ts='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const data=await r.json();
    if(!data?.ok||!data.prediction)throw new Error('Sin predicción');
    rfPrediction=data.prediction;
    render();

    const epoch=Number(rfPrediction.signalEpoch||0);
    if(epoch&&epoch!==rfLastEpoch){
      rfLastEpoch=epoch;
      await evaluateAuto(rfPrediction);
    }
  }catch(e){
    setText('rfCloudMode','OFFLINE');
    setText('rfStatus','CLOUD RISE/FALL NO DISPONIBLE');
  }
}

async function startRf(){
  if(!selected())return;
  rfSession={pnl:0,wins:0,losses:0,ops:0};
  rfNextStake=stakeBase();
  resetConfirmation();
  render();

  try{
    if(!rfReady)await connectRf();
  }catch(_){
    setText('rfStatus','NO CONECTADO A DERIV');
    return;
  }

  rfAuto=true;
  if(rfPrediction?.ready){
    setText('rfStatus','AUTO RISE/FALL ACTIVO · ESPERANDO CONFIRMACIÓN');
  }else if(rfAccountType==='demo'){
    setText('rfStatus','SHADOW + DEMO · APRENDE DEL MERCADO Y DE CADA OPERACIÓN');
  }else{
    setText('rfStatus','SHADOW ACTIVO · REAL BLOQUEADO HASTA VALIDACIÓN');
  }
}

function stopRf(){
  rfAuto=false;
  resetConfirmation();
  setText('rfStatus','DETENIDO · CLOUD SIGUE APRENDIENDO');
}

function init(){
  const mode=$('strategyMode');
  mode?.addEventListener('change',applyStrategy);

  $('rfStart')?.addEventListener('click',startRf);
  $('rfStop')?.addEventListener('click',stopRf);
  $('auth')?.addEventListener('click',()=>{
    if(selected())setTimeout(()=>connectRf().catch(()=>{}),250);
  });
  $('mode')?.addEventListener('change',()=>{
    closeRfSocket();
    if(selected())setTimeout(()=>connectRf().catch(()=>{}),150);
  });

  rfNextStake=stakeBase();
  render();
  applyStrategy();
  poll();
  clearInterval(pollTimer);
  pollTimer=setInterval(poll,1200);
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
else init();
})();