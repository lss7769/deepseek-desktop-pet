// 小鲸文件助手：搜索（名字索引）+ 预览（只读）+ 打开
const qInput = document.getElementById('q');
const extSel = document.getElementById('ext');
const rootSel = document.getElementById('root');
const list = document.getElementById('list');
const statusEl = document.getElementById('status');
const pvName = document.getElementById('pv-name');
const pvSize = document.getElementById('pv-size');
const pvBody = document.getElementById('pv-body');
const openBtn = document.getElementById('open-btn');
const copyBtn = document.getElementById('copy-path-btn');
const copyToBtn = document.getElementById('copy-to-btn');
const moveToBtn = document.getElementById('move-to-btn');
const trashBtn = document.getElementById('trash-btn');
const rootsBtn = document.getElementById('roots-btn');
const rootsPanel = document.getElementById('roots-panel');
const rootsList = document.getElementById('roots-list');
const rootsAdd = document.getElementById('roots-add');
const rootsClose = document.getElementById('roots-close');

const destPanel = document.getElementById('dest-panel');
const destTitle = document.getElementById('dest-title');
const destSrc = document.getElementById('dest-src');
const destInput = document.getElementById('dest-input');
const destPick = document.getElementById('dest-pick');
const destCancel = document.getElementById('dest-cancel');
const destOk = document.getElementById('dest-ok');

const trashPanel = document.getElementById('trash-panel');
const trashSrc = document.getElementById('trash-src');
const trashName = document.getElementById('trash-name');
const trashInput = document.getElementById('trash-input');
const trashCancel = document.getElementById('trash-cancel');
const trashOk = document.getElementById('trash-ok');

const PREVIEW_LINES = 400;
let roots = [];
let selected = null;
let hits = [];
let searchTimer = null;
let destOp = null; // 'copy' | 'move'

// 扩展名 -> 圆点颜色
const EXT_DOT = {
  md: 'green', markdown: 'green', txt: 'green', log: 'green',
  py: 'blue', js: 'blue', mjs: 'blue', cjs: 'blue', ts: 'blue', tsx: 'blue',
  jsx: 'blue', c: 'blue', h: 'blue', cpp: 'blue', hpp: 'blue', cc: 'blue',
  java: 'blue', go: 'blue', rs: 'blue', rb: 'blue', php: 'blue', sh: 'blue',
  bat: 'blue', ps1: 'blue', json: 'teal', jsonl: 'teal', csv: 'teal', tsv: 'teal',
  yml: 'teal', yaml: 'teal', toml: 'teal', xml: 'teal', sql: 'teal', ini: 'teal',
  png: 'purple', jpg: 'purple', jpeg: 'purple', gif: 'purple', webp: 'purple', svg: 'purple',
  pdf: 'orange', doc: 'orange', docx: 'orange', xls: 'orange', xlsx: 'orange', ppt: 'orange', pptx: 'orange'
};

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return m ? m[1].toLowerCase() : '';
}

function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 去掉 root 前缀，展示相对路径
function relPath(p) {
  for (const r of roots) {
    const base = r.path.replace(/\\$/, '');
    const low = p.toLowerCase();
    if (low.startsWith(base.toLowerCase() + '\\') || low === base.toLowerCase()) {
      return p.slice(base.length + 1) || p;
    }
  }
  return p;
}

function dotFor(p) {
  return 'dot-' + (EXT_DOT[extOf(p)] || 'gray');
}

function renderRootSelect() {
  rootSel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部目录';
  rootSel.appendChild(all);
  for (const r of roots) {
    const o = document.createElement('option');
    o.value = r.path;
    o.textContent = r.path;
    rootSel.appendChild(o);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function clearList(text) {
  list.innerHTML = '';
  if (text) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = text;
    list.appendChild(d);
  }
}

function renderHits() {
  list.innerHTML = '';
  if (!hits.length) {
    clearList(qInput.value.trim() ? '没有找到匹配的文件' : '输入关键词开始找文件吧');
    return;
  }
  for (const h of hits) {
    const row = document.createElement('div');
    row.className = 'hit';
    if (selected && selected.p === h.p) row.classList.add('active');

    const dot = document.createElement('span');
    dot.className = 'dot ' + dotFor(h.p);

    const main = document.createElement('div');
    main.className = 'hit-main';
    const name = document.createElement('div');
    name.className = 'hit-name';
    name.textContent = h.p.split('\\').pop();
    const sub = document.createElement('div');
    sub.className = 'hit-sub';
    sub.textContent = relPath(h.p);
    main.appendChild(name);
    main.appendChild(sub);

    const meta = document.createElement('span');
    meta.className = 'hit-meta';
    meta.textContent = fmtSize(h.s);

    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(meta);
    row.addEventListener('click', () => selectHit(h));
    list.appendChild(row);
  }
}

async function doSearch() {
  const query = qInput.value.trim();
  if (!query) { hits = []; renderHits(); setStatus(indexStatusText()); return; }
  const res = await window.petAPI.searchFiles({
    query,
    ext: extSel.value || undefined,
    dir: rootSel.value || undefined,
    limit: 50
  });
  if (!res || !res.ok) {
    hits = [];
    clearList(res && res.error ? res.error : '搜索失败');
    return;
  }
  hits = res.hits || [];
  renderHits();
  setStatus(`找到 ${hits.length} 个（索引里共 ${res.total.toLocaleString()} 条）`);
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 180);
}

async function selectHit(h) {
  selected = h;
  for (const el of list.querySelectorAll('.hit')) el.classList.remove('active');
  const rows = list.querySelectorAll('.hit');
  const idx = hits.findIndex(x => x.p === h.p);
  if (rows[idx]) rows[idx].classList.add('active');

  openBtn.disabled = false;
  copyBtn.disabled = false;
  copyToBtn.disabled = false;
  moveToBtn.disabled = false;
  trashBtn.disabled = false;
  pvName.textContent = h.p.split('\\').pop();
  pvName.title = h.p;
  pvSize.textContent = fmtSize(h.s) + ' · ' + fmtTime(h.m);
  pvBody.textContent = '读取中…';

  const res = await window.petAPI.readFile({ path: h.p, maxChars: 20000 });
  if (!res || !res.ok) { pvBody.textContent = res && res.error ? res.error : '读不了这个文件'; return; }

  const lines = res.text.split('\n');
  const shown = lines.slice(0, PREVIEW_LINES);
  pvBody.textContent = shown.join('\n') +
    (lines.length > PREVIEW_LINES || res.truncated ? `\n\n…（内容较长，只预览了前 ${Math.min(lines.length, PREVIEW_LINES)} 行）` : '');
}

async function copyPath() {
  if (!selected) return;
  try {
    await navigator.clipboard.writeText(selected.p);
    setStatus('路径已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = selected.p;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    setStatus('路径已复制到剪贴板');
  }
}

function indexStatusText() {
  if (!index.status) return '索引还没建好…';
  const t = new Date(index.ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `索引 ${index.count.toLocaleString()} 个文件（更新于 ${p(t.getHours())}:${p(t.getMinutes())}）`;
}

const index = { status: null, count: 0, ts: 0 };

async function refreshIndexStatus() {
  const st = await window.petAPI.getIndexStatus();
  index.status = st;
  index.count = st.count || 0;
  index.ts = st.ts || 0;
  if (st.scanning) setStatus(`正在扫描文件索引…（已找到 ${index.count.toLocaleString()} 个）`);
  else setStatus(indexStatusText());
}

// ---------- 授权目录面板 ----------
function renderRoots() {
  rootsList.innerHTML = '';
  if (!roots.length) {
    const d = document.createElement('div');
    d.className = 'root-empty';
    d.textContent = '还没有授权目录';
    rootsList.appendChild(d);
  }
  roots.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'root-row';

    const p = document.createElement('span');
    p.className = 'p';
    p.textContent = r.path;
    p.title = r.path;

    const mode = document.createElement('button');
    mode.className = 'mode ' + (r.mode === 'rw' ? 'rw' : '');
    mode.textContent = r.mode === 'rw' ? 'rw' : 'ro';
    mode.title = '点击切换只读 / 可写';
    mode.addEventListener('click', async () => {
      roots[i] = { path: r.path, mode: r.mode === 'rw' ? 'ro' : 'rw' };
      await saveRoots();
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '移除这个目录';
    del.addEventListener('click', async () => {
      roots.splice(i, 1);
      await saveRoots();
    });

    row.appendChild(p);
    row.appendChild(mode);
    row.appendChild(del);
    rootsList.appendChild(row);
  });
}

async function saveRoots() {
  await window.petAPI.setConfig({ fileRoots: roots.map(r => ({ path: r.path, mode: r.mode })) });
  renderRoots();
  renderRootSelect();
}

async function addRoots() {
  const picked = await window.petAPI.pickRoot();
  if (!picked || !picked.length) return;
  for (const p of picked) {
    if (!roots.some(r => r.path.toLowerCase() === p.toLowerCase())) roots.push({ path: p, mode: 'rw' });
  }
  await saveRoots();
}

rootsBtn.addEventListener('click', () => { renderRoots(); rootsPanel.classList.remove('hidden'); });
rootsClose.addEventListener('click', () => rootsPanel.classList.add('hidden'));
rootsPanel.addEventListener('click', (e) => { if (e.target === rootsPanel) rootsPanel.classList.add('hidden'); });
rootsAdd.addEventListener('click', addRoots);

// ---------- 复制到… / 移动至…（写操作，主进程还会弹确认框） ----------
function openDestPanel(op) {
  if (!selected) return;
  destOp = op;
  destTitle.textContent = op === 'move' ? '移动到…' : '复制到…';
  destSrc.textContent = '源：' + selected.p;
  destInput.value = selected.p; // 预填源路径，改文件名或换目录都行
  destPanel.classList.remove('hidden');
  destInput.focus();
  destInput.select();
}

destPanel.addEventListener('click', (e) => { if (e.target === destPanel) destPanel.classList.add('hidden'); });
destCancel.addEventListener('click', () => destPanel.classList.add('hidden'));

destPick.addEventListener('click', async () => {
  const picked = await window.petAPI.pickRoot();
  if (!picked || !picked.length) return;
  const dir = picked[0].replace(/[\\/]+$/, '');
  const name = destInput.value.trim().split(/[\\/]/).pop() || (selected ? selected.p.split('\\').pop() : '');
  destInput.value = dir + '\\' + name;
});

destOk.addEventListener('click', async () => {
  const dst = destInput.value.trim();
  if (!dst) { setStatus('目标路径不能为空'); return; }
  if (!selected) { destPanel.classList.add('hidden'); return; }
  const op = destOp || 'copy';
  destPanel.classList.add('hidden');
  setStatus('等你确认…');
  const res = op === 'move'
    ? await window.petAPI.movePath(selected.p, dst)
    : await window.petAPI.copyPath(selected.p, dst);
  if (!res || !res.ok) {
    setStatus((res && res.error) || '操作失败');
    return;
  }
  setStatus(`${op === 'move' ? '移动' : '复制'}好了 → ${res.dst}`);
  if (op === 'move') doSearch(); // 源位置变了，刷新一下结果
});

copyToBtn.addEventListener('click', () => openDestPanel('copy'));
moveToBtn.addEventListener('click', () => openDestPanel('move'));

// ---------- 移到回收站（文件直接走；目录会先要求输入目录名） ----------
function clearSelection() {
  selected = null;
  openBtn.disabled = copyBtn.disabled = copyToBtn.disabled = moveToBtn.disabled = trashBtn.disabled = true;
  pvName.textContent = '选中文件后可预览';
  pvName.title = '';
  pvSize.textContent = '';
  pvBody.textContent = '';
}

function handleTrashResult(res) {
  if (!res || !res.ok) {
    setStatus((res && res.error) || '删除失败');
    return;
  }
  setStatus('已丢进回收站，随时能还原');
  hits = hits.filter(h => h.p !== res.path);
  clearSelection();
  renderHits();
}

trashBtn.addEventListener('click', async () => {
  if (!selected) return;
  setStatus('等你确认…');
  const res = await window.petAPI.trashPath(selected.p);
  if (res && res.needName) {
    // 目录：要求输入目录名再确认
    trashSrc.textContent = '目标：' + selected.p;
    trashName.textContent = res.name || '';
    trashInput.value = '';
    trashPanel.classList.remove('hidden');
    trashInput.focus();
    return;
  }
  handleTrashResult(res);
});

trashPanel.addEventListener('click', (e) => { if (e.target === trashPanel) trashPanel.classList.add('hidden'); });
trashCancel.addEventListener('click', () => trashPanel.classList.add('hidden'));
trashOk.addEventListener('click', async () => {
  const name = trashInput.value.trim();
  if (!selected) { trashPanel.classList.add('hidden'); return; }
  if (!name) { setStatus('先输入目录名'); return; }
  trashPanel.classList.add('hidden');
  setStatus('等你确认…');
  const res = await window.petAPI.trashPath(selected.p, name);
  handleTrashResult(res);
});

qInput.addEventListener('input', scheduleSearch);
extSel.addEventListener('change', doSearch);
rootSel.addEventListener('change', doSearch);
openBtn.addEventListener('click', () => { if (selected) window.petAPI.openPath(selected.p); });
copyBtn.addEventListener('click', copyPath);

window.petAPI.onIndexProgress((st) => {
  index.count = st.count || 0;
  if (st.root) setStatus(`正在扫描 ${st.root} …（已找到 ${index.count.toLocaleString()} 个）`);
  else setStatus(`正在扫描文件索引…（已找到 ${index.count.toLocaleString()} 个）`);
});

async function init() {
  const cfg = await window.petAPI.getConfig();
  roots = Array.isArray(cfg.fileRoots) ? cfg.fileRoots.map(r => ({ path: r.path, mode: r.mode })) : [];
  renderRootSelect();
  clearList('输入关键词开始找文件吧');
  await refreshIndexStatus();
  // 索引还在扫的话，稍后再刷新一次状态
  setTimeout(refreshIndexStatus, 1500);
}

init();
