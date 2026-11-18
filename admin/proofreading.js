(() => {
  'use strict';
  if (STANDALONE || !IS_ADMIN_PAGE) return;

  const labels = {
    known: 'Ελεγμένη πρόταση', unknown: 'Τύπος προς έλεγχο',
    apostrophe: 'Τυπογραφική απόστροφος', spacing: 'Πολλαπλά κενά', invisible: 'Αόρατος χαρακτήρας'
  };
  const fields = {definition: 'editDefinition', lemma: 'editLemma', root: 'editRoot',
    diminutive: 'editDiminutive'};
  const fieldLabels = {definition: 'Επεξήγηση', lemma: 'Λήμμα', root: 'Ρίζα', diminutive: 'Υποκοριστικό'};
  const dialog = byId('proofDialog');
  const editor = byId('editorDialog');
  const key = 'pontian-proofreading-accepted-' + EDITION_ID;
  let accepted = new Set();
  try {
    const words = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(words)) accepted = new Set(words.filter(word => typeof word === 'string'));
  } catch { /* Local preferences are optional. */ }

  let reportPromise;
  let report;
  let knownWords;
  let filtered = [];
  let groupIndex = 0;
  let useIndex = 0;
  let selected;
  let paintRevision = 0;
  let inlineTimer;
  const wordKey = value => value.normalize('NFC');
  const canEdit = () => document.body.classList.contains('admin-mode');
  function getReport() {
    if (reportPromise) return reportPromise;
    reportPromise = fetch(new URL('admin/proofreading-report.json?v=1', document.baseURI))
      .then(response => {
        if (!response.ok) throw new Error('Η αναφορά δεν είναι διαθέσιμη.');
        return response.json();
      })
      .then(file => {
        if (file.format !== 'pontian-proofreading-v1' || file.edition !== EDITION_ID) {
          throw new Error('Η αναφορά ανήκει σε διαφορετική έκδοση της βάσης.');
        }
        report = file;
        knownWords = new Map(file.groups.filter(group => group.rule === 'known' || group.rule === 'unknown')
          .map(group => [wordKey(group.token), group]));
        return file;
      }).catch(error => {
        reportPromise = null;
        throw error;
      });
    return reportPromise;
  }

  function getField(id, field) {
    const row = dictionarySnapshot(id);
    const index = {lemma: 0, definition: 1, root: 2, diminutive: 6}[field];
    return index === undefined ? row[5][Number(field.split(':')[1])] : row[index];
  }
  async function fingerprint(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function filter() {
    const term = normalize(byId('proofQuery').value);
    const kind = byId('proofKind').value;
    const includeAccepted = byId('proofShowAccepted').checked;
    filtered = report?.groups.filter(group =>
      (!kind || group.rule === kind) &&
      (!term || normalize(group.token).includes(term)) &&
      (includeAccepted || group.rule !== 'unknown' || !accepted.has(wordKey(group.token)))) ?? [];
    groupIndex = 0;
    useIndex = 0;
    render();
  }
  function moveGroup(step) {
    groupIndex = Math.max(0, Math.min(filtered.length - 1, groupIndex + step));
    useIndex = 0;
    render();
  }
  function moveUse(step) {
    useIndex = Math.max(0, Math.min((filtered[groupIndex]?.uses.length ?? 1) - 1, useIndex + step));
    render();
  }

  async function render() {
    const revision = ++paintRevision;
    selected = null;
    const group = filtered[groupIndex];
    byId('proofResult').hidden = !group;
    byId('proofGroupCount').textContent = group ? `Ομάδα ${groupIndex + 1} από ${filtered.length}` :
      report ? 'Δεν υπάρχουν ευρήματα για αυτά τα φίλτρα.' : 'Φόρτωση αναφοράς…';
    byId('proofPrev').disabled = !group || groupIndex === 0;
    byId('proofNext').disabled = !group || groupIndex >= filtered.length - 1;
    if (!group) return;

    const [id, field, offset] = group.uses[useIndex];
    const text = getField(id, field);
    const codePoints = Array.from(text ?? '');
    const start = codePoints.slice(0, offset).join('').length;
    const end = start + group.token.length;
    const accept = byId('proofAccept');
    const unknown = group.rule === 'unknown';
    const word = wordKey(group.token);
    accept.hidden = !unknown;
    accept.textContent = accepted.has(word) ? 'Αφαίρεση αποδοχής' : 'Αποδοχή τύπου';
    byId('proofWord').textContent = `${labels[group.rule]} · ${group.token.trim() || 'κενό'}`;
    byId('proofUseCount').textContent = `Εμφάνιση ${useIndex + 1} από ${group.uses.length}`;
    byId('proofUsePrev').disabled = useIndex === 0;
    byId('proofUseNext').disabled = useIndex >= group.uses.length - 1;
    byId('proofLemma').textContent = `${DATA[id][0]} · ${fieldLabels[field] ?? 'Παραλλαγή'}`;
    const context = byId('proofContext');
    context.textContent = text ?? '';
    const choices = byId('proofChoice');
    choices.replaceChildren(new Option('Επιλογή πρότασης', ''));
    const proposals = group.replacement === null ? group.suggestions ?? [] : [group.replacement];
    for (const option of proposals) choices.add(new Option(option === ' ' ? 'Ένα κενό' : option, option));
    if (group.replacement !== null) choices.selectedIndex = 1;
    choices.hidden = !proposals.length;
    byId('proofApply').disabled = true;
    byId('proofOpenEditor').disabled = DELETED.has(id);
    byId('proofState').textContent = 'Έλεγχος της τρέχουσας τιμής…';
    const current = typeof text === 'string' && !DELETED.has(id) && text.slice(start, end) === group.token &&
      await fingerprint(text) === report.fingerprints[`${id}:${field}`];
    if (revision !== paintRevision) return;
    selected = {id, field, text, start, end, current, group};
    if (current) {
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      context.replaceChildren(text.slice(0, start), mark, text.slice(end));
    }
    byId('proofState').textContent = current ? '' : 'Η εγγραφή έχει αλλάξει από τη σάρωση. Έλεγξέ την στον editor.';
    choices.onchange();
  }

  byId('proofChoice').onchange = () => {
    byId('proofApply').disabled = !selected?.current || !byId('proofChoice').value;
  };
  function openSelected(apply) {
    if (!canEdit() || !selected || DELETED.has(selected.id)) return;
    const {id, field, text, start, end, current, group} = selected;
    if (apply && (!current || getField(id, field) !== text)) {
      render();
      return;
    }
    const replacement = byId('proofChoice').value;
    dialog.close();
    openEditor(id);
    if (!apply || !replacement || editorIndex !== id) return;
    const input = byId(fields[field] ?? 'editVariants');
    if (fields[field]) input.setRangeText(replacement, start, end, 'select');
    else {
      const variants = input.value.split('\n');
      const index = Number(field.split(':')[1]);
      variants[index] = text.slice(0, start) + replacement + text.slice(end);
      input.value = variants.join('\n');
    }
    input.focus();
    updateEditorPreview();
    showInline();
    byId('proofInlineMessage').textContent = `Η πρόταση για «${group.token}» μπήκε στον editor. Έλεγξέ την πριν από την αποθήκευση.`;
  }

  byId('proofOpen').onclick = async () => {
    if (!canEdit()) return;
    dialog.showModal();
    if (report) { render(); return; }
    try {
      await getReport();
      byId('proofSummary').textContent = `Σάρωση ${report.scanned.toLocaleString('el-GR')} εγγραφών · στιγμιότυπο διορθώσεων ${new Intl.DateTimeFormat('el-GR', {dateStyle:'medium', timeZone:'Europe/Athens'}).format(new Date(report.overlayUpdatedAt))}`;
      filter();
    } catch {
      byId('proofGroupCount').textContent = 'Η αναφορά δεν φορτώθηκε. Δοκίμασε ξανά όταν υπάρχει σύνδεση.';
    }
  };
  byId('proofClose').onclick = () => dialog.close();
  byId('proofQuery').oninput = byId('proofKind').onchange = byId('proofShowAccepted').onchange = filter;
  byId('proofPrev').onclick = () => moveGroup(-1);
  byId('proofNext').onclick = () => moveGroup(1);
  byId('proofUsePrev').onclick = () => moveUse(-1);
  byId('proofUseNext').onclick = () => moveUse(1);
  byId('proofOpenEditor').onclick = () => openSelected(false);
  byId('proofApply').onclick = () => openSelected(true);
  dialog.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    (event.shiftKey ? moveUse : moveGroup)(event.key === 'ArrowLeft' ? -1 : 1);
  });
  byId('proofAccept').onclick = () => {
    if (selected?.group.rule !== 'unknown') return;
    const word = wordKey(selected.group.token);
    const next = new Set(accepted);
    if (next.has(word)) next.delete(word);
    else next.add(word);
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
      accepted = next;
      filter();
    } catch {
      byId('proofState').textContent = 'Η επιλογή δεν αποθηκεύτηκε στον browser.';
    }
  };
  byId('proofExport').onclick = () => downloadBlob('pontian-accepted-words.json',
    JSON.stringify([...accepted].sort((left, right) => left.localeCompare(right, 'el')), null, 2), 'application/json');

  async function showInline() {
    if (!editor.open || !canEdit()) return;
    const output = byId('proofInline');
    try { await getReport(); } catch { /* Typographic checks can run without the report. */ }
    if (!editor.open) return;
    const definition = byId('editDefinition').value;
    const flags = new Set();
    const relevant = Object.values(fields).map(id => byId(id).value).concat(byId('editVariants').value);
    if (relevant.some(text => text.includes("'"))) flags.add('Τυπογραφική απόστροφος ’');
    if (relevant.some(text => / {2,}/.test(text))) flags.add('Πολλαπλά κενά');
    if (relevant.some(text => /[\u00ad\u200b\ufeff]/.test(text))) flags.add('Αόρατος χαρακτήρας');
    for (const match of definition.matchAll(/[\p{Script=Greek}\p{M}]+/gu)) {
      const word = wordKey(match[0]);
      const finding = knownWords?.get(word);
      if (!finding || (finding.rule === 'unknown' && accepted.has(word))) continue;
      flags.add(finding.replacement ? `${word} → ${finding.replacement}` : `${word} (προς έλεγχο)`);
    }
    output.textContent = flags.size ? [...flags].slice(0, 12).join(' · ') +
      (flags.size > 12 ? ` · και ${flags.size - 12} ακόμη` : '') : 'Δεν βρέθηκε επισήμανση από τους διαθέσιμους κανόνες.';
    if (!report) output.textContent += ' Η αναφορά Hunspell δεν είναι διαθέσιμη.';
  }
  new MutationObserver(() => {
    if (!editor.open) byId('proofInlineMessage').textContent = '';
    else showInline();
  }).observe(editor, {attributes: true, attributeFilter: ['open']});
  editor.addEventListener('input', () => {
    clearTimeout(inlineTimer);
    inlineTimer = setTimeout(showInline, 200);
  });
})();
