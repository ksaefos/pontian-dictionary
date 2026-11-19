/* Public reads and authenticated editor synchronization. */
(() => {
  'use strict';
  const WORKER = 'https://pontian-dictionary-sync.ksaefos.workers.dev';
  const SNAPSHOT_KEY = 'pontian-dictionary-published-' + EDITION_ID;
  const LEGACY_PENDING = 'pontian-dictionary-github-pending-' + EDITION_ID;
  const SESSION_KEY = 'pontian-dictionary-editor-session';
  const status = byId('cloudStatus');
  let remote = null;
  let hasWorkerSnapshot = false;
  const base = id => [...BASE_ROWS[id], ''];
  const isDeleted = row => row?.deleted === true;
  const validId = id => /^(0|[1-9][0-9]*)$/.test(id) && Number(id) < DATA.length;
  const validRow = row => (isDeleted(row) && Object.keys(row).length === 1) ||
    (Array.isArray(row) && [6, 7].includes(row.length) &&
    row.slice(0, 5).every(value => typeof value === 'string') &&
    Array.isArray(row[5]) && row[5].every(value => typeof value === 'string') &&
    (row.length === 6 || typeof row[6] === 'string'));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const canonical = row => Array.isArray(row) && row.length === 6 ? [...row, ''] : row;
  const published = id => remote?.edits[id] ?? null;
  const statusText = (message, state = '') => {
    status.textContent = message;
    status.dataset.state = state;
    byId('cloudDialogStatus').textContent = message;
  };

  function stored(key) {
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return null; }
  }
  function validate(file) {
    if (file?.format !== 'pontian-github-edits-v1' || file.baseVersion !== EDITION_ID ||
        file.total !== DATA.length || !file.edits || typeof file.edits !== 'object' ||
        Array.isArray(file.edits) ||
        Object.entries(file.edits).some(([id, row]) => !validId(id) || !validRow(row))) {
      throw new Error('Το αρχείο διορθώσεων δεν αντιστοιχεί στη βάση ή περιέχει μη έγκυρα δεδομένα.');
    }
    return file;
  }
  async function api(path, {key, changes} = {}) {
    const response = await fetch(WORKER + path, {
      method: changes ? 'POST' : 'GET',
      headers: {
        ...(key ? {Authorization: 'Bearer ' + key} : {}),
        ...(changes ? {'Content-Type': 'application/json'} : {})
      },
      body: changes ? JSON.stringify({changes}) : undefined,
      cache: 'no-store'
    });
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  function showRows(drafts = new Map()) {
    const touched = new Set([...CHANGED, ...Object.keys(remote?.edits ?? {}).map(Number), ...drafts.keys()]);
    for (const id of touched) {
      const row = drafts.has(id) ? drafts.get(id).row : published(id);
      saveRow(id, row ?? base(id));
    }
    updateChangedCounter();
    rebuildPartFilter();
    update();
  }
  function usePublished(file) {
    remote = validate(file);
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(remote)); }
    catch { /* The published snapshot is also available online. */ }
  }
  try {
    const cached = stored(SNAPSHOT_KEY);
    if (cached) usePublished(cached);
  } catch { /* Ignore incompatible snapshots. */ }

  async function readWorker() {
    usePublished(await api('/edits'));
    hasWorkerSnapshot = true;
  }
  async function readPublished() {
    try { await readWorker(); }
    catch (workerError) {
      const response = await fetch(new URL('data/edits.json', document.baseURI), {cache: 'no-store'});
      if (!response.ok) throw workerError;
      const file = validate(await response.json());
      if (!remote || (file.updatedAt ?? '') >= (remote.updatedAt ?? '')) usePublished(file);
    }
  }

  if (!IS_ADMIN_PAGE) {
    showRows();
    readPublished().then(() => showRows()).catch(() => {});
    return;
  }

  const modal = byId('cloudDialog');
  const retry = byId('cloudRetryVisible');
  const pendingActions = byId('cloudPendingActions');
  let key = '';
  let pending = new Map();
  let sending = false;
  let timer;
  let sendAgain = false;
  let database;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('pontian-editor-' + EDITION_ID) : null;
  const openDatabase = () => database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pontian-dictionary-editor-' + EDITION_ID, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('rows', {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function transact(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rows', mode);
      const store = tx.objectStore('rows');
      const request = store.getAll();
      let result;
      let failure;
      request.onsuccess = () => {
        try { result = operation(new Map(request.result.map(item => [item.id, item])), store); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Η τοπική αποθήκευση απέτυχε.'));
    });
  }
  function controls() {
    const count = pending.size;
    pendingActions.hidden = !key || !count;
    retry.disabled = sending;
    byId('cloudRetry').hidden = !count;
    byId('cloudRetry').disabled = sending;
  }
  async function reloadDrafts() {
    pending = await transact('readonly', rows => new Map([...rows].filter(([, item]) => item.pending)));
    showRows(key ? pending : undefined);
    controls();
  }
  channel?.addEventListener('message', () => {
    if (!sending) refresh().catch(() => {});
  });
  function setSession(value) {
    try {
      if (value) sessionStorage.setItem(SESSION_KEY, value);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* The current authenticated tab can still be used. */ }
  }
  function adminMode(value) {
    document.body.classList.toggle('admin-mode', value);
    byId('cloudOpen').setAttribute('aria-pressed', String(value));
    byId('cloudOpen').querySelector('.cloud-open-label').textContent = value ? 'Διαχειριστής' : 'Διαχείριση';
    controls();
  }
  function closeModal() { modal.close(); }
  function fail(error) {
    statusText(error.message || 'Η ενέργεια απέτυχε.', 'error');
  }
  async function refresh() {
    await readPublished();
    await reloadDrafts();
    statusText(pending.size ? `Εκκρεμούν ${pending.size} τοπικές αλλαγές.` : key ? 'Συνδεδεμένος διαχειριστής.' : '', pending.size ? 'warning' : 'ok');
  }
  async function login(value, automatic = false) {
    if (!value) throw new Error('Συμπλήρωσε τον κωδικό πρόσβασης.');
    await api('/auth', {key: value});
    key = value;
    setSession(key);
    adminMode(true);
    byId('editorAccessKey').value = '';
    if (!automatic) closeModal();
    await reloadDrafts();
    if (pending.size) await pump();
    else statusText('Συνδεδεμένος διαχειριστής.', 'ok');
  }
  function logout() {
    key = '';
    setSession('');
    byId('editorAccessKey').value = '';
    adminMode(false);
    closeModal();
    showRows();
    statusText('Αποσυνδέθηκες.', 'ok');
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => pump(), 650);
  }
  function makeDraft(id, submitted, previous, opening, held) {
    const row = !isDeleted(submitted) && same(canonical(submitted), base(id)) ? null : canonical(submitted);
    const expected = previous?.pending ? previous.expected : opening.expected;
    const before = isDeleted(row) && !DELETED.has(id) ? dictionarySnapshot(id) :
      isDeleted(row) ? (previous?.before ?? null) : null;
    return {id, expected, row, before, held, pending: true, revision: crypto.randomUUID()};
  }
  async function stageMany(list, held = false) {
    if (!key) throw new Error('Συνδέσου ως διαχειριστής.');
    if (!hasWorkerSnapshot && !remote) throw new Error('Χρειάζεται πρώτα ένα επιβεβαιωμένο στιγμιότυπο διορθώσεων.');
    try {
      await transact('readwrite', (rows, store) => {
        for (const [id, row, opening] of list) {
          const previous = rows.get(id);
          const current = previous?.pending ? previous.revision : null;
          if (current !== opening.revision) throw new Error('Η εγγραφή άλλαξε σε άλλη καρτέλα. Κράτησε το κείμενό σου και άνοιξε ξανά την εγγραφή.');
          const draft = makeDraft(id, row, previous, opening, held);
          if (same(canonical(draft.expected), draft.row) &&
              !previous?.pending) {
            if (isDeleted(published(id)) && previous?.before) store.put({...previous, pending: false});
            else store.delete(id);
          } else store.put(draft);
        }
      });
    } catch (error) {
      throw new Error('Η αλλαγή δεν αποθηκεύτηκε τοπικά. ' + error.message);
    }
    await reloadDrafts();
    channel?.postMessage('draft');
    statusText(pending.size ? `Τοπική αποθήκευση ολοκληρώθηκε · εκκρεμούν ${pending.size}.` : 'Δεν εκκρεμεί αλλαγή.', 'ok');
    if (!held) schedule();
  }
  async function acknowledge(item) {
    await transact('readwrite', (rows, store) => {
      if (rows.get(item.id)?.revision !== item.revision) return;
      if (isDeleted(item.row) && item.before) store.put({...item, pending: false});
      else store.delete(item.id);
    });
  }
  async function pump(review = false) {
    if (!key) return;
    if (sending) { sendAgain = true; return; }
    if (navigator.locks) {
      await navigator.locks.request('pontian-editor-sync-' + EDITION_ID, () => send(review));
    } else await send(review);
  }
  async function send(review) {
    if (!key || sending) return;
    sending = true;
    controls();
    try {
      await readWorker();
      await reloadDrafts();
      const ready = [];
      let conflicts = 0;
      for (const item of pending.values()) {
        if (item.held && (!review || !confirm(`Να σταλεί η εισαγόμενη τιμή για «${BASE_ROWS[item.id][0]}»;`))) continue;
        const latest = published(item.id);
        if (same(canonical(latest), canonical(item.row))) {
          await acknowledge(item);
        } else if (same(canonical(latest), canonical(item.expected))) {
          ready.push({...item, expected: latest});
        } else {
          conflicts++;
          if (review && confirm(`Σύγκρουση για «${BASE_ROWS[item.id][0]}».\n\nΔημοσιευμένη τιμή: ${describe(item.id, latest)}\n\nΤοπική τιμή: ${describe(item.id, item.row)}\n\nΝα δημοσιευτεί η τοπική τιμή;`)) {
            ready.push({...item, expected: latest});
          }
        }
      }
      for (let start = 0; start < ready.length && key; start += 100) {
        const batch = ready.slice(start, start + 100);
        const changes = Object.fromEntries(batch.map(({id, expected, row}) => [id, {expected, row}]));
        statusText(`Αποστολή ${batch.length} αλλαγών…`);
        await api('/save', {key, changes});
        // Confirm the committed value from the Worker before removing durable drafts.
        await readWorker();
        for (const item of batch) {
          if (same(canonical(published(item.id)), canonical(item.row))) await acknowledge(item);
        }
        channel?.postMessage('published');
      }
      await reloadDrafts();
      statusText(pending.size ? `Εκκρεμούν ${pending.size} αλλαγές${conflicts ? ' · απαιτείται έλεγχος σύγκρουσης' : ''}.` :
        'Οι αλλαγές είναι συγχρονισμένες.', pending.size ? 'warning' : 'ok');
    } catch (error) {
      if (error.status === 401) logout();
      statusText(error.status === 409 ? 'Το GitHub άλλαξε στη διάρκεια της αποστολής. Οι εκκρεμότητες διατηρούνται.' :
        'Ο συγχρονισμός δεν ολοκληρώθηκε. Οι εκκρεμότητες διατηρούνται. ' + error.message, 'error');
    } finally {
      sending = false;
      controls();
      if (sendAgain) { sendAgain = false; schedule(); }
    }
  }
  function describe(id, row) {
    return isDeleted(row) ? 'Διαγραμμένο' : JSON.stringify(row ?? base(id));
  }
  async function reviewLegacy() {
    if (!key) throw new Error('Συνδέσου ως διαχειριστής.');
    await readWorker();
    await reloadDrafts();
    const legacy = stored(STORAGE_KEY);
    const local = legacy?.edition === EDITION_ID && legacy.size === DATA.length ? legacy.edits : {};
    const candidates = {...local, ...stored(LEGACY_PENDING)};
    const reviewed = [];
    for (const [id, row] of Object.entries(candidates)) {
      if (!validId(id) || (row !== null && !validRow(row)) || pending.has(Number(id))) continue;
      const latest = published(id);
      if (same(canonical(row ?? base(id)), canonical(latest ?? base(id)))) continue;
      if (confirm(`Παλιά τοπική τιμή για «${BASE_ROWS[id][0]}».\n\nΔημοσιευμένη: ${describe(id, latest)}\n\nΤοπική: ${describe(id, row)}\n\nΝα μπει στην ουρά για αποστολή;`)) {
        reviewed.push([Number(id), row ?? base(id), opening(Number(id))]);
      }
    }
    if (reviewed.length) await stageMany(reviewed);
    else statusText('Δεν επιλέχθηκαν παλιές αλλαγές.', 'ok');
  }

  async function recovery(id) {
    const saved = await transact('readonly', rows => rows.get(id));
    if (saved?.before) return saved.before;
    try {
      const repo = 'https://api.github.com/repos/ksaefos/pontian-dictionary/commits';
      const commits = await fetch(repo + '?sha=main&path=data%2Fedits.json&per_page=30');
      if (!commits.ok) throw new Error();
      let found = false;
      for (const {sha} of await commits.json()) {
        if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error();
        const response = await fetch('https://raw.githubusercontent.com/ksaefos/pontian-dictionary/' + sha + '/data/edits.json');
        if (!response.ok) throw new Error();
        const entry = validate(await response.json()).edits[id] ?? null;
        if (isDeleted(entry)) found = true;
        else if (found) return entry ?? base(id);
        else break;
      }
    } catch { /* Offer explicit recovery from the embedded base when history is unavailable. */ }
    if (confirm('Η τιμή πριν από τη διαγραφή δεν βρέθηκε στο ιστορικό. Να χρησιμοποιηθεί η αρχική εγγραφή της βάσης;')) return base(id);
    throw new Error('Η επαναφορά ακυρώθηκε.');
  }

  const opening = id => ({revision: pending.get(id)?.revision ?? null, expected: published(id)});
  syncEditor = {
    revision: opening,
    stage: (id, row, revision) => stageMany([[id, row, revision]]),
    stageBatch: stageMany,
    importRows: list => stageMany(list.map(([id, row]) => [Number(id), row, opening(Number(id))]), true),
    recovery
  };
  byId('cloudOpen').onclick = () => modal.showModal();
  byId('cloudConnect').onclick = () => login(byId('editorAccessKey').value.trim()).catch(fail);
  byId('cloudDisconnect').onclick = logout;
  byId('cloudClose').onclick = closeModal;
  byId('cloudRefresh').onclick = () => refresh().catch(fail);
  byId('cloudPublishLocal').onclick = () => reviewLegacy().catch(fail);
  retry.onclick = byId('cloudRetry').onclick = () => pump(true);
  window.addEventListener('online', () => pump());
  showRows();
  const initialized = refresh().catch(fail);
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) initialized.then(() => login(saved, true)).catch(error => {
      if (error.status === 401) setSession('');
      fail(error);
    });
  } catch { /* No session storage is available. */ }
})();
