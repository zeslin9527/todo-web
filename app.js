'use strict';

/* 待办 — iPhone PWA. Plain JS, no build step.
 * Storage: IndexedDB (todo-db / kv store). UI adapted from renderer/panel.js.
 * LLM: 火山方舟 (Doubao) OpenAI-compatible endpoint, user-provided key.
 * The API key is stored only in this device's localStorage and is sent
 * directly from the browser to the endpoint — that is the whole point of
 * bring-your-own-key; it never touches any other server.
 */

const T = window.TodoCore;
const TABS = ['todo', 'completed', 'cancelled'];
const WEEKDAYS = '日一二三四五六';
const CAT_PREFIX = /^([\w一-龥 -]{1,20})[:：]\s*(.+)/;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CHECK_DELAY = REDUCED ? 0 : 600;
const UNCHECK_DELAY = REDUCED ? 0 : 250;
const LONG_PRESS = 500;
const DELETE_W = 64;
const COMMIT_DX = 120;

const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const STT_OFF = params.get('stt') === '0';

// Neutral starter data for a fresh install — teaches the two key gestures.
const SEED_MD = `# 待办

## 工作
- [ ] 点下方的蓝色麦克风，说出你的待办

## 生活
- [ ] 长按这条，可以编辑、移动或删除
`;

let data = { categories: [] };
let tab = 'todo';
let collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));
let lastCat = localStorage.getItem('lastCat') || null;
let suppressAnim = false;
let switching = false;

const $ = (s) => document.querySelector(s);
const dateEl = $('#date'), weekdayEl = $('#weekday'), gearBtn = $('#gearBtn');
const segsEl = $('#segs'), thumbEl = $('#thumb');
const listEl = $('#list'), splitRow = $('#splitRow');
const addEl = $('#add'), addCat = $('#addCat'), addGo = $('#addGo'), addField = $('#addField');
const micBtn = $('#micBtn'), micCapsule = $('#micCapsule'), micInterim = $('#micInterim');
const backdrop = $('#backdrop'), sheetHost = $('#sheetHost'), toastEl = $('#toast');
const importFile = $('#importFile');
const segEls = [...segsEl.querySelectorAll('.seg')];

/* ================= IndexedDB ================= */

const db = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((resolve, reject) => {
      const req = indexedDB.open('todo-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._p;
  },
  async get(key) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readonly').objectStore('kv').get(key);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  // Fire-and-forget write; errors are logged but never block the UI.
  put(key, val) {
    this.open().then((d) => {
      const tx = d.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      tx.onerror = () => console.warn('idb put failed', tx.error);
    }).catch((e) => console.warn('idb open failed', e));
  },
};

function persist() { db.put('data', JSON.parse(JSON.stringify(data))); }

function recomputeIds() {
  data.categories.forEach((c, ci) => c.items.forEach((it, ii) => { it.id = `c${ci}-${ii}`; }));
}

function afterMutation() {
  recomputeIds();
  persist();
  reconcile();
  updateHint();
}

/* ================= data ops ================= */

function findCat(name) { return data.categories.find((c) => c.name === name); }

function opAdd(category, text, status = 'todo') {
  let cat = findCat(category);
  if (!cat) { cat = { name: category, items: [] }; data.categories.push(cat); }
  cat.items.push({ id: '', text, status });
  afterMutation();
}

function opSetStatus(category, index, status) {
  const cat = findCat(category);
  if (!cat || !cat.items[index]) return;
  cat.items[index].status = status;
  afterMutation();
}

function opEdit(category, index, text) {
  const cat = findCat(category);
  if (!cat || !cat.items[index] || !text.trim()) return;
  cat.items[index].text = text.trim();
  afterMutation();
}

function opRemove(category, index) {
  const cat = findCat(category);
  if (!cat || !cat.items[index]) return;
  cat.items.splice(index, 1);
  afterMutation();
}

function opMove(category, index, targetName) {
  const cat = findCat(category);
  if (!cat || !cat.items[index] || category === targetName) return;
  const [item] = cat.items.splice(index, 1);
  let target = findCat(targetName);
  if (!target) { target = { name: targetName, items: [] }; data.categories.push(target); }
  target.items.push(item);
  afterMutation();
}

function opClearCancelled() {
  for (const cat of data.categories) {
    cat.items = cat.items.filter((i) => i.status !== 'cancelled');
  }
  data.categories = data.categories.filter((c) => c.items.length);
  afterMutation();
}

/* ================= chrome ================= */

function updateDate() {
  const d = new Date();
  dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
  weekdayEl.textContent = `星期${WEEKDAYS[d.getDay()]}`;
}

function toast(msg, ms = 3200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.remove('out');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => {
    toastEl.classList.add('out');
    setTimeout(() => { toastEl.hidden = true; }, 260);
  }, ms);
}

/* ================= segmented control ================= */

function positionThumb(animate) {
  const seg = segEls[TABS.indexOf(tab)];
  if (!seg) return;
  if (!animate) thumbEl.style.transition = 'none';
  thumbEl.style.width = `${seg.offsetWidth}px`;
  thumbEl.style.transform = `translateX(${seg.offsetLeft - 2}px)`;
  if (!animate) requestAnimationFrame(() => { thumbEl.style.transition = ''; });
  segEls.forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
}

segEls.forEach((s) => s.addEventListener('click', () => {
  if (s.dataset.tab === tab || switching) return;
  const dir = TABS.indexOf(s.dataset.tab) > TABS.indexOf(tab) ? 'l' : 'r';
  tab = s.dataset.tab;
  positionThumb(true);
  if (REDUCED) { reconcile(); return; }
  switching = true;
  listEl.classList.add(`out-${dir}`);
  setTimeout(() => {
    listEl.classList.remove(`out-${dir}`);
    suppressAnim = true;
    reconcile();
    suppressAnim = false;
    listEl.classList.add(`in-${dir}`);
    setTimeout(() => { listEl.classList.remove(`in-${dir}`); switching = false; }, 230);
  }, 180);
}));

/* ================= FLIP ================= */

function recordTops() {
  const m = new Map();
  for (const el of listEl.querySelectorAll('[data-k]')) {
    if (el.classList.contains('leaving')) continue;
    m.set(el.dataset.k, el.getBoundingClientRect().top);
  }
  return m;
}

function playFlip(before) {
  if (REDUCED || suppressAnim) return;
  for (const el of listEl.querySelectorAll('[data-k]')) {
    if (el.classList.contains('leaving')) continue;
    const t0 = before.get(el.dataset.k);
    if (t0 == null) continue;
    const d = t0 - el.getBoundingClientRect().top;
    if (!d) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${d}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 260ms cubic-bezier(0.32,0.72,0,1)';
      el.style.transform = '';
      el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
    });
  }
}

/* ================= rows ================= */

function exitRow(rw) {
  if (rw.classList.contains('leaving')) return;
  rw.classList.add('leaving');
  if (REDUCED || suppressAnim) { rw.remove(); return; }
  rw.style.maxHeight = `${rw.offsetHeight}px`;
  void rw.offsetHeight;
  rw.style.maxHeight = '0px';
  rw._exitTimer = setTimeout(() => rw.remove(), 250);
}

function enterRow(inner, rw) {
  inner.appendChild(rw);
  if (REDUCED || suppressAnim) return;
  const h = rw.offsetHeight;
  rw.style.maxHeight = '0px';
  rw.style.opacity = '0';
  void rw.offsetHeight;
  rw.style.maxHeight = `${h}px`;
  rw.style.opacity = '1';
  setTimeout(() => { rw.style.maxHeight = ''; rw.style.opacity = ''; }, 260);
}

function closeAllSwiped(except) {
  for (const rw of listEl.querySelectorAll('.rw.open')) {
    if (rw !== except) setSwipe(rw, 0, false);
  }
}

function setSwipe(rw, dx, dragging) {
  const item = rw.querySelector('.item');
  rw.classList.toggle('dragging', !!dragging);
  rw.classList.toggle('swiping', dx < -1);
  rw.classList.toggle('open', dx <= -DELETE_W && !dragging);
  item.style.transform = dx ? `translateX(${Math.min(0, dx)}px)` : '';
  if (!dx) rw.classList.remove('open', 'swiping', 'dragging');
}

function commitDelete(rw) {
  const category = rw.dataset.cat, index = +rw.dataset.index;
  // animate the row fully away, then mutate
  const item = rw.querySelector('.item');
  item.style.transform = `translateX(-${rw.offsetWidth}px)`;
  rw.classList.add('swiping');
  setTimeout(() => opRemove(category, index), 160);
}

function attachRowGestures(rw, row, item) {
  let sx = 0, sy = 0, dx = 0;
  let mode = null; // 'swipe' | 'scroll' | null(undecided)
  let lpTimer = null;
  let lpFired = false;
  let baseOpen = 0; // -DELETE_W if row was open when touch began

  function clearLp() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }

  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; dx = 0;
    mode = null; lpFired = false;
    baseOpen = rw.classList.contains('open') ? -DELETE_W : 0;
    closeAllSwiped(rw);
    lpTimer = setTimeout(() => {
      lpTimer = null; lpFired = true;
      if (navigator.vibrate) navigator.vibrate(10);
      openRowActions(rw, item);
    }, LONG_PRESS);
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const mx = t.clientX - sx, my = t.clientY - sy;
    if (!mode) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      mode = Math.abs(mx) > Math.abs(my) ? 'swipe' : 'scroll';
      clearLp();
    }
    if (mode === 'swipe') {
      dx = Math.min(0, baseOpen + mx);
      // small rubber-band past fully-open
      if (dx > 0) dx *= 0.3;
      setSwipe(rw, dx, true);
      e.preventDefault();
    }
  }, { passive: false });

  function endSwipe() {
    if (mode !== 'swipe') { setSwipe(rw, baseOpen, false); return; }
    if (dx <= -COMMIT_DX || (baseOpen === 0 && dx <= -DELETE_W * 3)) {
      commitDelete(rw);
    } else if (dx <= -DELETE_W / 2) {
      setSwipe(rw, -DELETE_W, false);
    } else {
      setSwipe(rw, 0, false);
    }
    mode = null; dx = 0;
  }

  row.addEventListener('touchend', () => {
    clearLp();
    endSwipe();
    if (lpFired) {
      // swallow the synthetic click that follows the long-press
      const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
      row.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => row.removeEventListener('click', swallow, { capture: true }), 400);
    }
  });
  row.addEventListener('touchcancel', () => { clearLp(); endSwipe(); });

  // tap the revealed red button
  rw.querySelector('.swipe-del').addEventListener('click', () => commitDelete(rw));
  // tapping an open row (not on checkbox) closes the swipe
  row.addEventListener('click', (e) => {
    if (rw.classList.contains('open') && !e.target.closest('.cbox')) setSwipe(rw, 0, false);
  });
}

function createRow(catName, index, item, key) {
  const rw = document.createElement('div');
  rw.className = 'rw';
  rw.dataset.k = key;
  rw.dataset.cat = catName;
  rw.dataset.index = String(index);

  const del = document.createElement('div');
  del.className = 'swipe-del';
  del.textContent = '删除';

  const row = document.createElement('div');
  row.className = `item ${item.status}`;

  const cbox = document.createElement('span');
  cbox.className = 'cbox';
  cbox.innerHTML = '<svg viewBox="0 0 18 18"><path d="M4.6 9.4l3 3 5.8-6.8"/></svg>';

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = item.text;

  row.append(cbox, text);
  rw.append(del, row);

  cbox.addEventListener('click', (e) => { e.stopPropagation(); onCheck(row, rw); });
  attachRowGestures(rw, row, item);
  return rw;
}

function onCheck(row, rw) {
  const category = rw.dataset.cat;
  const index = +rw.dataset.index;
  if (tab === 'todo') {
    if (row.classList.contains('checking')) {
      row.classList.remove('checking');
      clearTimeout(row._checkTimer);
      row._checkTimer = null;
      return;
    }
    row.classList.add('checking');
    row._checkTimer = setTimeout(() => {
      row._checkTimer = null;
      opSetStatus(category, index, 'completed');
    }, CHECK_DELAY);
  } else {
    row.classList.add('unchecking');
    setTimeout(() => opSetStatus(category, index, 'todo'), UNCHECK_DELAY);
  }
}

/* ================= sections / reconcile ================= */

function createSection(name) {
  const sec = document.createElement('div');
  sec.className = 'cat';
  sec.dataset.cat = name;
  sec.dataset.k = `cat${name}`;
  sec.innerHTML =
    '<div class="cat-head"><svg class="chev" viewBox="0 0 10 10"><path d="M3 1.5l4 3.5-4 3.5"/></svg>' +
    '<span class="cat-name"></span></div>' +
    '<div class="cat-body"><div class="cat-inner"></div></div>';
  sec.querySelector('.cat-name').textContent = name;
  sec.querySelector('.cat-head').addEventListener('click', () => {
    sec.classList.toggle('closed');
    if (collapsed.has(name)) collapsed.delete(name);
    else collapsed.add(name);
    localStorage.setItem('collapsed', JSON.stringify([...collapsed]));
  });
  if (collapsed.has(name)) sec.classList.add('closed');
  return sec;
}

function reconcileRows(sec, name, entries) {
  const inner = sec.querySelector('.cat-inner');
  const wanted = new Map(entries.map((e) => [e.key, e]));
  const existing = new Map();
  for (const rw of [...inner.children]) {
    if (rw.dataset.k) existing.set(rw.dataset.k, rw);
  }
  for (const [k, rw] of existing) {
    if (!wanted.has(k)) exitRow(rw);
  }
  for (const { key, item, index } of entries) {
    let rw = existing.get(key);
    if (rw) {
      if (rw.classList.contains('leaving')) {
        clearTimeout(rw._exitTimer);
        rw.classList.remove('leaving');
        rw.style.maxHeight = '';
      }
      rw.dataset.index = String(index);
      inner.appendChild(rw);
    } else {
      rw = createRow(name, index, item, key);
      enterRow(inner, rw);
    }
  }
}

function reconcile() {
  const before = recordTops();

  const order = [];
  for (const cat of data.categories) {
    const filtered = cat.items
      .map((item, index) => ({ item, index }))
      .filter((e) => e.item.status === tab);
    if (!filtered.length) continue;
    const occ = {};
    const entries = filtered.map(({ item, index }) => {
      const base = `${cat.name}${item.text}`;
      const o = occ[base] || 0;
      occ[base] = o + 1;
      return { key: `${base}${o}`, item, index };
    });
    order.push({ name: cat.name, entries });
  }

  const wantedNames = new Set(order.map((c) => c.name));
  for (const sec of [...listEl.querySelectorAll(':scope > .cat')]) {
    if (!wantedNames.has(sec.dataset.cat)) sec.remove();
  }
  for (const { name, entries } of order) {
    let sec = listEl.querySelector(`:scope > .cat[data-cat="${CSS.escape(name)}"]`);
    if (!sec) sec = createSection(name);
    listEl.appendChild(sec);
    reconcileRows(sec, name, entries);
  }

  let empty = listEl.querySelector(':scope > .empty');
  if (!order.length) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '<svg viewBox="0 0 26 26"><circle class="o" cx="13" cy="13" r="10.5"/>' +
        '<path class="c" d="M8 13.5l3.2 3.2L18 9.5"/></svg><div>暂无事项</div>';
      listEl.appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }

  playFlip(before);
}

/* ================= add bar ================= */

function defaultCategory() {
  if (lastCat && data.categories.some((c) => c.name === lastCat)) return lastCat;
  return data.categories.length ? data.categories[0].name : T.DEFAULT_CATEGORY;
}

function parseAdd() {
  const v = addEl.value;
  const m = CAT_PREFIX.exec(v);
  if (m) return { category: m[1].trim(), text: m[2].trim() };
  return { category: defaultCategory(), text: v.trim() };
}

function updateHint() {
  addCat.textContent = parseAdd().category;
  addGo.classList.toggle('ready', addEl.value.trim() !== '');
}

function submitAdd() {
  const { category, text } = parseAdd();
  if (!text) return;
  lastCat = category;
  localStorage.setItem('lastCat', category);
  opAdd(category, text, 'todo');
  addEl.value = '';
  updateHint();
}

addEl.addEventListener('input', updateHint);
addEl.addEventListener('focus', () => addField.classList.add('focused'));
addEl.addEventListener('blur', () => addField.classList.remove('focused'));
addEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdd(); });
addGo.addEventListener('click', submitAdd);
addCat.addEventListener('click', () => {
  openCategoryPicker(parseAdd().category, (name) => {
    lastCat = name;
    localStorage.setItem('lastCat', name);
    updateHint();
    addEl.focus();
  });
});

/* ================= sheets ================= */

function presentSheet(node, { onBackdrop } = {}) {
  dismissSheet();
  backdrop.hidden = false;
  requestAnimationFrame(() => backdrop.classList.add('show'));
  sheetHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  node._onBackdrop = onBackdrop;
}

function dismissSheet() {
  backdrop.classList.remove('show');
  setTimeout(() => { if (!sheetHost.children.length) backdrop.hidden = true; }, 240);
  for (const sh of [...sheetHost.children]) {
    sh.classList.remove('show');
    setTimeout(() => sh.remove(), 320);
  }
}

backdrop.addEventListener('click', () => {
  const sh = sheetHost.lastElementChild;
  if (sh && sh._onBackdrop === false) return;
  dismissSheet();
});

function makeSheet(kind) {
  const sh = document.createElement('div');
  sh.className = `sheet ${kind}`;
  return sh;
}

// iOS-style action sheet: title (optional), grouped actions, bold 取消.
function openActionSheet({ title, actions }) {
  const sh = makeSheet('asheet');
  if (title) {
    const t = document.createElement('div');
    t.className = 'asheet-title';
    t.textContent = title;
    const g = document.createElement('div');
    g.className = 'asheet-group';
    g.style.borderRadius = '0 0 14px 14px';
    sh.append(t, g);
    buildBtns(g);
  } else {
    const g = document.createElement('div');
    g.className = 'asheet-group';
    sh.append(g);
    buildBtns(g);
  }
  function buildBtns(g) {
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'asheet-btn' + (a.destructive ? ' destructive' : '') + (a.bold ? ' bold' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => { dismissSheet(); if (a.handler) a.handler(); });
      g.appendChild(b);
    }
  }
  const cancel = document.createElement('button');
  cancel.className = 'asheet-cancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', dismissSheet);
  sh.appendChild(cancel);
  presentSheet(sh);
}

function openCategoryPicker(current, onPick) {
  const cats = data.categories.map((c) => c.name);
  const actions = cats.map((name) => ({
    label: name === current ? `✓ ${name}` : name,
    handler: () => onPick(name),
  }));
  actions.push({
    label: '新分类…',
    handler: () => openTextSheet('新分类', '', (name) => {
      const n = name.trim();
      if (n) onPick(n);
    }),
  });
  openActionSheet({ title: '选择分类', actions });
}

// Generic card sheet with a header (cancel/title/done) and body.
function openCardSheet({ title, doneLabel = '完成', build, onDone, doneId }) {
  const sh = makeSheet('csheet');
  const head = document.createElement('div');
  head.className = 'csheet-head';
  const cancelB = document.createElement('button');
  cancelB.className = 'sidebtn';
  cancelB.textContent = '取消';
  cancelB.addEventListener('click', dismissSheet);
  const t = document.createElement('div');
  t.className = 'csheet-title spacer';
  t.textContent = title;
  const doneB = document.createElement('button');
  doneB.className = 'sidebtn right';
  doneB.textContent = doneLabel;
  if (doneId) doneB.id = doneId;
  const body = document.createElement('div');
  body.className = 'csheet-body';
  doneB.addEventListener('click', () => { if (!onDone || onDone() !== false) dismissSheet(); });
  head.append(cancelB, t, doneB);
  sh.append(head, body);
  build(body);
  presentSheet(sh);
  return sh;
}

function openTextSheet(title, initial, onSave) {
  let input;
  openCardSheet({
    title,
    doneLabel: '保存',
    build(body) {
      const box = document.createElement('div');
      box.className = 'editbox';
      input = document.createElement('input');
      input.type = 'text';
      input.value = initial;
      box.appendChild(input);
      body.appendChild(box);
      setTimeout(() => { input.focus(); }, 300);
    },
    onDone() { onSave(input.value); },
  });
}

/* ---- long-press row action sheet ---- */

function openRowActions(rw, item) {
  const category = rw.dataset.cat;
  const index = +rw.dataset.index;
  const actions = [];

  actions.push({
    label: '编辑',
    handler: () => openTextSheet('编辑', item.text, (v) => opEdit(category, index, v)),
  });
  actions.push({
    label: '移到分类 ▸',
    handler: () => openCategoryPicker(category, (name) => opMove(category, index, name)),
  });
  for (const [status, label] of [['todo', '移到待办'], ['completed', '移到已完成'], ['cancelled', '移到已取消']]) {
    if (item.status !== status) {
      actions.push({ label, handler: () => opSetStatus(category, index, status) });
    }
  }
  actions.push({ label: '删除', destructive: true, handler: () => opRemove(category, index) });

  openActionSheet({ title: item.text, actions });
}

/* ================= settings ================= */

function getSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('todo-settings') || '{}'); } catch (e) { /* ignore */ }
  return {
    apiKey: s.apiKey || '',
    model: s.model || T.DEFAULT_MODEL,
    endpoint: s.endpoint || T.DEFAULT_ENDPOINT,
  };
}

function setSettings(patch) {
  const s = getSettings();
  Object.assign(s, patch);
  localStorage.setItem('todo-settings', JSON.stringify(s));
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'todo-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importBackup(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.categories)) throw new Error('bad shape');
      d.categories.forEach((c) => {
        c.name = String(c.name || T.DEFAULT_CATEGORY);
        c.items = (c.items || []).map((i) => ({
          id: '',
          text: String(i.text || ''),
          status: ['todo', 'completed', 'cancelled'].includes(i.status) ? i.status : 'todo',
        })).filter((i) => i.text);
      });
      d.categories = d.categories.filter((c) => c.items.length);
      data = d;
      afterMutation();
      toast('已导入备份');
    } catch (e) {
      toast('导入失败：文件格式不对');
    }
  };
  r.readAsText(file);
}

importFile.addEventListener('change', () => {
  if (importFile.files[0]) importBackup(importFile.files[0]);
  importFile.value = '';
});

function openSettings(notice) {
  const s = getSettings();
  openCardSheet({
    title: '设置',
    doneLabel: '完成',
    build(body) {
      if (notice) {
        const n = document.createElement('div');
        n.className = 'form-note warn';
        n.textContent = notice;
        body.appendChild(n);
      }
      const card = document.createElement('div');
      card.className = 'form-card';
      const fields = [
        ['API Key', 'apiKey', 'password', 'sk-…'],
        ['模型', 'model', 'text', T.DEFAULT_MODEL],
        ['接口地址', 'endpoint', 'text', T.DEFAULT_ENDPOINT],
      ];
      for (const [label, key, type, ph] of fields) {
        const row = document.createElement('div');
        row.className = 'form-row';
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = label;
        const inp = document.createElement('input');
        inp.type = type;
        inp.placeholder = ph;
        inp.value = s[key];
        inp.id = `set-${key}`;
        inp.autocapitalize = 'off';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.addEventListener('input', () => setSettings({ [key]: inp.value.trim() }));
        row.append(k, inp);
        card.appendChild(row);
      }
      body.appendChild(card);

      const note = document.createElement('div');
      note.className = 'form-note';
      note.textContent = '在火山方舟控制台开通模型并创建 API Key。Key 仅保存在本设备，不会上传到任何其他服务器。';
      body.appendChild(note);

      const links = document.createElement('div');
      links.className = 'form-card';
      const mk = (label, red, fn) => {
        const row = document.createElement('button');
        row.className = 'form-row link' + (red ? ' red' : '');
        row.style.width = '100%';
        row.textContent = label;
        row.addEventListener('click', fn);
        links.appendChild(row);
      };
      mk('导出备份', false, exportBackup);
      mk('导入备份', false, () => importFile.click());
      mk('复制为 Markdown', false, async () => {
        try {
          await navigator.clipboard.writeText(T.todosToMarkdown(data));
          toast('已复制 Markdown');
        } catch (e) {
          toast('复制失败');
        }
      });
      mk('清空已取消', true, () => { opClearCancelled(); toast('已清空'); });
      body.appendChild(links);
    },
  });
}

gearBtn.addEventListener('click', () => openSettings());

/* ================= voice & AI split ================= */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let recording = false;
let finalText = '';
let hadError = false;

function setMicUI(on) {
  recording = on;
  micBtn.classList.toggle('recording', on);
  micCapsule.hidden = !on;
  if (!on) micInterim.textContent = '';
}

function startRecognition() {
  finalText = '';
  hadError = false;
  try {
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.interimResults = true;
    recog.continuous = true;
    recog.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      micInterim.textContent = interim || finalText;
    };
    recog.onerror = (e) => {
      hadError = true;
      console.warn('speech error', e.error);
      // not-allowed / service-not-allowed / network → fall back to keyboard dictation
      setMicUI(false);
      if (!finalText.trim()) openDictation();
    };
    recog.onend = () => {
      // Use whatever transcript we got, even if a late error fired.
      const text = (finalText + micInterim.textContent).trim();
      setMicUI(false);
      if (text) runSplit(text);
    };
    recog.start();
    setMicUI(true);
  } catch (e) {
    setMicUI(false);
    openDictation();
  }
}

micBtn.addEventListener('click', () => {
  if (recording) { try { recog.stop(); } catch (e) { /* ignore */ } return; }
  if (!SR || STT_OFF) { openDictation(); return; }
  startRecognition();
});

// Fallback modal: iOS keyboard dictation works everywhere, so a plain
// textarea + the system 🎤 key covers devices without SpeechRecognition.
function openDictation() {
  let ta;
  openCardSheet({
    title: '语音输入',
    doneLabel: '完成',
    doneId: 'dictDone',
    build(body) {
      const hint = document.createElement('div');
      hint.id = 'dictHint';
      hint.textContent = '语音识别不可用：可以点键盘上的🎤按钮用系统听写';
      ta = document.createElement('textarea');
      ta.id = 'dictText';
      ta.rows = 2;
      ta.placeholder = '说或写下要做的事，例如：明天买菜、周五前交周报';
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.45)}px`;
      });
      body.append(hint, ta);
      setTimeout(() => ta.focus(), 300);
    },
    onDone() {
      const v = ta.value.trim();
      if (v) runSplit(v);
    },
  });
}

async function callLLM(transcript) {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 600));
    return [
      { text: '买周末电影票', category: '生活' },
      { text: '交周报', category: '工作' },
    ];
  }
  const cfg = getSettings();
  if (!cfg.apiKey) {
    openSettings('请先填入火山方舟 API Key');
    throw { silent: true };
  }
  const messages = T.buildSplitPrompt(transcript, data.categories.map((c) => c.name));
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.1,
      max_tokens: 800,
    }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message
    ? j.choices[0].message.content : '';
  return T.parseSplitResponse(content);
}

function runSplit(transcript) {
  transcript = String(transcript || '').trim();
  if (!transcript) return;
  splitRow.hidden = false;
  callLLM(transcript).then((items) => {
    splitRow.hidden = true;
    if (!items || !items.length) throw new Error('empty result');
    openPreview(items);
  }).catch((e) => {
    splitRow.hidden = true;
    if (e && e.silent) return;
    toast('拆分失败，请检查网络或 API Key');
    openActionSheet({
      title: '拆分失败，请检查网络或 API Key',
      actions: [
        { label: '仍要添加原文', handler: () => opAdd(defaultCategory(), transcript, 'todo') },
      ],
    });
  });
}

/* ---- AI preview sheet ---- */

function openPreview(items) {
  const proposed = items.map((i) => ({ text: i.text, category: i.category }));
  const sh = makeSheet('csheet');
  sh.innerHTML =
    '<div class="csheet-head"><div class="spacer sidebtn"></div>' +
    '<div class="csheet-title spacer">AI 拆分结果</div>' +
    '<div class="spacer sidebtn right"></div></div>';
  const body = document.createElement('div');
  body.className = 'csheet-body';
  const card = document.createElement('div');
  card.className = 'form-card';
  card.id = 'pvCard';
  body.appendChild(card);
  const foot = document.createElement('div');
  foot.className = 'pv-foot';
  foot.innerHTML =
    '<button id="pvCancel">取消</button>' +
    '<button id="pvConfirm"></button>';
  sh.append(body, foot);
  presentSheet(sh);

  const confirmB = foot.querySelector('#pvConfirm');
  foot.querySelector('#pvCancel').addEventListener('click', dismissSheet);

  function render() {
    confirmB.textContent = `确认添加 (${proposed.length})`;
    confirmB.disabled = !proposed.length;
    card.innerHTML = '';
    proposed.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'pv-row';
      const x = document.createElement('button');
      x.className = 'pv-x';
      x.textContent = '✕';
      x.addEventListener('click', () => { proposed.splice(i, 1); render(); });
      const inp = document.createElement('input');
      inp.className = 'pv-text';
      inp.value = p.text;
      inp.addEventListener('input', () => { p.text = inp.value; });
      const cat = document.createElement('button');
      cat.className = 'pv-cat';
      cat.textContent = p.category;
      cat.addEventListener('click', () => {
        openCategoryPicker(p.category, (name) => { p.category = name; render(); });
      });
      row.append(x, inp, cat);
      card.appendChild(row);
    });
  }
  render();

  confirmB.addEventListener('click', () => {
    for (const p of proposed) {
      const t = p.text.trim();
      if (!t) continue;
      let cat = findCat(p.category);
      if (!cat) { cat = { name: p.category, items: [] }; data.categories.push(cat); }
      cat.items.push({ id: '', text: t, status: 'todo' });
    }
    afterMutation();
    dismissSheet();
  });
}

/* ================= service worker ================= */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw register failed', e));
}

/* ================= init ================= */

(async () => {
  try {
    const stored = await db.get('data');
    if (stored && Array.isArray(stored.categories)) {
      data = stored;
    } else {
      data = T.markdownToTodos(SEED_MD);
      persist();
    }
  } catch (e) {
    // IndexedDB unavailable (private mode etc.) — run from seed in memory.
    data = T.markdownToTodos(SEED_MD);
  }
  updateDate();
  positionThumb(false);
  reconcile();
  updateHint();
})();
