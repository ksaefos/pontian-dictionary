/* Pontian Dictionary v5 - GitHub Pages reader and secure Cloudflare Worker sync.
   This file contains no access tokens or passwords. */
(() => {
  'use strict';
  const STATUS = document.getElementById('cloudStatus');
  const modal = document.getElementById('cloudDialog');
  const retryVisible = document.getElementById('cloudRetryVisible');
  const pendingActions = document.getElementById('cloudPendingActions');
  function updatePendingControls() {
    const show = pending.size > 0 && !!editorKey;
    pendingActions.hidden = !show;
    retryVisible.disabled = !show || inFlight || !remoteLoaded;
    document.getElementById('cloudRetry').hidden = !pending.size;
  }
  const WORKER_URL = 'https://pontian-dictionary-sync.ksaefos.workers.dev';
  const SESSION_KEY = 'pontian-dictionary-editor-session';
  const PENDING_KEY = 'pontian-dictionary-github-pending-' + EDITION_ID;
  const banner = (text, mode = '') => {
    STATUS.textContent = text;
    STATUS.dataset.state = mode;
    document.getElementById('cloudDialogStatus').textContent = text;
    updatePendingControls();
  };
  function getLocal(key, fallback='') { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
  function setLocal(key, val) { try { localStorage.setItem(key,val); } catch {} }
  function getSession() { try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } }
  function setSession(key) { try { if(key)sessionStorage.setItem(SESSION_KEY,key);else sessionStorage.removeItem(SESSION_KEY); } catch {} }
  // Public Worker address is fixed; only the editor password is entered at login.
  let workerURL = WORKER_URL;
  let editorKey = getSession();
  let remote = {};
  let remoteLoaded = false;
  let inFlight = false;
  let scheduled = 0;
  let pending = new Map();
  try {
    const parsed = JSON.parse(getLocal(PENDING_KEY,'{}'));
    if(parsed && !Array.isArray(parsed))for(const [id,row] of Object.entries(parsed)){
      if(Number.isSafeInteger(Number(id)) && Number(id)>=0 && Number(id)<DATA.length && (row === null || Array.isArray(row) || row?.deleted===true)) pending.set(Number(id),row);
    }
  } catch {};
  const originalLocalRows = new Map([...CHANGED].map(i=>[i,DELETED.has(i)?{deleted:true}:dictionarySnapshot(i)]));
  let firstOverlay = true;
  const eq = (a,b) => JSON.stringify(a??null) === JSON.stringify(b??null);
  function savePending() {
    setLocal(PENDING_KEY,JSON.stringify(Object.fromEntries(pending)));
    updatePendingControls();
  }
  function adminMode(enabled) {
    document.body.classList.toggle('admin-mode', !!enabled);
    document.getElementById('cloudOpen').setAttribute('aria-pressed',String(!!enabled));
    document.getElementById('cloudOpen').querySelector('.cloud-open-label').textContent = enabled ? 'Διαχειριστής' : 'Διαχείριση';
    updatePendingControls();
  }
  async function api(path,{method='GET',body=null,key=''}={}) {
    if(!workerURL)throw new Error('Δεν έχει δηλωθεί η διεύθυνση του Cloudflare Worker.');
    const response=await fetch(workerURL+path,{
      method,
      headers:{...(key?{'Authorization':'Bearer '+key}:{}), ...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,
      cache:'no-store',
    });
    let data={};
    try{data=await response.json()}catch{}
    if(!response.ok){
      const e=new Error((data?.message || data?.error || 'HTTP '+response.status));
      e.httpStatus=response.status;e.data=data;throw e;
    }
    return data;
  }
  function overlay(file) {
    if(file.format!=='pontian-github-edits-v1' || file.total!==DATA.length || file.baseVersion!==EDITION_ID || !file.edits || typeof file.edits!=='object' || Array.isArray(file.edits))
      throw new Error('Το απομακρυσμένο αρχείο αλλαγών δεν αντιστοιχεί στην έκδοση του λεξικού.');
    remote=file.edits;
    remoteLoaded=true;
    const localCompare=new Set([...CHANGED]);
    const remoteIndices=new Set(Object.keys(remote).map(Number));
    for(const id of new Set([...localCompare,...remoteIndices])){
      if(!Number.isInteger(id) || id<0 || id>=DATA.length)continue;
      const cloudRow=(Object.prototype.hasOwnProperty.call(remote,id)?remote[id]:null);
      const expected=cloudRow?.deleted===true?cloudRow:(cloudRow||[...BASE_ROWS[id],'']);
      if(firstOverlay && !pending.has(id) && originalLocalRows.has(id) && !eq(originalLocalRows.get(id),expected)) {
        // Never silently discard a local edit from the previous offline application.
        pending.set(id, originalLocalRows.get(id));
      }
      const row = pending.has(id) ? pending.get(id) : expected;
      if(row?.deleted===true)saveRow(id,row);
      else if(Array.isArray(row) && (row.length===6||row.length===7))saveRow(id,row);
    }
    firstOverlay=false;
    savePending();
    updateChangedCounter();
    rebuildPartFilter();
    update();
    persist();
  }
  async function reloadRemote(){
    let data;
    if(workerURL) data=await api('/edits');
    else {
      const resp=await fetch('./data/edits.json?cache='+Date.now(), {cache:'no-store'});
      if(!resp.ok)throw new Error('Δεν φορτώθηκε το αρχείο δεδομένων ('+resp.status+').');
      data=await resp.json();
    }
    overlay(data);
    if(pending.size)banner(`Υπάρχουν ${pending.size} τοπικές διορθώσεις που δεν έχουν δημοσιευτεί.`, 'warning');
    else if(editorKey && workerURL)banner('Συνδεδεμένος διαχειριστής · Οι αλλαγές δημοσιεύονται στο GitHub.','ok');
    else banner('Το δημόσιο λεξικό ενημερώθηκε από το GitHub.', 'ok');
  }
  async function login() {
    const key=document.getElementById('editorAccessKey').value.trim();
    if(!key){banner('Συμπλήρωσε τον κωδικό πρόσβασης.','warning');return}
    try {
      banner('Έλεγχος σύνδεσης…');
      await api('/auth',{key});
      editorKey=key;setSession(key);
      adminMode(true);
      await reloadRemote();
      document.getElementById('editorAccessKey').value='';
      closeModal();
      if(pending.size){
        banner(`Συνδέθηκες. Ξεκινά η αποστολή ${pending.size} εκκρεμών αλλαγών στο GitHub…`,'warning');
        await pump();
      }
    } catch(e){editorKey='';setSession('');adminMode(false);banner('Αποτυχία σύνδεσης: '+e.message,'error')}
  }
  function closeModal(){if(typeof modal.close==='function')modal.close();else modal.removeAttribute('open')}
  function disconnect(){editorKey='';setSession('');adminMode(false);closeModal();banner('Αποσυνδέθηκες. Η δημόσια αναζήτηση παραμένει διαθέσιμη.','ok')}
  function queue(id) {
    const row=DELETED.has(id)?{deleted:true}:(CHANGED.has(id) ? dictionarySnapshot(id) : null);
    pending.set(id,row);savePending();
    if(!editorKey||!workerURL){banner('Η διόρθωση σώθηκε τοπικά, όχι στο GitHub. Σύνδεσε τον διαχειριστή.','warning');return}
    banner(`Τοπική αποθήκευση OK · ${pending.size} αλλαγές αναμένουν GitHub…`);
    clearTimeout(scheduled);
    scheduled=setTimeout(pump,650);
  }
  async function pump(){
    if(inFlight||!pending.size||!editorKey||!workerURL||!remoteLoaded)return;
    inFlight=true;updatePendingControls();
    const batch=[...pending.entries()].slice(0,100);
    const changes={};
    for(const [id,row] of batch)changes[id]={expected:(Object.prototype.hasOwnProperty.call(remote,id)?remote[id]:null),row};
    try{
      banner(`Αποστολή ${batch.length} διορθώσεων στο GitHub…`);
      await api('/save',{method:'POST',key:editorKey,body:{changes}});
      for(const [id,row] of batch){
        if(row===null)delete remote[id];else remote[id]=row;
        if(pending.has(id)&&eq(pending.get(id),row))pending.delete(id);
      }
      savePending();
      banner(pending.size?`Δημοσιεύτηκαν ${batch.length} αλλαγές · Εκκρεμούν ${pending.size}.`:
        `Αποθηκεύτηκαν ${batch.length} αλλαγές στο GitHub. Η δημοσίευση στο Pages ακολουθεί αυτόματα.`,'ok');
    }catch(e){
      if(e.httpStatus===409 && e.data?.error==='conflict'){
        const ids=(e.data.collisions||[]).map(c=>Number(c.index)+1).join(', ');
        banner('Σύγκρουση αλλαγών στις εγγραφές '+ids+'. Τίποτα δεν αντικαταστάθηκε. Ανανεώστε τη σελίδα και ελέγξτε τις διαφορές.','error');
      }else if(e.httpStatus===401){
        editorKey='';setSession('');adminMode(false);
        banner('Το κλειδί διαχειριστή απορρίφθηκε. Οι αλλαγές έμειναν τοπικά.','error');
      }else banner('Αδυναμία αποθήκευσης στο GitHub: '+e.message+'. Οι αλλαγές διατηρούνται τοπικά.','error');
      return;
    }finally{inFlight=false;updatePendingControls()}
    if(pending.size)setTimeout(pump,600);
  }
  function stageAllLocal() {
    if(!editorKey){banner('Συνδέσου ως διαχειριστής πρώτα.','warning');return}
    if(!remoteLoaded){banner('Δεν έχουν φορτωθεί ακόμη οι αλλαγές του GitHub.','warning');return}
    const ids=[...CHANGED].filter(i=>!eq(DELETED.has(i)?{deleted:true}:dictionarySnapshot(i),remote[i]??[...BASE_ROWS[i],'']));
    if(!ids.length){banner('Δεν υπάρχουν νέες τοπικές αλλαγές για αποστολή.','ok');return}
    if(!confirm(`Να σταλούν ${ids.length} τοπικά τροποποιημένες εγγραφές στο GitHub; Θα δημιουργηθούν commits.`))return;
    for(const i of ids)pending.set(i,DELETED.has(i)?{deleted:true}:dictionarySnapshot(i));
    savePending();closeModal();pump();
  }
  // Keep the original per-entry editor: clicking Save automatically queues a GitHub commit.
  const originalSave=byId('saveEditor').onclick;
  byId('saveEditor').onclick=()=>{
    const id=editorIndex;
    const before=id>=0?JSON.stringify(DELETED.has(id)?{deleted:true}:dictionarySnapshot(id)):'';
    originalSave();
    if(id>=0 && editorIndex===-1 && before!==JSON.stringify(DELETED.has(id)?{deleted:true}:dictionarySnapshot(id)))queue(id);
  };
  document.addEventListener('dictionary-entry-deleted',e=>queue(e.detail.index));
  // Imported JSON is local-only until the editor explicitly selects "Publish local changes".
  byId('importFile').addEventListener('change',()=>{
    banner('Οι αλλαγές από αρχείο JSON είναι τοπικές. Μετά την εισαγωγή, χρησιμοποίησε «Δημοσίευση τοπικών».','warning');
  });
  byId('cloudOpen').onclick=()=>{
    document.getElementById('editorAccessKey').value=editorKey;
    if(typeof modal.showModal==='function')modal.showModal();else modal.setAttribute('open','');
  };
  document.getElementById('cloudConnect').onclick=login;
  document.getElementById('cloudDisconnect').onclick=disconnect;
  document.getElementById('cloudClose').onclick=closeModal;
  document.getElementById('cloudPublishLocal').onclick=stageAllLocal;
  document.getElementById('cloudRefresh').onclick=()=>reloadRemote().catch(e=>banner('Δεν φορτώθηκαν οι τελευταίες αλλαγές: '+e.message,'error'));
  const retryPending=()=>{if(editorKey)pump();else banner('Συνδέσου ως διαχειριστής για να στείλεις τις αλλαγές.','warning')};
  document.getElementById('cloudRetry').onclick=retryPending;
  retryVisible.onclick=retryPending;
  modal.addEventListener('cancel',e=>{e.preventDefault();closeModal()});
  adminMode(!!editorKey && !!workerURL);
  banner('Φόρτωση δημοσιευμένων αλλαγών…');
  reloadRemote().then(async()=>{
    if(editorKey && workerURL){
      try{await api('/auth',{key:editorKey});if(pending.size)pump();}
      catch{editorKey='';setSession('');adminMode(false);banner('Η προηγούμενη σύνδεση έληξε. Συνδέσου ξανά.','warning')}
    }
  }).catch(e=>banner('Το λεξικό λειτουργεί, αλλά δεν φορτώθηκαν οι ενημερώσεις GitHub: '+e.message,'warning'));
})();
