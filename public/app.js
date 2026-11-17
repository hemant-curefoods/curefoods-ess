
// Employee rows seen by this browser (only the signed-in employee; the server never sends the master).
var EMPLOYEE_MASTER = [];
// ===================== CONFIG =====================
// All data comes from the Node.js API on the same server.
var CONFIG = { API_URL: '/api' };
var LIVE = !!CONFIG.API_URL;
var MAX_FAILS = 5, LOCK_MIN = 30;

function $(id){ return document.getElementById(id); }
function toast(m){ var t=$('toast'); t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(function(){t.classList.remove('show');},4000); }
function err(id,msg){ var e=$(id); e.textContent=msg||''; e.classList.toggle('show',!!msg); }
var STEPS=['stepId','stepPin','stepDob','stepSet','stepForgot'];
function show(step){ STEPS.forEach(function(x){ $(x).hidden = x!==step; }); document.querySelector('.login-alt').hidden = step!=='stepId';
  [].forEach.call(document.querySelectorAll('.js-emp'),function(e){ e.textContent=s.empCode||''; });
  var first = $(step).querySelector('input'); if(first) setTimeout(function(){ first.focus(); },30); }
function mask(m){ m=String(m).replace(/\D/g,''); return '+91 ••••• •'+m.slice(-4); }
function busy(btn,on,label){ btn.disabled=on; if(label) btn.textContent=label; }
function lookup(code){
  code = String(code||'').trim().toUpperCase();
  return EMPLOYEE_MASTER.filter(function(r){ return r['Employee Code'].toUpperCase()===code; })[0] || null;
}
var s = {empCode:'', setupToken:null};

// ---- 4-box PIN inputs ----
function buildPins(){
  [].forEach.call(document.querySelectorAll('[data-pins]'),function(row){
    row.innerHTML = '<input type="password" inputmode="numeric" maxlength="1" autocomplete="off">'.repeat(4);
    var boxes=[].slice.call(row.querySelectorAll('input'));
    boxes.forEach(function(b,i){
      b.addEventListener('input',function(){
        var v=b.value.replace(/\D/g,'');
        if(v.length>1){ v.split('').slice(0,4-i).forEach(function(d,k){ boxes[i+k].value=d; }); boxes[Math.min(i+v.length,3)].focus(); return; }
        b.value=v;
        if(v && boxes[i+1]) boxes[i+1].focus();
        else if(v && i===3){ var nextRow=row.closest('.lfield').nextElementSibling; var n=nextRow&&nextRow.querySelector('[data-pins] input'); if(n) n.focus(); }
      });
      b.addEventListener('keydown',function(e){
        if(e.key==='Backspace'&&!b.value&&boxes[i-1]) boxes[i-1].focus();
        if(e.key==='Enter'){ var btn=row.closest('[id^=step]').querySelector('.lbtn:not(.ghost)'); if(btn) btn.click(); }
      });
    });
  });
}
function pinVal(name){ return [].map.call(document.querySelectorAll('[data-pins="'+name+'"] input'),function(b){return b.value;}).join(''); }
function clearPins(name){ [].forEach.call(document.querySelectorAll(name?'[data-pins="'+name+'"] input':'[data-pins] input'),function(b){ b.value=''; }); }
buildPins();

function weakPin(pin, dob){
  if(!/^\d{4}$/.test(pin)) return 'PIN must be 4 digits.';
  if(/^(\d)\1{3}$/.test(pin)) return 'Avoid repeating digits like 1111.';
  if('0123456789'.indexOf(pin)!==-1 || '9876543210'.indexOf(pin)!==-1) return 'Avoid sequences like 1234.';
  if(dob){ var y=dob.slice(0,4), m=dob.slice(5,7), d=dob.slice(8,10);
    if(pin===y || pin===d+m || pin===m+d) return 'Don’t use your birth year or birthday as your PIN.'; }
  return '';
}

// ===================== AUTH LAYER =====================
// Same promise-based interface for demo and live, so the UI never changes.
var NAMES = {};   // employee code -> name, filled from API responses
function api(payload){
  return fetch(CONFIG.API_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin'})
    .then(function(r){ return r.json().catch(function(){ return {ok:false, error:'Server error ('+r.status+').'}; }); })
    .then(function(r){
      if(r && r.names) for(var k in r.names) NAMES[k]=r.names[k];
      if(r && r.expired && me){ toast('Your session has expired. Please sign in again.'); setTimeout(signOut,0); }
      return r;
    });
}
var LiveAuth = {
  start:function(code){ return api({action:'start', empCode:code}); },
  loginPin:function(code,pin){ return api({action:'loginPin', empCode:code, pin:pin}).then(keepSession); },
  verifyDob:function(code,dob){ return api({action:'verifyDob', empCode:code, dob:dob}); },
  setPin:function(token,pin){ return api({action:'setPin', setupToken:token, pin:pin}).then(keepSession); },
  changePin:function(code,oldPin,newPin){ return api({action:'changePin', session:session(), oldPin:oldPin, newPin:newPin}); },
  status:function(code){ return api({action:'pinStatus', session:session(), empCode:code}); },
  resetPin:function(byCode,code){ return api({action:'resetPin', session:session(), empCode:code}); }
};
function session(){ try{ return sessionStorage.getItem('cf_session'); }catch(e){ return null; } }
function keepSession(r){ if(r && r.ok && r.session){ try{ sessionStorage.setItem('cf_session', r.session); }catch(e){} } return r; }
var Auth = LiveAuth;
function netFail(id){ return function(){ err(id,'Could not reach the server. Check your connection and try again.'); }; }
function enter(emp){
  if(LIVE){ var local=lookup(emp['Employee Code']); if(local){ for(var k in emp) local[k]=emp[k]; emp=local; } else EMPLOYEE_MASTER.push(emp); }
  startApp(emp);
}

// ===================== LOGIN UI =====================
$('continueBtn').onclick = function(){
  var code=$('empIdInput').value.trim().toUpperCase(); err('idError');
  if(!code) return err('idError','Enter your Employee ID.');
  var btn=$('continueBtn'); busy(btn,true,'Checking…');
  Auth.start(code).then(function(r){
    if(!r.ok) return err('idError', r.error);
    s.empCode=code; clearPins(); $('dobInput').value=''; ['pinError','dobError','setError'].forEach(function(x){ err(x); });
    show(r.hasPin ? 'stepPin' : 'stepDob');
  }).catch(netFail('idError')).then(function(){ busy(btn,false,'Continue'); });
};
$('empIdInput').addEventListener('keydown',function(e){ if(e.key==='Enter') $('continueBtn').click(); });

$('pinBtn').onclick = function(){
  var pin=pinVal('pin'); err('pinError');
  if(pin.length!==4) return err('pinError','Enter your 4-digit PIN.');
  var btn=$('pinBtn'); busy(btn,true,'Signing in…');
  Auth.loginPin(s.empCode,pin).then(function(r){
    if(r.ok) return enter(r.employee);
    clearPins('pin');
    err('pinError', r.error || ('Incorrect PIN. '+r.left+' attempt'+(r.left===1?'':'s')+' left before the ID is locked.'));
  }).catch(netFail('pinError')).then(function(){ busy(btn,false,'Sign in'); });
};

$('dobBtn').onclick = function(){
  var dob=$('dobInput').value; err('dobError');
  if(!dob) return err('dobError','Select your date of birth.');
  var btn=$('dobBtn'); busy(btn,true,'Verifying…');
  Auth.verifyDob(s.empCode,dob).then(function(r){
    if(!r.ok) return err('dobError', r.error || ('That doesn’t match your HR record. '+r.left+' attempt'+(r.left===1?'':'s')+' left. If your date of birth is wrong in HR records, contact your HR partner.'));
    s.setupToken=r.setupToken; s.dob=dob; clearPins(); show('stepSet');
  }).catch(netFail('dobError')).then(function(){ busy(btn,false,'Verify'); });
};

$('setBtn').onclick = function(){
  var a=pinVal('new'), b=pinVal('confirm'); err('setError');
  if(a.length!==4) return err('setError','Enter a 4-digit PIN.');
  if(a!==b){ clearPins('confirm'); return err('setError','The two PINs don’t match.'); }
  var w=weakPin(a, s.dob); if(w){ clearPins(); return err('setError', w); }
  var btn=$('setBtn'); busy(btn,true,'Saving…');
  Auth.setPin(s.setupToken,a).then(function(r){
    if(!r.ok) return err('setError', r.error);
    s.setupToken=null; toast('PIN set. Use it with your Employee ID next time.'); enter(r.employee);
  }).catch(netFail('setError')).then(function(){ busy(btn,false,'Set PIN & sign in'); });
};

$('forgotBtn').onclick = function(){ show('stepForgot'); };
$('forgotBackBtn').onclick = function(){ show('stepId'); };
[].forEach.call(document.querySelectorAll('.js-back'),function(b){ b.onclick=function(){ s.setupToken=null; show('stepId'); }; });
$('modeHint').innerHTML = '';

[].forEach.call(document.querySelectorAll('.alt-btn'),function(b){ b.onclick=function(){ toast('Coming soon in the new build.'); }; });

var ICON_OFFER = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3.5H7.2c-.9 0-1.7.8-1.7 1.7v13.6c0 .9.8 1.7 1.7 1.7h9.6c.9 0 1.7-.8 1.7-1.7V8z"/><path d="M14 3.5V8h4.5"/><path d="M8.8 12.5h6.4M8.8 15.8h4"/><circle cx="15.6" cy="16.6" r="0" /></svg>';
var ICON_PROFILE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.3" r="3.8"/><path d="M4.6 20c.9-3.6 3.9-5.7 7.4-5.7s6.5 2.1 7.4 5.7"/></svg>';

function profileHTML(){
  var e=me;
  function v(k,fmtFn){ var x=e[k]; if(x==null||x==='') return '—'; return esc(fmtFn?fmtFn(x):x); }
  function sect(title, pairs){
    return '<div class="psec"><div class="sec-h" style="border:none;margin-top:0;padding-top:0">'+title+'</div><div class="kv">'+
      pairs.map(function(p){ return '<div><span>'+p[0]+'</span><b>'+p[1]+'</b></div>'; }).join('')+'</div></div>';
  }
  var initials = String(e['Employee Name']).split(' ').map(function(w){return w.charAt(0);}).join('').slice(0,2).toUpperCase();
  var mgrCode = e['L1 Manager Code'];
  return '<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>My Profile</h2></div>'+
    '<div class="panel phead"><div class="avatar">'+esc(initials)+'</div><div><h3>'+esc(e['Employee Name'])+'</h3>'+
      '<p>'+v('Designation')+' · '+v('Department')+'</p><p class="mono">'+esc(e['Employee Code'])+' · '+v('Employment Status')+'</p></div></div>'+
    '<div class="panel" style="margin-top:12px">'+
      sect('Job details',[['Portal access',esc((ROLE_LABEL[e['Role']]||'Employee')+(e['Is Admin']?' + Admin':''))],['Company',v('Company')],['Entity',v('Entity')],['Department',v('Department')],['Designation',v('Designation')],['Grade / Band',(e['Grade']||'—')+' / '+(e['Band']||'—')],['Management level',v('Management Level')],['Employment type',v('Employment Type')],['Date of joining',v('Date of Joining',dLong)],['Confirmation',v('Confirmation Status')],['Notice period',v('Notice Period')]])+
      sect('Location',[['Base location',v('Base location (Office)')],['State',v('State')]])+
      sect('Reporting',[['L1 manager',v('L1 Manager')+(mgrCode?' <span class="mono">('+esc(mgrCode)+')</span>':'')],['L2 manager',v('L2 Manager')],['HR partner',v('HR Manager')]])+
      sect('Personal',[['Date of birth',v('Date Of Birth',dLong)],['Gender',v('Gender')],['Blood group',v('BloodGroup')]])+
      sect('Contact',[['Mobile',e['Mobile Number']?mask(digits(e['Mobile Number'])):'—'],['Office email',v('Office Email Address')],['Personal email',v('Personal Email Address')]])+
    '</div>'+
    '<div class="note" style="margin-top:12px">Something wrong or out of date? HR updates the Employee Master — <a href="#" data-raise="Letters & Documents">raise a ticket</a> with the correction. Bank, PAN and Aadhaar details are never shown in the portal.</div>'+
    '<button class="btn sec" id="changePinBtn" style="width:100%;margin-top:16px;padding:12px">Change PIN</button>'+
    '<button class="btn signout" id="signOutBtn" style="margin-top:8px">Sign out</button>';
}

// ===================== OFFER LETTERS + PAYSLIPS (documents) =====================
// Demo rows below use the SAME column names as the real sheets, with made-up values:
//   Offer Letter Automation – HR Master  -> tab "Offer Log"
//   Payslip System - NAPS                -> tab "Payroll"
// In live mode the backend (Code.gs) reads those sheets and returns only the logged-in employee's rows.
function digits(s){ return String(s||'').replace(/\D/g,'').slice(-10); }
function isoDate(s){ var m=String(s||'').match(/^(\d{4}-\d{2}-\d{2})/); return m?m[1]:String(s||''); }
function dLong(iso){ if(!iso) return '—'; var d=new Date(String(iso).slice(0,10)+'T00:00:00'); return isNaN(d)?String(iso):d.toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}); }
function inr(n){ var x=Number(n)||0; return '₹'+x.toLocaleString('en-IN',{maximumFractionDigits:2}); }
function num(v){ var x=parseFloat(String(v==null?'':v).replace(/,/g,'')); return isNaN(x)?0:x; }

var MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
function slipKey(x){ return x['Pay Year']+'-'+('0'+(MONTHS.indexOf(String(x['Pay Month']).trim())+1)).slice(-2); }

// ---- data layer: same interface for demo and live ----
var Docs = {
  offers:function(){
    return api({action:'myOffers', session:session()});
  },
  payslips:function(){
    return api({action:'myPayslips', session:session()});
  },
  pdf:function(kind,id){
    return api({action: kind==='offer'?'offerPdf':'payslipPdf', session:session(), id:id});
  }
};
var docCache = {who:null, offers:null, slips:null};
function cacheFor(){ if(docCache.who!==myCode()){ docCache={who:myCode(), offers:null, slips:null}; } return docCache; }
function loadInto(key, fn){
  var c=cacheFor(); if(c[key]) return c[key];
  c[key]={loading:true};
  fn().then(function(r){ c[key]= r.ok ? {items:r.items||[]} : {error:r.error||'Could not load.'}; })
      .catch(function(){ c[key]={error:'Could not reach the server.'}; })
      .then(function(){ if(docCache===c) render(); });
  return c[key];
}
var LOADING_HTML='<div class="empty">Loading…</div>';

function openPdf(kind,id,title){
  modal('<h4>'+esc(title)+'</h4><p>Loading document…</p>', null);
  Docs.pdf(kind,id).then(function(r){
    if(!r.ok){ modal('<h4>'+esc(title)+'</h4><p>'+esc(r.error||'Could not open the document.')+'</p><div class="row"><button class="btn sec" id="mCancel">Close</button></div>',function(){ $('mCancel').onclick=closeModal; }); return; }
    var bin=atob(r.base64), arr=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    var url=URL.createObjectURL(new Blob([arr],{type:'application/pdf'}));
    modal('<h4>'+esc(title)+'</h4><iframe src="'+url+'" style="width:100%;height:65vh;border:1px solid var(--line);border-radius:8px"></iframe>'+
      '<div class="row" style="margin-top:12px"><a class="btn sec" href="'+url+'" target="_blank" rel="noopener" style="text-decoration:none">Open in new tab</a><button class="btn" id="mCancel">Close</button></div>',function(){ $('mCancel').onclick=closeModal; });
  }).catch(function(){ toast('Could not reach the server.'); closeModal(); });
}

// ---- Offer letters ----
function offerListHTML(){
  var h='<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>Offer Letter</h2></div>';
  h+='<div class="note">Matched to the mobile number <b>'+mask(digits(me['Mobile Number']))+'</b> and date of birth on your HR record.</div>';
  var st=loadInto('offers', Docs.offers);
  if(st.loading) return h+LOADING_HTML;
  if(st.error) return h+'<div class="empty">'+esc(st.error)+'</div>';
  var rows=st.items.slice().sort(function(a,b){ return String(b['Generated On']).localeCompare(String(a['Generated On'])); });
  if(!rows.length) return h+'<div class="empty">No offer letter matched your mobile number and date of birth. This usually happens if your number changed after the offer was issued, or the letter was issued before the online tool.<br><br><button class="btn" data-raise="Letters & Documents">Request it from HR</button></div>';
  return h+'<div class="tlist">'+rows.map(function(o,i){
    return '<button class="trow" data-offer="'+esc(o.id)+'"><div><div class="id">'+esc(o['Letter Type'])+'</div><div class="cat">'+esc(o['Designation'])+'</div></div>'+
      '<span class="pill '+(i===0?'closed':'open')+'">'+(i===0?'Latest':'Earlier')+'</span>'+
      '<div class="desc">'+esc(o['Kitchen Location']||'')+(o['State']?', '+esc(o['State']):'')+'</div>'+
      '<div class="meta">Issued '+dLong(o['Generated On'])+' · Joining '+dLong(o['Date of Joining'])+'</div></button>';
  }).join('')+'</div>';
}
function offerViewHTML(){
  var h='<div class="crumb"><button class="iconbtn" data-go="offer">'+ICON_BACK+'</button><h2>Offer Letter</h2></div>';
  var st=cacheFor().offers; var o=st&&st.items&&st.items.filter(function(x){return x.id===ui.offerRef;})[0];
  if(!o) return h+'<div class="empty">Letter not found.</div>';
  var dbt=num(o['DBT Amount']);
  return h+'<div class="panel"><div class="dhead"><div><div class="id">'+esc(o['Letter Type'])+'</div><h3>'+esc(o['Designation'])+'</h3></div><span class="pill closed">Issued</span></div>'+
    '<div class="kv">'+
      '<div><span>Name on letter</span><b>'+esc(o['Employee Name'])+'</b></div>'+
      '<div><span>Issued on</span><b>'+dLong(o['Generated On'])+'</b></div>'+
      '<div><span>Date of joining</span><b>'+dLong(o['Date of Joining'])+'</b></div>'+
      '<div><span>Location</span><b>'+esc(o['Kitchen Location']||'—')+'</b></div>'+
      '<div><span>State</span><b>'+esc(o['State']||'—')+'</b></div>'+
      '<div><span>Reporting manager</span><b>'+esc(o['Manager Name']||'—')+'</b></div>'+
      '<div><span>'+(/naps|loi/i.test(o['Letter Type'])?'Monthly stipend':'Net monthly salary')+'</span><b>'+inr(o['Net Salary'])+'</b></div>'+
      (dbt?'<div><span>Govt DBT share</span><b>'+inr(dbt)+'</b></div>':'')+
    '</div>'+
    '<button class="btn" id="openOfferPdf" style="width:100%;padding:12px">View offer letter (PDF)</button></div>';
}

// ---- Payslips (NAPS register today; entity payroll sheets can be added as more sources) ----
var ICON_SLIP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="3.5" width="15" height="17" rx="1.8"/><path d="M8.5 8h7M8.5 11.5h7"/><path d="M10 14.8h2.6a1.3 1.3 0 0 1 0 2.6H10.6"/><path d="M10 14.8c1.8 0 2.4 1 2.4 1.6"/></svg>';
// Mirrors the "NAPS Payslip Template" Google Doc: earnings, deductions, establishment share, DBT.
function slipCalc(x){
  var earn=[['Basic Stipend (Earned)',x['Basic Stipend']],['Arrear Stipend',x['Arrear Stipend']],['Additional Stipend',x['Additional Stipend']],['Referral Pay',x['Referral Pay']],['Other Allowance',x['Other Allowance']]]
    .map(function(p){ return [p[0],num(p[1])]; }).filter(function(p,i){ return p[1] || i<2; });
  var ded=[['Advance Recovery',x['Advance Recovery']],['Other Deductions',x['Other Deduction']]].map(function(p){ return [p[0],num(p[1])]; });
  var g=earn.reduce(function(a,p){return a+p[1];},0), d=ded.reduce(function(a,p){return a+p[1];},0);
  return {earn:earn, ded:ded, gross:g, deductions:d, net:g-d, dbt:num(x['DBT Payable'])};
}
function payslipListHTML(){
  var h='<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>Payslips</h2></div>';
  var st=loadInto('slips', Docs.payslips);
  if(st.loading) return h+LOADING_HTML;
  if(st.error) return h+'<div class="empty">'+esc(st.error)+'</div>';
  var rows=st.items.slice().sort(function(a,b){ return slipKey(b).localeCompare(slipKey(a)); });
  if(!rows.length) return h+'<div class="empty">No payslips are published for your Employee ID yet. NAPS stipend slips appear here once payroll generates them; regular salary payslips will be added next.<br><br><button class="btn" data-raise="Payroll & Salary">Ask HR about a payslip</button></div>';
  return h+'<div class="note">'+esc(rows[0]['Entity']||'')+(rows[0]['Apprenticeship Code']?' · Apprenticeship code <b>'+esc(rows[0]['Apprenticeship Code'])+'</b>':'')+'</div><div class="tlist">'+rows.map(function(x){
    var c=slipCalc(x);
    return '<button class="trow" data-slip="'+esc(x.id)+'"><div><div class="id">'+esc(slipKey(x))+'</div><div class="cat">'+esc(x['Pay Month'])+' '+esc(x['Pay Year'])+'</div></div>'+
      '<span class="pill closed">'+inr(c.net)+'</span><div class="meta">'+num(x['Days Present'])+' of '+num(x['Days in Month'])+' days'+(num(x['LOP Days'])?' · '+num(x['LOP Days'])+' LOP':'')+(c.dbt?' · DBT '+inr(c.dbt):'')+'</div></button>';
  }).join('')+'</div>';
}
function payslipViewHTML(){
  var h='<div class="crumb"><button class="iconbtn" data-go="payslips">'+ICON_BACK+'</button><h2>Payslip</h2></div>';
  var st=cacheFor().slips; var x=st&&st.items&&st.items.filter(function(s){return s.id===ui.slipMonth;})[0];
  if(!x) return h+'<div class="empty">Payslip not found.</div>';
  var c=slipCalc(x), lop=num(x['LOP Days']), dim=num(x['Days in Month']), present=num(x['Days Present']);
  function row(a,b,cls){ return '<tr'+(cls?' class="'+cls+'"':'')+'><td>'+a+'</td><td>'+b+'</td></tr>'; }
  return h+'<div class="letter slip">'+
    '<div class="lh"><img src="'+document.querySelector('.topbar .mark img').src+'" alt="Curefoods"><div>'+esc(x['Entity'])+'<br><span>Stipend Slip for NAPS Apprentice \u2014 '+esc(x['Pay Month'])+' '+esc(x['Pay Year'])+'</span></div></div>'+
    '<div class="sec-t">Trainee / Apprentice details</div>'+
    '<div class="kv">'+
      '<div><span>Name</span><b>'+esc(x['Name'])+'</b></div><div><span>Training scheme</span><b>NAPS</b></div>'+
      '<div><span>Trainee designation</span><b>'+esc(x['Designation']||'\u2014')+'</b></div><div><span>Curefoods ID</span><b>'+esc(x['Employee ID'])+'</b></div>'+
      '<div><span>Company name</span><b>'+esc(x['Entity']||'\u2014')+'</b></div><div><span>Training location</span><b>'+esc(x['Location']||'\u2014')+'</b></div>'+
      (x['Apprenticeship Code']?'<div><span>Apprenticeship code</span><b>'+esc(x['Apprenticeship Code'])+'</b></div>':'')+
    '</div>'+
    '<div class="sec-t">Attendance summary</div>'+
    '<div class="att"><div><b>'+dim+'</b><span>Days in month</span></div><div><b>'+present+'</b><span>Days present</span></div><div><b>'+lop+'</b><span>LOP days</span></div><div><b>'+Math.max(0,dim-lop)+'</b><span>Payable days</span></div></div>'+
    (num(x['Fixed Stipend'])?'<div class="sec-t">Fixed stipend</div><table class="stbl"><tbody>'+row('Fixed Stipend',inr(x['Fixed Stipend']))+'</tbody></table>':'')+
    '<div class="sec-t">Earnings</div><table class="stbl"><tbody>'+
      c.earn.map(function(p){ return row(p[0],inr(p[1])); }).join('')+row('Gross Earnings',inr(c.gross),'sub')+
    '</tbody></table>'+
    '<div class="sec-t">Deductions</div><table class="stbl"><tbody>'+
      c.ded.map(function(p){ return row(p[0],inr(p[1])); }).join('')+row('Total Deductions',inr(c.deductions),'sub')+
    '</tbody></table>'+
    '<table class="stbl" style="margin-top:10px"><tbody>'+
      row('Establishment Stipend Share',inr(c.net),'tot')+
      row('DBT Contribution (Government Scheme)',inr(c.dbt))+
    '</tbody></table>'+
    '<p class="sfoot">The DBT contribution is paid directly to your bank account by the government under NAPS and may arrive on a different date. This is a system-generated stipend statement for apprentices engaged under the National Apprenticeship Promotion Scheme (NAPS).</p>'+
  '</div>'+
  '<button class="btn" id="openSlipPdf" style="width:100%;padding:12px;margin-top:12px">View payslip PDF</button>';
}

// ===================== PIN MANAGEMENT (HR reset + self change) =====================
var ICON_KEY = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 19 4"/><path d="M16 7l2.5 2.5"/><path d="M14 9l2 2"/></svg>';
function pinResetHTML(){
  return '<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>PIN Reset</h2></div>'+
    '<div class="panel"><div class="note">Reset an employee’s PIN when they’ve forgotten it or their ID is locked. On their next sign-in they verify their date of birth and set a new PIN. Every reset is logged with your name.</div>'+
    '<div class="f"><label>Employee ID</label><div style="display:flex;gap:8px"><input id="prId" placeholder="CFD90001" autocapitalize="characters" style="flex:1"><button class="btn" id="prFind">Find</button></div></div>'+
    '<p class="lerror" id="prErr"></p><div id="prResult"></div></div>';
}
function bindPinReset(){
  function find(){
    err('prErr'); $('prResult').innerHTML='';
    var code=$('prId').value.trim().toUpperCase(); if(!code) return err('prErr','Enter an Employee ID.');
    Auth.status(code).then(function(r){
      if(!r.ok) return err('prErr', r.error||'Not found.');
      var e=r.employee;
      var state = r.locked ? '<span class="pill over">Locked</span>' : r.hasPin ? '<span class="pill closed">PIN set</span>' : '<span class="pill open">No PIN yet</span>';
      $('prResult').innerHTML = '<div class="trow" style="cursor:default;margin-top:6px"><div><div class="id">'+esc(e['Employee Code'])+'</div><div class="cat">'+esc(e['Employee Name'])+'</div></div>'+state+
        '<div class="desc">'+esc(e['Designation']||'')+' · '+esc(e['Base location (Office)']||'')+'</div>'+
        '<div class="meta">'+(r.pinSetOn?'PIN set '+fmt(r.pinSetOn):'Has not set a PIN')+(r.resetOn?' · last reset '+fmt(r.resetOn)+' by '+esc(nameOf(r.resetBy)):'')+'</div></div>'+
        (r.hasPin||r.locked ? '<button class="btn" id="prReset" style="margin-top:12px">Reset PIN</button>' : '<p class="help" style="font-size:12px;color:var(--ink-faint);margin-top:10px">Nothing to reset — they’ll set a PIN on first sign-in using their date of birth.</p>');
      if($('prReset')) $('prReset').onclick=function(){
        modal('<h4>Reset PIN for '+esc(e['Employee Name'])+'?</h4><p>Confirm you’ve verified this request with the employee (call or in person). Their current PIN stops working immediately.</p>'+
          '<div class="row"><button class="btn sec" id="mCancel">Cancel</button><button class="btn" id="mOk">Reset PIN</button></div>', function(){
          $('mCancel').onclick=closeModal;
          $('mOk').onclick=function(){ Auth.resetPin(myCode(), e['Employee Code']).then(function(x){ closeModal(); if(!x.ok) return toast(x.error||'Could not reset'); toast('PIN reset for '+e['Employee Name']); find(); }); };
        });
      };
    }).catch(function(){ err('prErr','Could not reach the server.'); });
  }
  $('prFind').onclick=find;
  $('prId').addEventListener('keydown',function(ev){ if(ev.key==='Enter') find(); });
}
function openChangePin(){
  if(readOnly()) return;
  modal('<h4>Change PIN</h4><p>Enter your current PIN, then a new 4-digit PIN.</p>'+
    '<div class="f"><label>Current PIN</label><input id="cpOld" type="password" inputmode="numeric" maxlength="4"></div>'+
    '<div class="f"><label>New PIN</label><input id="cpNew" type="password" inputmode="numeric" maxlength="4"></div>'+
    '<div class="f"><label>Confirm new PIN</label><input id="cpNew2" type="password" inputmode="numeric" maxlength="4"></div>'+
    '<p class="lerror" id="cpErr"></p><div class="row"><button class="btn sec" id="mCancel">Cancel</button><button class="btn" id="mOk">Update PIN</button></div>', function(){
      $('mCancel').onclick=closeModal;
      $('mOk').onclick=function(){
        var o=$('cpOld').value, n=$('cpNew').value, n2=$('cpNew2').value; err('cpErr');
        if(!/^\d{4}$/.test(o)) return err('cpErr','Enter your current 4-digit PIN.');
        if(n!==n2) return err('cpErr','New PINs don’t match.');
        var w=weakPin(n, String(me['Date Of Birth']||'').slice(0,10)); if(w) return err('cpErr',w);
        if(n===o) return err('cpErr','New PIN must be different.');
        Auth.changePin(myCode(),o,n).then(function(r){
          if(!r.ok) return err('cpErr', r.error || ('Current PIN is incorrect. '+(r.left!=null?r.left+' attempt(s) left.':'')));
          closeModal(); toast('PIN updated');
        }).catch(function(){ err('cpErr','Could not reach the server.'); });
      };
    });
}

// ===================== ADMIN: VIEW AS EMPLOYEE (read-only) =====================
// Admin can open any employee's portal without their PIN/DOB, for support and checks.
// Safeguards: Admin must be signed in with their own PIN; a reason is mandatory; every
// session is logged (Auth_Log in live mode); it is READ-ONLY (no tickets, remarks, PIN
// changes or resets as that person); it expires after 30 minutes; other Admins can't be viewed.
var IMP_MINUTES = 30;
var ICON_EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
function impState(){ try{ return JSON.parse(sessionStorage.getItem('cf_imp')||'null'); }catch(e){ return ui.impMem||null; } }
function setImpState(v){ ui.impMem=v; try{ if(v) sessionStorage.setItem('cf_imp', JSON.stringify(v)); else sessionStorage.removeItem('cf_imp'); }catch(e){} }
function readOnly(){
  var st=impState(); if(!st) return false;
  if(Date.now()>st.until){ toast('View-as session expired'); exitViewAs(); return true; }
  toast('Read-only: you are viewing as '+(me&&me['Employee Name'])+' \u2014 exit to make changes'); return true;
}
function viewAsHTML(){
  return '<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>View as Employee</h2></div>'+
    '<div class="panel"><div class="note">Open any employee’s portal without their PIN to check what they see or help with an issue. The view is <b>read-only</b>, expires in '+IMP_MINUTES+' minutes, and is logged with your name and reason.</div>'+
    '<div class="f"><label>Employee ID</label><input id="vaId" placeholder="CFD90001" autocapitalize="characters"></div>'+
    '<div class="f"><label>Reason (logged)</label><input id="vaReason" placeholder="e.g. Ticket HD-1042 — payslip not showing"></div>'+
    '<p class="lerror" id="vaErr"></p><button class="btn" id="vaGo" style="width:100%;padding:12px">Start read-only view</button></div>';
}
function bindViewAs(){
  $('vaGo').onclick=function(){
    var code=$('vaId').value.trim().toUpperCase(), reason=$('vaReason').value.trim(); err('vaErr');
    if(!code) return err('vaErr','Enter an Employee ID.');
    if(reason.length<5) return err('vaErr','Enter a reason (at least 5 characters).');
    if(code===myCode()) return err('vaErr','That’s your own ID.');
    var admin=me;
    if(LIVE){
      api({action:'impersonate', session:session(), empCode:code, reason:reason}).then(function(r){
        if(!r.ok) return err('vaErr', r.error||'Could not open that account.');
        try{ sessionStorage.setItem('cf_admin_session', session()); sessionStorage.setItem('cf_session', r.session); }catch(e){}
        setImpState({by:admin['Employee Code'], byName:admin['Employee Name'], until:Date.now()+IMP_MINUTES*60000});
        enter(r.employee);
      }).catch(function(){ err('vaErr','Could not reach the server.'); });
      return;
    }
  };
}
function exitViewAs(){
  var st=impState(); setImpState(null);
  if(!st) return;
  if(LIVE){
    var adminTok=null; try{ adminTok=sessionStorage.getItem('cf_admin_session'); sessionStorage.removeItem('cf_admin_session'); }catch(e){}
    if(session()) api({action:'logout', session:session()}).catch(function(){});
    if(!adminTok){ signOut(); return; }
    try{ sessionStorage.setItem('cf_session', adminTok); }catch(e){}
    api({action:'me', session:adminTok}).then(function(r){ if(r.ok) enter(r.employee); else signOut(); }).catch(function(){ signOut(); });
    return;
  }
  signOut();
}
function paintImpBanner(){
  var st=impState(), b=$('impBanner');
  if(!st){ b.hidden=true; return; }
  b.hidden=false;
  b.innerHTML='<span>Viewing as <b>'+esc(me['Employee Name'])+'</b> ('+esc(me['Employee Code'])+') · read-only · by '+esc(st.byName)+'</span><button id="impExit">Exit</button>';
  $('impExit').onclick=exitViewAs;
}

// ===================== HELPDESK MODULE =====================
var HR_ROLES = ['hr','hrhead'];
// Access rules (HR Head / HR / L1 / Employee, Admin flag) are worked out by the server on every request.
var ROLE_LABEL = {admin:'Admin', hrhead:'HR Head', hr:'HR', l1:'L1 Manager', employee:'Employee'};
var SLA_HOURS = 48; // T+2, same SLA as the previous Complaints module
var TICKET_CATEGORIES = [
  {v:'Payroll & Salary', posh:false},
  {v:'Attendance & Leave', posh:false},
  {v:'Reimbursements', posh:false},
  {v:'Letters & Documents', posh:false},
  {v:'Insurance & Benefits', posh:false},
  {v:'Grievance', posh:false},
  {v:'Conduct', posh:false},
  {v:'POSH', posh:true},
  {v:'Other', posh:false}
];
var ICON_TICKET = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5V6.8c0-.9.7-1.6 1.6-1.6h13.8c.9 0 1.6.7 1.6 1.6v1.7a2.6 2.6 0 0 0 0 5.2v1.7c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6v-1.7a2.6 2.6 0 0 0 0-5.2Z"/><path d="M14.5 5.2v1.6M14.5 10.2v1.6M14.5 15.2v1.6"/><path d="M7.5 10h4M7.5 13.5h3"/></svg>';
var ICON_BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
var ICON_CLIP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.5 12 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg>';

var me = null;           // logged-in employee row
var TICKETS = [];
var ui = {view:'home', tab:null, ticketId:null, draftFiles:[]};

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function empByCode(c){ return EMPLOYEE_MASTER.filter(function(r){return r['Employee Code']===c;})[0]||null; }
function nameOf(c){ if(NAMES[c]) return NAMES[c]; var e=empByCode(c); return e?e['Employee Name']:c; }
function isHR(e){ return e && HR_ROLES.indexOf(e['Role'])!==-1; }
function fmt(ts){ var d=new Date(ts); return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})+', '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}); }
function fmtDay(ts){ return new Date(ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}); }
function kb(n){ return n>1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }

// ---- routing: who does a new ticket go to? ----
// 1) POSH always goes to the HR Head (confidential).
// 2) Otherwise the employee's HR partner from the Employee Master ("HR Manager Code").
// 3) If that's blank / not an active HR / is the raiser themselves, fall back to the HR Head.
function routeTicket(emp, category){
  var r = emp && emp._route; if(!r) return {code:'', name:'HR desk', why:'Routed to the HR desk'};
  var cat = TICKET_CATEGORIES.filter(function(c){return c.v===category;})[0];
  if(cat && cat.posh && r.head && r.head.code!==emp['Employee Code']) return {code:r.head.code, name:r.head.name, why:'POSH cases go directly to the HR Head'};
  return {code:r.partner.code, name:r.partner.name, why:r.partner.why};
}

// ---- tickets come from the server ----
var ticketsLoaded = false;
function loadTickets(){
  return api({action:'tickets', session:session()}).then(function(r){
    if(r.ok){ TICKETS = r.items||[]; ticketsLoaded = true; }
    else if(!r.expired) toast(r.error||'Could not load tickets.');
    if(me) render();
    return r;
  }).catch(function(){ toast('Could not reach the server.'); });
}
function ticketAction(payload, okMsg, after){
  payload.session = session();
  return api(payload).then(function(r){
    if(!r.ok){ toast(r.error||'Could not save.'); return r; }
    closeModal(); if(okMsg) toast(okMsg);
    return loadTickets().then(function(){ if(after) after(r); return r; });
  }).catch(function(){ toast('Could not reach the server.'); });
}

// ---- status helpers ----
function overdue(t){ return t.status!=='Closed' && Date.now() > t.createdAt + SLA_HOURS*3600000; }
function pill(t){
  if(t.status==='Closed') return '<span class="pill closed">Closed</span>';
  if(overdue(t)) return '<span class="pill over">Overdue</span>';
  return t.status==='In Progress' ? '<span class="pill progress">In progress</span>' : '<span class="pill open">Open</span>';
}
function myCode(){ return me['Employee Code']; }
function myOpen(){ return TICKETS.filter(function(t){return t.raisedBy===myCode() && t.status!=='Closed';}); }
function myHistory(){ return TICKETS.filter(function(t){return t.raisedBy===myCode() && t.status==='Closed';}); }
function hrPending(){ return TICKETS.filter(function(t){ return t.status!=='Closed' && (me['Role']==='hrhead' || t.assignedTo===myCode()); }); }
function hrClosed(){ return TICKETS.filter(function(t){ return t.status==='Closed' && (me['Role']==='hrhead' || t.assignedTo===myCode() || t.events.some(function(e){return e.by===myCode();})); }); }
function byNewest(a,b){ return (b.closedAt||b.createdAt)-(a.closedAt||a.createdAt); }

// ---- app start / stop ----
function startApp(emp){
  me = emp; NAMES[emp['Employee Code']] = emp['Employee Name']; TICKETS = []; ticketsLoaded = false;
  try{ sessionStorage.setItem('cf_emp', emp['Employee Code']); }catch(e){}
  $('loginWrap').hidden = true; $('app').hidden = false;
  $('whoName').textContent = emp['Employee Name'];
  $('whoMeta').textContent = emp['Employee Code']+' · '+(ROLE_LABEL[emp['Role']]||'Employee')+(emp['Is Admin']?' · Admin':'');
  paintImpBanner();
  go('home');
  loadTickets();
}
function signOut(){
  TICKETS = []; ticketsLoaded = false; NAMES = {};
  if(LIVE && session()) api({action:'logout', session:session()}).catch(function(){}); me=null; setImpState(null); try{ sessionStorage.removeItem('cf_emp'); sessionStorage.removeItem('cf_session'); sessionStorage.removeItem('cf_admin_session'); }catch(e){} s.empCode=''; clearPins();
  $('app').hidden = true; $('loginWrap').hidden = false;
  $('empIdInput').value=''; show('stepId');
}
function go(view, opts){
  ui.view=view; opts=opts||{};
  if(opts.tab) ui.tab=opts.tab;
  if(opts.ticketId) ui.ticketId=opts.ticketId;
  render(); window.scrollTo(0,0);
}

function render(){
  var v=$('view');
  if(ui.view==='home') v.innerHTML = homeHTML();
  else if(ui.view==='helpdesk') v.innerHTML = helpdeskHTML();
  else if(ui.view==='ticket') v.innerHTML = ticketHTML();
  else if(ui.view==='offer') v.innerHTML = offerListHTML();
  else if(ui.view==='offerView') v.innerHTML = offerViewHTML();
  else if(ui.view==='profile') v.innerHTML = profileHTML();
  else if(ui.view==='pinreset') v.innerHTML = pinResetHTML();
  else if(ui.view==='viewas') v.innerHTML = viewAsHTML();
  else if(ui.view==='payslips') v.innerHTML = payslipListHTML();
  else if(ui.view==='slip') v.innerHTML = payslipViewHTML();
  bindView();
}

function homeHTML(){
  var count = isHR(me) ? hrPending().length : myOpen().length;
  var sub = isHR(me) ? (count+' pending action'+(count===1?'':'s')) : (count ? count+' open ticket'+(count===1?'':'s') : 'Payroll, leave, documents & more');
  return '<div class="greet"><h2>Hi, '+esc(me['First Name']||me['Employee Name'].split(' ')[0])+'</h2><p>'+esc(me['Designation']||'')+(me['Entity']?' · '+esc(me['Entity']):'')+'</p></div>'+
    '<div class="cards">'+
      '<button class="mcard" data-go="helpdesk">'+(count?'<span class="badge">'+count+'</span>':'')+
        '<div class="ic">'+ICON_TICKET+'</div><div><div class="t">Raise Ticket</div><div class="s">'+sub+'</div></div></button>'+
      (me['Is Admin'] && !impState()?'<button class="mcard" data-go="viewas"><div class="ic">'+ICON_EYE+'</div><div><div class="t">View as Employee</div><div class="s">Open any account, read-only</div></div></button>':'')+
      (isHR(me) && !impState()?'<button class="mcard" data-go="pinreset"><div class="ic">'+ICON_KEY+'</div><div><div class="t">PIN Reset</div><div class="s">Reset an employee\u2019s sign-in PIN</div></div></button>':'')+
      '<button class="mcard" data-go="offer"><div class="ic">'+ICON_OFFER+'</div><div><div class="t">Offer Letter</div><div class="s">View your offer letter</div></div></button>'+
      '<button class="mcard" data-go="payslips"><div class="ic">'+ICON_SLIP+'</div><div><div class="t">Payslips</div><div class="s">Monthly payslips & stipend slips</div></div></button>'+

    '</div>';
}

function tabsFor(){
  return isHR(me)
    ? [['raise','Raise Ticket',null],['pending','Pending Actions',hrPending().length],['closed','Closed Tickets',hrClosed().length]]
    : [['raise','Raise Ticket',null],['open','Open Tickets',myOpen().length],['history','Ticket History',myHistory().length]];
}

function helpdeskHTML(){
  if(!ticketsLoaded) return '<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>Helpdesk</h2></div>'+LOADING_HTML;
  var tabs=tabsFor(); if(!ui.tab || !tabs.some(function(t){return t[0]===ui.tab;})) ui.tab = isHR(me)?'pending':'raise';
  var h = '<div class="crumb"><button class="iconbtn" data-go="home">'+ICON_BACK+'</button><h2>Helpdesk</h2></div>';
  h += '<div class="tabs">'+tabs.map(function(t){ return '<button class="tab'+(t[0]===ui.tab?' active':'')+'" data-tab="'+t[0]+'">'+t[1]+(t[2]!=null?'<span class="n">'+t[2]+'</span>':'')+'</button>'; }).join('')+'</div>';
  if(ui.tab==='raise') h += raiseHTML();
  else if(ui.tab==='open') h += listHTML(myOpen().sort(byNewest),'You have no open tickets.',false);
  else if(ui.tab==='history') h += listHTML(myHistory().sort(byNewest),'No closed tickets yet.',false);
  else if(ui.tab==='pending') h += toolbarHTML(true) + '<div id="listWrap">'+listHTML(hrPending().sort(function(a,b){return a.createdAt-b.createdAt;}),'Nothing pending — all caught up.',true)+'</div>';
  else if(ui.tab==='closed') h += toolbarHTML(false) + '<div id="listWrap">'+listHTML(hrClosed().sort(byNewest),'No closed tickets yet.',true)+'</div>';
  return h;
}

function toolbarHTML(){
  return '<div class="toolbar"><input id="q" placeholder="Search ID, name or text"><select id="catF"><option value="">All categories</option>'+
    TICKET_CATEGORIES.map(function(c){return '<option>'+c.v+'</option>';}).join('')+'</select></div>';
}

function listHTML(list, emptyMsg, showRaiser){
  if(!list.length) return '<div class="empty">'+emptyMsg+'</div>';
  return '<div class="tlist">'+list.map(function(t){
    var meta = showRaiser
      ? esc(nameOf(t.raisedBy))+' ('+t.raisedBy+') · '+fmtDay(t.createdAt)+(me['Role']==='hrhead'?' · with '+esc(nameOf(t.assignedTo)):'')
      : 'Raised '+fmtDay(t.createdAt)+' · '+(t.status==='Closed'?'Closed '+fmtDay(t.closedAt):'With '+esc(nameOf(t.assignedTo)));
    return '<button class="trow" data-ticket="'+t.id+'" data-search="'+esc((t.id+' '+nameOf(t.raisedBy)+' '+t.raisedBy+' '+t.description).toLowerCase())+'" data-cat="'+esc(t.category)+'">'+
      '<div><div class="id">'+t.id+(t.files&&t.files.length?' · '+ICON_CLIP:'')+'</div><div class="cat">'+esc(t.category)+'</div></div>'+pill(t)+
      '<div class="desc">'+esc(t.description)+'</div><div class="meta">'+meta+'</div></button>';
  }).join('')+'</div>';
}

function raiseHTML(){
  var r = routeTicket(me,'Other');
  return '<div class="panel">'+
    '<div class="note">Your ticket goes straight to your HR partner, <b>'+esc(r.name)+'</b>, with a 48-hour response window. POSH concerns go confidentially to the HR Head.</div>'+
    '<div class="fgrid"><div class="f"><label>Employee ID</label><input readonly value="'+esc(me['Employee Code'])+'"></div>'+
    '<div class="f"><label>Employee name</label><input readonly value="'+esc(me['Employee Name'])+'"></div></div>'+
    '<div class="f"><label>Ticket category</label><select id="tCat"><option value="">Select a category</option>'+
      TICKET_CATEGORIES.map(function(c){return '<option>'+c.v+'</option>';}).join('')+'</select></div>'+
    '<div class="f"><label>Describe the issue</label><textarea id="tDesc" maxlength="2000" placeholder="What happened, when, and what would you like HR to do?"></textarea><span class="help" id="tCount">0 / 2000</span></div>'+
    '<div class="f"><label>Supporting documents (optional)</label>'+
      '<div class="drop" id="drop">Tap to attach files · PDF, images, Word, Excel · up to 5 files, 2 MB each</div>'+
      '<input type="file" id="tFiles" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx">'+
      '<div class="files" id="fileList"></div></div>'+
    '<p class="lerror" id="raiseErr"></p>'+
    '<button class="btn" id="submitTicket">Submit ticket</button></div>';
}

function fileListHTML(files, removable){
  return files.map(function(f,i){
    var name = (f.id && !removable) ? '<a href="#" data-viewfile="'+i+'">'+esc(f.name)+'</a>' : esc(f.name)+(removable && !f.data ? ' <span style="color:var(--ink-faint)">(reading…)</span>' : '');
    return '<div class="file">'+ICON_CLIP+' '+name+' <span style="color:var(--ink-faint)">'+kb(f.size)+'</span>'+(removable?'<button class="x" data-rmfile="'+i+'">&times;</button>':'')+'</div>';
  }).join('');
}

function ticketHTML(){
  var t = TICKETS.filter(function(x){return x.id===ui.ticketId;})[0];
  if(!t) return '<div class="empty">Ticket not found.</div>';
  var rz = t.raiser||{}; var raiser = {'Employee Name':rz.name, 'Designation':rz.designation, 'Base location (Office)':rz.location};
  var canAct = isHR(me) && t.status!=='Closed' && (t.assignedTo===myCode() || me['Role']==='hrhead');
  var due = t.createdAt + SLA_HOURS*3600000;
  var h = '<div class="crumb"><button class="iconbtn" data-go="helpdesk">'+ICON_BACK+'</button><h2>Ticket details</h2></div>';
  h += '<div class="panel"><div class="dhead"><div><div class="id">'+t.id+'</div><h3>'+esc(t.category)+'</h3></div>'+pill(t)+'</div>';
  h += '<div class="kv">'+
    '<div><span>Raised by</span><b>'+esc(raiser['Employee Name']||t.raisedBy)+'</b></div>'+
    '<div><span>Employee ID</span><b>'+t.raisedBy+'</b></div>'+
    (isHR(me)?'<div><span>Designation</span><b>'+esc(raiser['Designation']||'—')+'</b></div><div><span>Location</span><b>'+esc(raiser['Base location (Office)']||'—')+'</b></div>':'')+
    '<div><span>Assigned HR</span><b>'+esc(nameOf(t.assignedTo))+'</b></div>'+
    '<div><span>Raised on</span><b>'+fmt(t.createdAt)+'</b></div>'+
    (t.status==='Closed' ? '<div><span>Closed on</span><b>'+fmt(t.closedAt)+'</b></div><div><span>Turnaround</span><b>'+turnaround(t)+'</b></div>'
                        : '<div><span>Respond by</span><b style="color:'+(overdue(t)?'var(--bad)':'inherit')+'">'+fmt(due)+'</b></div>')+
  '</div>';
  h += '<div class="sec-h">Issue</div><div class="issue">'+esc(t.description)+'</div>';
  if(t.files && t.files.length) h += '<div class="sec-h">Attachments</div><div class="files">'+fileListHTML(t.files,false)+'</div>';
  if(canAct){
    h += '<div class="sec-h">HR action</div>'+
      '<div class="f" style="margin-bottom:10px"><textarea id="remark" placeholder="Add an HR remark — visible to the employee"></textarea></div>'+
      '<div class="actions"><button class="btn" id="addRemark">Update remark</button>'+
      '<button class="btn sec" id="reassign">Assign to another HR</button>'+
      '<button class="btn ok" id="closeT">Close ticket</button></div>';
  }
  h += '<div class="sec-h">Timeline</div><ul class="timeline">'+t.events.map(function(e){
    var label = {created:'Ticket raised', assigned:'Assigned', reassigned:'Reassigned', remark:'HR remark', closed:'Ticket closed'}[e.type]||e.type;
    var by = e.by==='system' ? 'System' : nameOf(e.by);
    var text = e.type==='created' ? '' : e.text;
    return '<li class="'+(e.type==='closed'?'closed':(e.type==='assigned'||e.type==='reassigned')?'assign':'')+'"><div class="when">'+fmt(e.at)+' · '+esc(by)+'</div><div class="what">'+label+'</div>'+(text?'<div class="txt">'+esc(text)+'</div>':'')+'</li>';
  }).join('')+'</ul></div>';
  return h;
}
function turnaround(t){
  var hrs = Math.round((t.closedAt - t.createdAt)/3600000);
  return hrs<24 ? hrs+' hrs' : Math.floor(hrs/24)+'d '+(hrs%24)+'h';
}

// ---- modals ----
function modal(html, onMount){
  var root=$('modalRoot');
  root.innerHTML = '<div class="modal-bg" id="mbg"><div class="modal">'+html+'</div></div>';
  $('mbg').onclick=function(e){ if(e.target.id==='mbg') closeModal(); };
  onMount && onMount();
}
function closeModal(){ $('modalRoot').innerHTML=''; }

// ---- event binding ----
function bindView(){
  var v=$('view');
  [].forEach.call(v.querySelectorAll('[data-go]'),function(b){ b.onclick=function(){ go(b.dataset.go); }; });
  [].forEach.call(v.querySelectorAll('[data-tab]'),function(b){ b.onclick=function(){ ui.tab=b.dataset.tab; render(); }; });
  [].forEach.call(v.querySelectorAll('[data-ticket]'),function(b){ b.onclick=function(){ go('ticket',{ticketId:b.dataset.ticket}); }; });

  var q=$('q'), cf=$('catF');
  if(q){ var filt=function(){ var s=q.value.trim().toLowerCase(), c=cf.value, any=false;
      [].forEach.call(v.querySelectorAll('.trow'),function(r){ var ok=(!s||r.dataset.search.indexOf(s)!==-1)&&(!c||r.dataset.cat===c); r.hidden=!ok; if(ok) any=true; }); };
    q.oninput=filt; cf.onchange=filt; }

  [].forEach.call(v.querySelectorAll('[data-slip]'),function(b){ b.onclick=function(){ ui.slipMonth=b.dataset.slip; go('slip'); }; });
  [].forEach.call(v.querySelectorAll('[data-offer]'),function(b){ b.onclick=function(){ ui.offerRef=b.dataset.offer; go('offerView'); }; });
  [].forEach.call(v.querySelectorAll('[data-raise]'),function(b){ b.onclick=function(e){ e.preventDefault(); ui.prefillCat=b.dataset.raise; go('helpdesk',{tab:'raise'}); }; });
  if($('signOutBtn')) $('signOutBtn').onclick = function(){ if(impState()) exitViewAs(); else signOut(); };
  if($('signOutBtn') && impState()) $('signOutBtn').textContent='Exit view-as';
  if($('changePinBtn')) $('changePinBtn').onclick = openChangePin;
  if($('openOfferPdf')) $('openOfferPdf').onclick = function(){ openPdf('offer', ui.offerRef, 'Offer letter'); };
  if($('openSlipPdf')) $('openSlipPdf').onclick = function(){ openPdf('payslip', ui.slipMonth, 'Payslip'); };
  if(ui.view==='pinreset') bindPinReset();
  if(ui.view==='viewas') bindViewAs();
  $('profileBtn').classList.toggle('active', ui.view==='profile');
  $('navHome').classList.toggle('active', ui.view==='home');
  $('navTickets').classList.toggle('active', ui.view==='helpdesk'||ui.view==='ticket');
  if(ui.view==='helpdesk' && ui.tab==='raise') bindRaise();
  if(ui.view==='ticket') bindTicket();
}

function bindRaise(){
  ui.draftFiles = [];
  var desc=$('tDesc'), cat=$('tCat');
  if(ui.prefillCat){ cat.value=ui.prefillCat; ui.prefillCat=null; setTimeout(function(){ cat.onchange(); },0); }
  desc.oninput=function(){ $('tCount').textContent = desc.value.length+' / 2000'; };
  cat.onchange=function(){
    if(!cat.value) return;
    var r=routeTicket(me,cat.value);
    document.querySelector('.note').innerHTML = 'This ticket will be assigned to <b>'+esc(r.name)+'</b> — '+esc(r.why.charAt(0).toLowerCase()+r.why.slice(1))+'. Response window: 48 hours.';
  };
  $('drop').onclick=function(){ $('tFiles').click(); };
  $('tFiles').onchange=function(e){
    var files=[].slice.call(e.target.files); e.target.value='';
    files.forEach(function(f){
      if(ui.draftFiles.length>=5) return toast('Up to 5 files per ticket');
      if(f.size>2*1048576) return toast(f.name+' is over 2 MB');
      var entry={name:f.name, size:f.size, type:f.type, data:null};
      ui.draftFiles.push(entry); paintFiles();
      var rd=new FileReader(); rd.onload=function(){ entry.data=rd.result; paintFiles(); }; rd.onerror=function(){ toast('Could not read '+f.name); }; rd.readAsDataURL(f);
    });
  };
  function paintFiles(){
    $('fileList').innerHTML = fileListHTML(ui.draftFiles,true);
    [].forEach.call(document.querySelectorAll('[data-rmfile]'),function(b){ b.onclick=function(){ ui.draftFiles.splice(+b.dataset.rmfile,1); paintFiles(); }; });
  }
  $('submitTicket').onclick=function(){
    if(readOnly()) return;
    err('raiseErr');
    if(!cat.value) return err('raiseErr','Select a ticket category.');
    if(desc.value.trim().length<10) return err('raiseErr','Please describe the issue in a little more detail (at least 10 characters).');
    if(ui.draftFiles.some(function(f){ return !f.data; })) return err('raiseErr','Attachments are still loading — try again in a moment.');
    var btn=$('submitTicket'); busy(btn,true,'Submitting…');
    api({action:'raiseTicket', session:session(), category:cat.value, description:desc.value.trim(),
         files:ui.draftFiles.map(function(f){ return {name:f.name, data:f.data}; })}).then(function(r){
      if(!r.ok){ busy(btn,false,'Submit ticket'); return err('raiseErr', r.error||'Could not submit the ticket.'); }
      if(r.assignedTo) NAMES[r.assignedTo]=r.assignedName;
      toast(r.id+' raised · assigned to '+r.assignedName);
      ui.draftFiles=[];
      loadTickets().then(function(){ if(isHR(me)) go('ticket',{ticketId:r.id}); else go('helpdesk',{tab:'open'}); });
    }).catch(function(){ busy(btn,false,'Submit ticket'); err('raiseErr','Could not reach the server. Check your connection and try again.'); });
  };
}

function bindTicket(){
  var t = TICKETS.filter(function(x){return x.id===ui.ticketId;})[0];
  if(t) [].forEach.call(document.querySelectorAll('[data-viewfile]'),function(a){ a.onclick=function(e){ e.preventDefault();
    var f=t.files[+a.dataset.viewfile];
    modal('<h4>'+esc(f.name)+'</h4><p>Loading…</p>', null);
    fetch('/api/file/'+encodeURIComponent(f.id),{headers:{'Authorization':'Bearer '+session()}}).then(function(res){
      if(!res.ok) throw new Error(res.status); return res.blob();
    }).then(function(blob){
      var url=URL.createObjectURL(blob), isImg=/^image\//.test(f.type), isPdf=f.type==='application/pdf';
      var body = isImg ? '<img src="'+url+'" style="max-width:100%;border-radius:8px;display:block">'
               : isPdf ? '<iframe src="'+url+'" style="width:100%;height:60vh;border:1px solid var(--line);border-radius:8px"></iframe>'
               : '<p>Preview isn\u2019t available for this file type.</p>';
      modal('<h4>'+esc(f.name)+'</h4><p>'+kb(f.size)+'</p>'+body+'<div class="row" style="margin-top:12px"><a class="btn sec" href="'+url+'" download="'+esc(f.name)+'" style="text-decoration:none">Download</a><button class="btn" id="mCancel">Close</button></div>', function(){ $('mCancel').onclick=closeModal; });
    }).catch(function(){ modal('<h4>'+esc(f.name)+'</h4><p>Could not open this file.</p><div class="row"><button class="btn sec" id="mCancel">Close</button></div>', function(){ $('mCancel').onclick=closeModal; }); });
  }; });
  if(!t || !$('addRemark')) return;
  $('addRemark').onclick=function(){
    if(readOnly()) return;
    var txt=$('remark').value.trim(); if(!txt) return toast('Write a remark first');
    ticketAction({action:'ticketRemark', id:t.id, text:txt}, 'Remark added');
  };
  $('reassign').onclick=function(){
    if(readOnly()) return;
    api({action:'hrList', session:session()}).then(function(hl){
    if(!hl.ok) return toast(hl.error||'Could not load HR list.');
    var opts = hl.items.filter(function(h){return h.code!==t.assignedTo;}).map(function(h){ return {'Employee Code':h.code,'Employee Name':h.name,'Designation':h.designation}; });
    if(!opts.length) return toast('No other HR person to assign to.');
    modal('<h4>Assign to another HR</h4><p>Currently with '+esc(nameOf(t.assignedTo))+'.</p>'+
      '<div class="f"><label>Assign to</label><select id="mHr">'+opts.map(function(h){return '<option value="'+h['Employee Code']+'">'+esc(h['Employee Name'])+' — '+esc(h['Designation']||'HR')+'</option>';}).join('')+'</select></div>'+
      '<div class="f"><label>Reason / handover note</label><textarea id="mNote" placeholder="Why is this being reassigned?"></textarea></div>'+
      '<div class="row"><button class="btn sec" id="mCancel">Cancel</button><button class="btn" id="mOk">Reassign</button></div>', function(){
        $('mCancel').onclick=closeModal;
        $('mOk').onclick=function(){
          var to=$('mHr').value, note=$('mNote').value.trim();
          if(!note) return toast('Add a handover note');
          ticketAction({action:'ticketReassign', id:t.id, to:to, note:note}, null, function(r){
            toast('Reassigned to '+r.name);
            if(me['Role']==='hrhead') render(); else go('helpdesk',{tab:'pending'});
          });
        };
      });
    }).catch(function(){ toast('Could not reach the server.'); });
  };
  $('closeT').onclick=function(){
    if(readOnly()) return;
    modal('<h4>Close ticket '+t.id+'</h4><p>The employee will see this resolution note in their ticket history.</p>'+
      '<div class="f"><label>Resolution</label><textarea id="mRes" placeholder="What was done to resolve this?">'+esc($('remark').value)+'</textarea></div>'+
      '<div class="row"><button class="btn sec" id="mCancel">Cancel</button><button class="btn ok" id="mOk">Close ticket</button></div>', function(){
        $('mCancel').onclick=closeModal;
        $('mOk').onclick=function(){
          var res=$('mRes').value.trim(); if(!res) return toast('Add a resolution note');
          ticketAction({action:'ticketClose', id:t.id, text:res}, t.id+' closed');
        };
      });
  };
}

$('profileBtn').onclick = function(){ go('profile'); };
$('navHome').onclick = function(){ go('home'); };
$('navTickets').onclick = function(){ go('helpdesk'); };
(function(){
  try{
    if(LIVE){ var tok=session(); if(tok) api({action:'me', session:tok}).then(function(r){ if(r.ok) enter(r.employee); else sessionStorage.removeItem('cf_session'); }).catch(function(){}); return; }
  }catch(x){}
})();
