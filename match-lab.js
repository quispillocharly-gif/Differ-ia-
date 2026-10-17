'use strict';
// Laboratorio MATCH/D IFFER en modo observación: NO envía propuestas ni compras.
// Uso: node match-lab.js ticks.json
// JSON: {"R_75":[0,1,2,...],"R_50":[...]} o array de {symbol,digit}.
const fs=require('node:fs');
const raw=JSON.parse(fs.readFileSync(process.argv[2]||'ticks.json','utf8'));
const groups=Array.isArray(raw)?Object.groupBy(raw,x=>x.symbol):raw;
const results=[];
for(const [symbol,entries] of Object.entries(groups)){
  const digits=entries.map(x=>Number(typeof x==='object'?x.digit:x)).filter(x=>Number.isInteger(x)&&x>=0&&x<=9);
  if(digits.length<220)continue;
  const policies=[
    {name:'frequency_50',window:50},
    {name:'frequency_100',window:100},
    {name:'frequency_180',window:180}
  ];
  for(const policy of policies){
    const counts={match:0,differ:0,total:0};
    const perDigit=Array.from({length:10},(_,digit)=>({digit,match:0,total:0}));
    for(let i=200;i<digits.length-1;i++){
      const hist=digits.slice(i-policy.window,i),frequency=Array(10).fill(0);
      hist.forEach(d=>frequency[d]++);
      const matchPick=frequency.indexOf(Math.max(...frequency));
      const differPick=frequency.indexOf(Math.min(...frequency));
      const actual=digits[i+1]; // predicción de 1 tick futuro, sin fuga temporal
      counts.total++;
      counts.match+=Number(matchPick===actual);
      counts.differ+=Number(differPick!==actual);
      perDigit[matchPick].total++;
      perDigit[matchPick].match+=Number(matchPick===actual);
    }
    const wilson=(wins,n)=>{if(!n)return [0,1];const z=1.96,p=wins/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;return [c-m,c+m]};
    results.push({symbol,policy:policy.name,samples:counts.total,
      matchRate:counts.match/counts.total,match95CI:wilson(counts.match,counts.total),
      differRate:counts.differ/counts.total,differ95CI:wilson(counts.differ,counts.total),
      perDigit:perDigit.map(x=>({...x,rate:x.total?x.match/x.total:null}))});
  }
}
process.stdout.write(JSON.stringify({mode:'SHADOW_ONLY',note:'Sin compras. Tasas observadas, no garantía futura. MATCH esperado ~10% y DIFFER ~90% bajo dígitos uniformes.',results},null,2)+'\n');
