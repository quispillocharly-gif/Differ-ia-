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
let rfContractSpec={
  riseType:'CALL',
  fallType:'PUT',
  minTicks:null,
  discovered:false
};
let rfEffectiveHorizon=1;

let rfAuto=false;
let rfPrediction=null;
let rfLastEpoch=0;
let rfConfirm={action:null,count:0,lastEpoch:0};
const RF_BOOTSTRAP_OPS=120;
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
function horizon(){
  const h=Math.round(val('rfHorizon',1));
  return [1,2,3,5].includes(h)?h:1;
}
function parseTickDuration(v){
  if(Number.isFinite(Number(v)))return Math.max(1,Math.round(Number(v)));
  const m=String(v||'').match(/(\d+)\s*t/i);
  return m?Math.max(1,Number(m[1])):null;
}
function effectiveHorizon(){
  const requested=horizon();
  const min=Number.isFinite(Number(rfContractSpec.minTicks))?Number(rfContractSpec.minTicks):null;
  return min?Math.max(requested,min):requested;
}
function contractTypeFor(action){
  return action==='RISE'?(rfContractSpec.riseType||'CALL'):(rfContractSpec.fallType||'PUT');
}
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
  const op=p.operationLearning||{};
  const opCount=Math.max(0,Number(op.totalOperations||0));
  const trainingDemo=$('mode')?.value==='DEMO'&&!p.operationalReady;
  const visibleAction=trainingDemo?(p.direction||p.learningAction||p.action):p.action;
  const action=visibleAction==='RISE'?'RISE ↑':visibleAction==='FALL'?'FALL ↓':'ESPERAR';
  setText('rfDecision',action);
  setText('rfProbability',pct(p.directionProbability));
  setText('rfMove',arrow+' '+(Number(p.expectedUnits)>=0?'+':'')+Number(p.expectedUnits||0).toFixed(1)+'U');
  const v=p.validation||{};
  setText('rfValidation','HIT '+pct(v.directionHitEWMA)+' · '+Number(v.resolved||0).toLocaleString()+' TESTS · OPS '+opCount.toLocaleString());
  setText(
    'rfCloudMode',
    trainingDemo
      ?('DEMO TRAINING · OPS '+opCount)
      :(p.operationalReady?'ACTIVO':'SHADOW')
  );
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
    // Preguntamos a Deriv qué contratos CALL/PUT están realmente disponibles
    // para R_75, en lugar de asumirlos a ciegas.
    try{
      rfSocket.send(JSON.stringify({contracts_for:'R_75',req_id:6001}));
    }catch(_){}
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

function applyContractsFor(data){
  const available=Array.isArray(data?.contracts_for?.available)?data.contracts_for.available:[];
  if(!available.length)return;
  const callputs=available.filter(x=>String(x?.contract_category||'').toLowerCase()==='callput'||['CALL','PUT'].includes(String(x?.contract_type||'').toUpperCase()));
  const up=callputs.find(x=>String(x?.sentiment||'').toLowerCase()==='up')||callputs.find(x=>String(x?.contract_type||'').toUpperCase()==='CALL');
  const down=callputs.find(x=>String(x?.sentiment||'').toLowerCase()==='down')||callputs.find(x=>String(x?.contract_type||'').toUpperCase()==='PUT');
  if(up?.contract_type)rfContractSpec.riseType=String(up.contract_type).toUpperCase();
  if(down?.contract_type)rfContractSpec.fallType=String(down.contract_type).toUpperCase();

  const mins=callputs
    .map(x=>parseTickDuration(x?.min_contract_duration))
    .filter(x=>Number.isFinite(x)&&x>0);
  if(mins.length)rfContractSpec.minTicks=Math.min(...mins);
  rfContractSpec.discovered=true;

  if(rfContractSpec.minTicks&&horizon()<rfContractSpec.minTicks){
    const sel=$('rfHorizon');
    if(sel&&[...sel.options].some(o=>Number(o.value)===rfContractSpec.minTicks)){
      sel.value=String(rfContractSpec.minTicks);
    }
  }
  setText(
    'rfConnState',
    rfAccountType.toUpperCase()+' CONECTADO · '+rfContractSpec.riseType+'/'+rfContractSpec.fallType+
    (rfContractSpec.minTicks?' · MIN '+rfContractSpec.minTicks+'T':'')
  );
}
function sendProposalForPending(p){
  if(!p||!rfSocket||rfSocket.readyState!==WebSocket.OPEN)return false;
  rfEffectiveHorizon=p.horizon;
  rfSocket.send(JSON.stringify({
    proposal:1,
    amount:Number(p.stake.toFixed(2)),
    basis:'stake',
    contract_type:p.contractType,
    currency:rfCurrency||'USD',
    duration:p.horizon,
    duration_unit:'t',
    underlying_symbol:'R_75',
    req_id:++rfProposalReq
  }));
  return true;
}

function onRfMessage(ev){
  let m;try{m=JSON.parse(ev.data)}catch(_){return}

  if(m.msg_type==='contracts_for'){
    applyContractsFor(m);
    return;
  }

  if(m.error){
    if(rfPendingProposal){
      const p=rfPendingProposal;
      const message=String(m.error.message||m.error.code||'Error Deriv');
      // Si el horizonte elegido no está permitido para Rise/Fall, hacemos un
      // único fallback de entrenamiento a 5 ticks y lo hacemos visible.
      const durationLike=/duration|tick|contract|available|minimum|min\b/i.test(message);
      if(p.learningDemo&&durationLike&&Number(p.horizon)<5&&Number(p.retryCount||0)<1){
        p.horizon=Math.max(5,Number(rfContractSpec.minTicks)||5);
        p.retryCount=1;
        rfPendingProposal=p;
        const sel=$('rfHorizon');
        if(sel&&[...sel.options].some(o=>Number(o.value)===p.horizon))sel.value=String(p.horizon);
        setText('rfStatus','DEMO TRAINING · AJUSTANDO CONTRATO A '+p.horizon+'T');
        sendProposalForPending(p);
        return;
      }
      rfPendingProposal=null;
      p.reject(new Error(message));
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
    const bootstrapDemo=learningDemo&&!!p.bootstrapDemo;
    const safetyMargin=.025;

    // En DEMO TRAINING no usamos el break-even como filtro de selección:
    // necesitamos observar contratos ganadores y perdedores para aprender.
    // En modo validado/REAL sí se exige superar precio + margen.
    if(!learningDemo && p.probability<breakEven+safetyMargin){
      p.resolve({bought:false,breakEven,required:breakEven+safetyMargin,learningDemo,bootstrapDemo});
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
      operationalReady:!!p.operationalReady,
      learningDemo:!!p.learningDemo,
      bootstrapDemo:!!p.bootstrapDemo,
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
    const stake=pred.learningDemo
      ?stakeBase()
      :Math.max(.01,Number(rfNextStake)||stakeBase());
    const h=effectiveHorizon();
    const p={
      resolve,reject,
      action,
      contractType:contractTypeFor(action),
      probability:clamp(pred.directionProbability,0,1),
      stake,
      horizon:h,
      requestedHorizon:horizon(),
      retryCount:0,
      signalEpoch:Number(pred.signalEpoch||0),
      phase:String(pred.phase||'UNKNOWN'),
      ready:!!pred.ready,
      operationalReady:!!pred.operationalReady,
      learningDemo:!!pred.learningDemo,
      bootstrapDemo:!!pred.bootstrapDemo
    };
    rfPendingProposal=p;
    if(!sendProposalForPending(p)){
      rfPendingProposal=null;
      reject(new Error('No pude enviar propuesta Rise/Fall'));
    }
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
  if(profit>0)rfSession.wins++;
  else rfSession.losses++;

  // Durante entrenamiento DEMO usamos stake fijo para que la IA aprenda la
  // calidad de la señal sin mezclarla con una progresión de apuesta.
  if(t?.learningDemo){
    rfNextStake=stakeBase();
  }else if(profit>0){
    rfNextStake=Math.max(stakeBase(),Number(t?.stake||stakeBase())+profit);
  }else{
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

  const opCount=Math.max(0,Number(pred.operationLearning?.totalOperations||0));
  const demo=rfAccountType==='demo';
  // La madurez del predictor SHADOW no sustituye experiencia de contratos.
  // En DEMO continúa entrenando hasta tener suficientes operaciones reales
  // y, si el predictor aún no está listo, sigue entrenando después de ese punto.
  const trainingDemo=demo&&!pred.operationalReady;

  if(!pred.operationalReady&&!demo){
    resetConfirmation();
    setText('rfStatus','SHADOW · REAL BLOQUEADO · ENTRENAMIENTO DEMO NECESARIO');
    return;
  }

  const epoch=Number(pred.signalEpoch||0);
  if(!epoch||epoch===rfConfirm.lastEpoch)return;

  // DEMO TRAINING: no filtros de entrada antes del aprendizaje.
  // Se toma la dirección que el modelo considera más probable, una operación
  // a la vez, stake base fijo, y el resultado se usa como nueva experiencia.
  if(trainingDemo){
    const action=pred.direction==='FALL'?'FALL':'RISE';
    rfConfirm.lastEpoch=epoch;
    try{
      const out=await sendRfTrade({
        ...pred,
        action,
        learningDemo:true,
        bootstrapDemo:opCount<RF_BOOTSTRAP_OPS
      });
      if(out?.bought){
        setText(
          'rfStatus',
          'DEMO TRAINING · '+action+
          ' · P '+pct(pred.directionProbability)+
          ' · '+effectiveHorizon()+'T · OPS '+opCount+
          ' · APRENDE AL CERRAR'
        );
      }else if(out?.busy){
        setText('rfStatus','DEMO TRAINING · ESPERANDO CIERRE DE OPERACIÓN');
      }
    }catch(e){
      setText('rfStatus','ERROR · '+(e?.message||e));
    }
    return;
  }

  // Modelo ya validado: aquí sí selecciona y confirma antes de comprar.
  const action=pred.action||'WAIT';
  if(action!=='RISE'&&action!=='FALL'){
    resetConfirmation();
    setText('rfStatus','MODELO VALIDADO · ESPERANDO DIRECCIÓN CON VENTAJA');
    return;
  }

  if(rfConfirm.action===action&&rfConfirm.lastEpoch===epoch-1){
    rfConfirm.count++;
  }else{
    rfConfirm={action,count:1,lastEpoch:epoch};
  }
  rfConfirm.lastEpoch=epoch;

  if(rfConfirm.count<2){
    setText('rfStatus','CONFIRMANDO '+action+' · '+rfConfirm.count+'/2');
    return;
  }

  resetConfirmation();
  try{
    const out=await sendRfTrade({...pred,action,learningDemo:false,bootstrapDemo:false});
    if(out?.bought){
      setText('rfStatus','ENVIANDO '+action+' · P '+pct(pred.directionProbability)+' · BE '+pct(out.breakEven));
    }else if(Number.isFinite(out?.breakEven)){
      setText('rfStatus','SIN COMPRA · P '+pct(pred.directionProbability)+' < REQUERIDO '+pct(out.required||out.breakEven));
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
  const ops=Math.max(0,Number(rfPrediction?.operationLearning?.totalOperations||0));
  const needsDemoTraining=rfAccountType==='demo'&&!rfPrediction?.operationalReady;
  if(needsDemoTraining){
    setText('rfStatus','DEMO TRAINING · OPERARÁ PARA APRENDER · OPS '+ops+'/'+RF_BOOTSTRAP_OPS);
  }else if(rfPrediction?.operationalReady){
    setText('rfStatus','AUTO RISE/FALL VALIDADO · ESPERANDO ENTRADA');
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