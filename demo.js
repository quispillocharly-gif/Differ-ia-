(()=>{
  let socket=null,ready=false,currency='USD',accountId=null,accountType='demo',busy=false,pingInterval=null;
  let proposalReq=1000,buyReq=2000;
  const $=x=>document.getElementById(x);
  const set=(s)=>{$('authStatus').textContent=s};
  const errMsg=(j,fallback)=>j?.errors?.[0]?.message||j?.error?.message||fallback;

  async function api(path,opts={}){
    const pat=$('pat').value.trim(),app=$('app').value.trim();
    const r=await fetch('https://api.derivws.com'+path,{...opts,headers:{'Authorization':'Bearer '+pat,'Deriv-App-ID':app,'Content-Type':'application/json',...(opts.headers||{})}});
    let j={};try{j=await r.json()}catch(_){}
    if(!r.ok)throw new Error(errMsg(j,'HTTP '+r.status));return j;
  }

  function startKeepAlive(){
    clearInterval(pingInterval);
    pingInterval=setInterval(()=>{
      if(socket&&socket.readyState===WebSocket.OPEN){
        socket.send(JSON.stringify({ping:1}));
      }
    },20000);
  }

  async function connectDeriv(){
    if(busy)return;busy=true;ready=false;window.demoReady=false;set('CONECTANDO…');
    const targetMode=$('mode').value==='REAL'?'real':'demo';
    try{
      const pat=$('pat').value.trim(),app=$('app').value.trim();
      if(!pat||!app)throw new Error('Falta App ID o PAT');

      const a=await api('/trading/v1/options/accounts',{method:'GET'});
      const rows=Array.isArray(a.data)?a.data:(a.data?[a.data]:[]);

      const acc=rows.find(x=>String(x.account_type||'').toLowerCase()===targetMode&&String(x.status||'active').toLowerCase()==='active');
      if(!acc)throw new Error(`No encontré una cuenta Options ${targetMode.toUpperCase()} activa`);

      accountId=acc.account_id;
      accountType=targetMode;
      currency=acc.currency||'USD';

      const o=await api('/trading/v1/options/accounts/'+encodeURIComponent(accountId)+'/otp',{method:'POST'});
      const url=o?.data?.url;
      if(!url)throw new Error('Deriv no devolvió URL OTP');

      if(targetMode==='demo'&&!/\/ws\/demo\?otp=/i.test(url)){
        throw new Error('BLOQUEADO: La cuenta seleccionada no es DEMO');
      }
      if(targetMode==='real'&&!/\/ws\/real\?otp=/i.test(url)){
        throw new Error('BLOQUEADO: La cuenta seleccionada no es REAL');
      }

      if(socket)try{socket.close()}catch(_){}
      socket=new WebSocket(url);

      socket.onopen=()=>{
        ready=true;
        window.demoReady=true;
        window.currentAccountType=accountType;
        set(`${accountType.toUpperCase()} CONECTADO · ${accountId}`);
        busy=false;
        startKeepAlive();
      };
      socket.onerror=()=>{
        ready=false;
        window.demoReady=false;
        set('ERROR WEBSOCKET');
        busy=false;
      };
      socket.onclose=()=>{
        ready=false;
        window.demoReady=false;
        clearInterval(pingInterval);
        if($('authStatus').textContent.includes('CONECTADO'))set('DERIV DESCONECTADO');
      };
      socket.onmessage=onMessage;
    }catch(e){
      busy=false;ready=false;window.demoReady=false;
      set('ERROR · '+e.message);
    }
  }

  let pendingProposal=null,activeContract=null,settled=new Set();

  function onMessage(ev){
    let m;try{m=JSON.parse(ev.data)}catch(_){return}
    if(m.error){
      if(pendingProposal){
        let rej=pendingProposal.reject;
        pendingProposal=null;
        rej(new Error(m.error.message||'Error Deriv'));
      }else{
        window.demoTradeError?.(new Error(m.error.message||'Error Deriv'));
      }
      return;
    }
    if(m.msg_type==='proposal'&&pendingProposal){
      const p=pendingProposal;pendingProposal=null;
      const id=m.proposal?.id,ask=Number(m.proposal?.ask_price);
      if(!id||!Number.isFinite(ask)){p.reject(new Error('Propuesta inválida'));return}
      socket.send(JSON.stringify({buy:id,price:ask,req_id:++buyReq}));
      p.resolve();
    }
    if(m.msg_type==='buy'&&m.buy?.contract_id){
      activeContract=m.buy.contract_id;
      set(`${accountType.toUpperCase()} CONECTADO · ${accountId} · CONTRATO ${activeContract}`);
      socket.send(JSON.stringify({proposal_open_contract:1,contract_id:activeContract,subscribe:1,req_id:3001}));
    }
    if(m.msg_type==='proposal_open_contract'&&m.proposal_open_contract){
      const c=m.proposal_open_contract,id=c.contract_id;
      if(c.is_sold&&!settled.has(id)){
        settled.add(id);
        activeContract=null;
        const profit=Number(c.profit);
        window.demoSettlement?.(profit);
        set(`${accountType.toUpperCase()} CONECTADO · ${accountId}`);
        if(m.subscription?.id)socket.send(JSON.stringify({forget:m.subscription.id}));
      }
    }
  }

  window.sendDemoTrade=(digit,stake)=>new Promise((resolve,reject)=>{
    if(!ready||!socket||socket.readyState!==WebSocket.OPEN){
      reject(new Error('Deriv no conectado'));
      return;
    }
    if(activeContract||pendingProposal){
      reject(new Error('Ya existe una operación en curso'));
      return;
    }
    digit=Number(digit);stake=Number(stake);
    if(!Number.isInteger(digit)||digit<0||digit>9||!Number.isFinite(stake)||stake<=0){
      reject(new Error('Parámetros inválidos'));
      return;
    }
    pendingProposal={resolve,reject};
    socket.send(JSON.stringify({
      proposal:1,
      amount:Number(stake.toFixed(2)),
      basis:'stake',
      contract_type:'DIGITDIFF',
      currency:currency||'USD',
      barrier:String(digit),
      duration:1,
      duration_unit:'t',
      underlying_symbol:'R_75',
      req_id:++proposalReq
    }));
  });

  $('auth').onclick=connectDeriv;
  window.demoReady=false;
})();