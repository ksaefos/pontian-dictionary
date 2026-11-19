(() => {
  'use strict';
  if (STANDALONE || !IS_ADMIN_PAGE) return;

  const labels = {
    known: 'Ελεγμένη πρόταση', unknown: 'Τύπος προς έλεγχο',
    abbreviation: 'Ενοποίηση συντομογραφίας', historical: 'Ιστορική μέση φωνή',
    'abbreviation-review': 'Πιθανή συντομογραφία',
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
  let queueInitialized = false;
  let knownWords;
  let filtered = [];
  let groupIndex = 0;
  let useIndex = 0;
  let selected;
  let paintRevision = 0;
  let inlineTimer;
  let inlineFormRules = new Map();
  let batch = [];
  let busy = false;
  let activeMark = -1;
  const ignored = new Set();
  const wordKey = value => value.normalize('NFC');
  const canEdit = () => document.body.classList.contains('admin-mode');
  function getReport() {
    if (reportPromise) return reportPromise;
    reportPromise = fetch(new URL('admin/proofreading-report.json?v=2', document.baseURI))
      .then(response => {
        if (!response.ok) throw new Error('Η αναφορά δεν είναι διαθέσιμη.');
        return response.json();
      })
      .then(file => {
        if (file.format !== 'pontian-proofreading-v2' || file.edition !== EDITION_ID) {
          throw new Error('Η αναφορά ανήκει σε διαφορετική έκδοση της βάσης.');
        }
        report = file;
        inlineFormRules = new Map(Object.values(file.abbreviations)
          .flatMap(rule => rule.forms.map(form => [form, rule])));
        knownWords = new Map(file.groups.filter(group => group.rule === 'known' || group.rule === 'unknown')
          .map(group => [wordKey(group.token), group]));
        for (const [word, replacement] of Object.entries(file.corrections)) {
          knownWords.set(word, {rule:'known', replacement});
        }
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
    batch = [];
    byId('proofBatchPanel').hidden = true;
    byId('proofBatchOpen').hidden = true;
    byId('proofSaveNext').disabled = true;
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
    byId('proofBatchOpen').hidden = group.rule !== 'abbreviation' || group.uses.length < 2;
    choices.onchange();
  }

  byId('proofChoice').onchange = () => {
    byId('proofApply').disabled = busy || !selected?.current || !byId('proofChoice').value;
    byId('proofSaveNext').disabled = byId('proofApply').disabled || selected?.field !== 'definition';
  };
  function openSelected(apply) {
    if (busy || !canEdit() || !selected || DELETED.has(selected.id)) return;
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

  }

  byId('proofOpen').onclick = async () => {
    if (!canEdit()) return;
    dialog.showModal();
    if (queueInitialized) { render(); return; }
    try {
      await getReport();
      byId('proofSummary').textContent = `Σάρωση ${report.scanned.toLocaleString('el-GR')} εγγραφών · στιγμιότυπο διορθώσεων ${new Intl.DateTimeFormat('el-GR', {dateStyle:'medium', timeZone:'Europe/Athens'}).format(new Date(report.overlayUpdatedAt))}`;
      queueInitialized = true;
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

  async function saveDefinitionRows(changes) {
    if (busy || !canEdit() || !changes.length) return;
    busy = true;
    byId('proofChoice').onchange();
    byId('proofBatchSave').disabled = true;
    try {
      const staged = changes.map(({id, before, after}) => {
        const row = dictionarySnapshot(id);
        if (DELETED.has(id) || row[1] !== before) throw new Error('Κάποια επεξήγηση άλλαξε. Άνοιξε ξανά την προεπισκόπηση.');
        row[1] = after;
        return [id, row, syncEditor.revision(id)];
      });
      await syncEditor.stageBatch(staged);
      return true;
    } catch (error) {
      byId('proofState').textContent = error.message;
      if (!byId('proofBatchPanel').hidden) byId('proofBatchStatus').textContent = error.message;
      return false;
    } finally {
      busy = false;
      byId('proofChoice').onchange();
      byId('proofBatchSave').disabled = false;
    }
  }

  byId('proofSaveNext').onclick = async () => {
    if (!selected?.current || selected.field !== 'definition') return;
    const {id, text, start, end} = selected;
    const proposal = byId('proofChoice').value;
    if (!proposal) return;
    const revision = paintRevision;
    if (await saveDefinitionRows([{id, before: text, after: text.slice(0, start) + proposal + text.slice(end)}]) &&
        revision === paintRevision) {
      if (useIndex + 1 < filtered[groupIndex].uses.length) moveUse(1);
      else if (groupIndex + 1 < filtered.length) moveGroup(1);
      else render();
    }
  };
  async function prepareBatch(groups) {
    if (busy || !groups.length) return;
    const revision = ++paintRevision;
    const byEntry = new Map();
    for (const group of groups) {
      for (const [id, , offset] of group.uses) {
        if (!byEntry.has(id)) byEntry.set(id, []);
        byEntry.get(id).push({offset, group});
      }
    }
    const candidates = await Promise.all([...byEntry].map(async ([id, offsets]) => {
      const before = DATA[id][1];
      if (DELETED.has(id) || await fingerprint(before) !== report.fingerprints[`${id}:definition`]) return null;
      const after = Array.from(before);
      for (const {offset, group} of offsets.sort((first, second) => second.offset - first.offset)) {
        after.splice(offset, Array.from(group.token).length, group.replacement);
      }
      return {id, before, after: after.join('')};
    }));
    if (revision !== paintRevision) return;
    batch = candidates.filter(Boolean);
    const items = batch.map(({id, before, after}) => {
      const item = document.createElement('li');
      item.textContent = `${DATA[id][0]} · ${before} → ${after}`;
      return item;
    });
    byId('proofBatchPreview').replaceChildren(...items);
    byId('proofBatchPanel').hidden = false;
    byId('proofBatchSave').disabled = !batch.length;
    byId('proofBatchStatus').textContent = `${batch.length} λήμματα προς αποθήκευση · ${candidates.length - batch.length} μεταβλήθηκαν μετά τη σάρωση.`;
    byId('proofBatchPanel').scrollIntoView({block:'nearest'});
  }
  byId('proofBatchOpen').onclick = () => {
    if (selected?.group.rule === 'abbreviation') prepareBatch([selected.group]);
  };
  byId('proofNormalizeAll').onclick = () => {
    if (report) prepareBatch(report.groups.filter(group => group.rule === 'abbreviation'));
  };
  byId('proofBatchSave').onclick = async () => {
    if (!batch.length || !confirm(`Να αποθηκευτούν και να σταλούν οι αλλαγές σε ${batch.length} λήμματα;`)) return;
    if (await saveDefinitionRows(batch)) render();
  };

  const definitionInput = byId('editDefinition');
  const preview = byId('editPreview');
  const inlineOptions = byId('proofInlineOptions');
  const inlineBar = byId('proofInlineBar');
  const greek = /[\p{Script=Greek}\p{M}]+/gu;
  function button(label, click) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'm-btn';
    element.textContent = label;
    element.onclick = click;
    return element;
  }
  function inlineFindings(text) {
    const hits = [];
    for (const match of text.matchAll(greek)) {
      const word = wordKey(match[0]);
      const start = match.index;
      let end = start + match[0].length;
      const dotted = text[end] === '.' && text[end + 1] !== '.';
      const form = inlineFormRules.get(word);
      if (form && (dotted || form.bare)) {
        if (dotted) end++;
        let proposal = form.canonical;
        if (proposal === '(μεταφορικά)' && text[start - 1] === '(') proposal = 'μεταφορικά';
        if (proposal && /[\p{Script=Greek}\p{M}]/u.test(text[end] ?? '')) proposal += ' ';
        if (proposal && proposal !== text.slice(start, end)) hits.push({start, end, kind:'abbreviation', label:form.label, proposals:[proposal]});
        else if (report.abbreviations.μεσ.forms.includes(word)) hits.push({start, end, kind:'historical', label:form.label, proposals:[]});
        continue;
      }
      const finding = knownWords?.get(word);
      if (!finding || ignored.has(word) || (finding.rule === 'unknown' && accepted.has(word))) continue;
      if (finding.rule === 'unknown' && (/[’']/u.test(text[start - 1] ?? '') || /[’']/u.test(text[end] ?? '') ||
          (dotted && word.length <= 7 && /^\p{Ll}/u.test(text.slice(end + 1).trimStart())))) continue;
      hits.push({start, end, kind:finding.rule, label:labels[finding.rule], word,
        proposals:finding.replacement ? [finding.replacement] : finding.suggestions ?? []});
    }
    for (const [pattern, proposal, kind] of [[/'/g, '’', 'apostrophe'], [/ {2,}/g, ' ', 'spacing'], [/[\u00ad\u200b\ufeff]/g, '', 'invisible']]) {
      for (const item of text.matchAll(pattern)) {
        hits.push({start:item.index, end:item.index + item[0].length, kind, label:labels[kind], proposals:[proposal]});
      }
    }
    return hits.sort((left, right) => left.start - right.start);
  }

  async function showInline() {
    if (!editor.open || !canEdit()) return;
    try { await getReport(); } catch { /* Typographic checks can run without the report. */ }
    if (!editor.open || !canEdit()) return;
    const text = definitionInput.value;
    const hits = inlineFindings(text);
    inlineOptions.hidden = true;
    inlineBar.hidden = !hits.length;
    byId('proofNormalizeEntry').hidden = !hits.some(hit => hit.kind === 'abbreviation');
    activeMark = -1;
    byId('proofInline').textContent = hits.length ? `${hits.length} επισημάνσεις · πάτησε μια υπογραμμισμένη λέξη.` :
      report ? 'Καμία επισήμανση από τους διαθέσιμους κανόνες.' : 'Η αναφορά Hunspell δεν είναι διαθέσιμη.';
    if (!hits.length) { updateEditorPreview(); return; }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let markIndex = 0;
    for (const chunk of text.split(/(\([^()]{1,320}\))/g)) {
      const limit = cursor + chunk.length;
      const target = chunk.startsWith('(') && chunk.endsWith(')') ? document.createElement('em') : fragment;
      while (markIndex < hits.length && hits[markIndex].start < limit) {
        const index = markIndex++;
        const hit = hits[index];
        target.append(text.slice(cursor, hit.start));
        const term = text.slice(hit.start, hit.end);
        const mark = button(hit.kind === 'invisible' ? '◌' : term, () => openInlineOptions(hit, index, text));
        mark.className = 'proof-mark';
        mark.dataset.kind = hit.kind;
        mark.setAttribute('aria-label', `${hit.label} · ${term.trim() || 'κενό'}`);
        mark.setAttribute('aria-pressed', 'false');
        target.append(mark);
        cursor = hit.end;
      }
      target.append(text.slice(cursor, limit));
      if (target !== fragment) fragment.append(target);
      cursor = limit;
    }
    preview.replaceChildren(fragment);
  }

  byId('proofNormalizeEntry').onclick = () => {
    const text = definitionInput.value;
    const replacements = inlineFindings(text).filter(hit => hit.kind === 'abbreviation');
    for (const hit of replacements.reverse()) definitionInput.setRangeText(hit.proposals[0], hit.start, hit.end);
    updateEditorPreview();
    showInline();
    definitionInput.focus({preventScroll:true});
  };
  function openInlineOptions(hit, index, text) {
    if (definitionInput.value !== text) { showInline(); return; }
    activeMark = index;
    preview.querySelectorAll('.proof-mark').forEach((mark, position) =>
      mark.setAttribute('aria-pressed', String(index === position)));
    const title = document.createElement('span');
    title.textContent = hit.label;
    const proposals = hit.proposals.map(value => button(value === '' ? 'Αφαίρεση' : value === ' ' ? 'Ένα κενό' : value.trim(), () => {
      if (definitionInput.value !== text) { showInline(); return; }
      definitionInput.setRangeText(value, hit.start, hit.end, 'end');
      updateEditorPreview();
      showInline();
      definitionInput.focus({preventScroll:true});
    }));
    const selectText = button('Επεξεργασία', () => {
      definitionInput.focus();
      definitionInput.setSelectionRange(hit.start, hit.end);
    });
    const skip = hit.word && hit.kind === 'unknown' ? [button('Παράβλεψη εδώ', () => {
      ignored.add(hit.word);
      showInline();
    })] : [];
    inlineOptions.replaceChildren(title, ...proposals, selectText, ...skip);
    inlineOptions.hidden = false;
    inlineOptions.querySelector('button')?.focus({preventScroll:true});
    inlineOptions.scrollIntoView({block:'nearest'});
  }
  byId('proofInlineNext').onclick = () => {
    const marks = preview.querySelectorAll('.proof-mark');
    if (marks.length) marks[(activeMark + 1) % marks.length].click();
  };
  new MutationObserver(() => {
    if (!editor.open) { ignored.clear(); return; }
    showInline();
  }).observe(editor, {attributes: true, attributeFilter: ['open']});
  editor.addEventListener('input', () => {
    clearTimeout(inlineTimer);
    inlineTimer = setTimeout(showInline, 120);
  });
  for (const id of ['restoreEditor', 'convertExisting']) {
    byId(id).addEventListener('click', () => queueMicrotask(showInline));
  }
})();
