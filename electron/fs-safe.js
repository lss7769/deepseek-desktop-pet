// 文件助手的安全内核：纯 Node 实现（不依赖 electron），方便用探针脚本直接断言。
// 职责：① 路径白名单校验（防越界 / 防 junction 外逃）② 文件名索引与搜索 ③ 只读操作。
const fs = require('fs');
const path = require('path');

// 扫描时忽略的目录名（小写比较），外加所有以「.」开头的目录
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'appdata',
  '.cache', 'out', 'target', '.idea', '.vscode', 'venv'
]);

// 可当作纯文本读取的扩展名白名单
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.html', '.htm',
  '.css', '.scss', '.less', '.py', '.c', '.h', '.cpp', '.hpp', '.cc', '.java',
  '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.ps1', '.yml', '.yaml', '.toml',
  '.ini', '.cfg', '.conf', '.xml', '.sql', '.env', '.gitignore', '.editorconfig'
]);

const MAX_READ_BYTES = 256 * 1024; // read_file 正文上限 256KB
const MAX_LIST = 500;              // list_dir 条数上限

// ---------- 路径工具的兜底 realpath ----------
// 对不存在的路径也能给出「最近的已存在祖先」的实体路径，用于封住 junction/软链
function realpathBest(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // 到顶了，放弃
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// 把 config 里的 roots（{path, mode} 或纯字符串）补上 real 字段
function normalizeRoots(roots) {
  const out = [];
  for (const r of Array.isArray(roots) ? roots : []) {
    const raw = typeof r === 'string' ? { path: r, mode: 'rw' } : r;
    if (!raw || !raw.path) continue;
    const abs = path.resolve(String(raw.path));
    let real;
    try { real = fs.realpathSync(abs); } catch { real = abs; } // root 不存在就先用原路径
    out.push({ path: abs, real, mode: raw.mode === 'ro' ? 'ro' : 'rw' });
  }
  return out;
}

function lowerOnWin(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

// target 是否在 root 之内（前缀 + 分隔符，避免 D:\code 命中 D:\codex）
function isInside(target, root) {
  const t = lowerOnWin(target);
  const r = lowerOnWin(root);
  if (t === r) return true;
  const sep = path.sep;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

// 校验一个用户/模型给的路径：必须是绝对路径、不含「..」、实体化后落在白名单内
function resolveInRoots(input, roots) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '路径是空的' };
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
    return { ok: false, error: '路径里不允许出现「..」，我不能用它' };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, error: '我只认绝对路径，例如 D:\\code\\笔记.md' };
  }
  const real = realpathBest(raw);
  for (const r of roots) {
    if (isInside(real, r.real)) return { ok: true, path: real, root: r };
  }
  return { ok: false, error: '这个路径不在授权目录里，我不能碰它' };
}

// ---------- 文件名索引 ----------
const SCAN_MAX_DEPTH = 8;
const SCAN_MAX_PER_ROOT = 200000;
const SCAN_MAX_MS = 15000;

async function scanDir(dir, depth, state, entries) {
  if (depth > SCAN_MAX_DEPTH) return;
  if (state.count >= SCAN_MAX_PER_ROOT) { state.capped = true; return; }
  if (Date.now() - state.start > SCAN_MAX_MS) { state.timeout = true; return; }

  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch { return; }

  for (const it of items) {
    if (state.count >= SCAN_MAX_PER_ROOT || Date.now() - state.start > SCAN_MAX_MS) return;
    const name = it.name;
    if (name.startsWith('.')) continue;

    state.ops++;
    if (state.ops % 200 === 0) {
      await new Promise(r => setImmediate(r));
      if (state.onProgress) state.onProgress(state.count);
    }

    const full = path.join(dir, name);
    if (it.isDirectory()) {
      if (IGNORE_DIRS.has(name.toLowerCase())) continue;
      await scanDir(full, depth + 1, state, entries);
    } else if (it.isFile()) {
      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }
      entries.push({ p: full, n: name.toLowerCase(), s: st.size, m: st.mtimeMs });
      state.count++;
    }
  }
}

// 扫描所有 root，返回 { entries, ts, truncated }
async function buildIndex(roots, opts = {}) {
  const state = {
    count: 0, ops: 0, start: Date.now(),
    onProgress: opts.onProgress, capped: false, timeout: false
  };
  const entries = [];
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    await scanDir(root.path, 0, state, entries);
    if (opts.onProgress) opts.onProgress(entries.length, root.path);
  }
  return { entries, ts: Date.now(), truncated: state.capped || state.timeout };
}

// 在索引里按名字/路径搜索，排序：名字命中 > 路径命中 > 最近修改
function searchIndex(entries, query, opts = {}) {
  const q = String(query || '').toLowerCase().trim();
  const ext = opts.ext ? String(opts.ext).toLowerCase() : null;
  const dir = opts.dir ? path.resolve(String(opts.dir)) : null;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  if (!q) return [];

  const hits = [];
  for (const e of entries) {
    if (dir && !isInside(e.p, dir)) continue;
    const lp = e.p.toLowerCase();
    if (ext && !lp.endsWith(ext)) continue;
    const nameHit = e.n.includes(q);
    const pathHit = !nameHit && lp.includes(q);
    if (!nameHit && !pathHit) continue;
    hits.push({ p: e.p, s: e.s, m: e.m, rank: nameHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || b.m - a.m);
  return hits.slice(0, limit);
}

// 实时内容搜索：文本扩展名白名单 + 单文件 256KB + 总 5 秒超时
async function searchInFiles(roots, keyword, opts = {}) {
  const kw = String(keyword || '');
  if (!kw) return [];
  const kwLower = kw.toLowerCase();
  const ext = opts.ext ? String(opts.ext).toLowerCase() : null;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 30, 100));
  const deadline = Date.now() + 5000;

  const targets = [];
  if (opts.dir) {
    const r = resolveInRoots(opts.dir, roots);
    if (!r.ok) return { error: r.error };
    targets.push({ path: r.path, depth: 0 });
  } else {
    for (const root of roots) if (fs.existsSync(root.path)) targets.push({ path: root.path, depth: 0 });
  }

  const results = [];
  const queue = targets.slice();
  while (queue.length && results.length < limit && Date.now() < deadline) {
    const { path: dir, depth } = queue.shift();
    if (depth > SCAN_MAX_DEPTH) continue;
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (results.length >= limit || Date.now() > deadline) break;
      const name = it.name;
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (it.isDirectory()) {
        if (!IGNORE_DIRS.has(name.toLowerCase())) queue.push({ path: full, depth: depth + 1 });
        continue;
      }
      if (!it.isFile()) continue;
      const e = path.extname(name).toLowerCase();
      if (ext && e !== ext) continue;
      if (!TEXT_EXTS.has(e)) continue;

      let st;
      try { st = await fs.promises.stat(full); } catch { continue; }
      if (st.size > MAX_READ_BYTES) continue;
      let text;
      try { text = await fs.promises.readFile(full, 'utf8'); } catch { continue; }
      const idx = text.toLowerCase().indexOf(kwLower);
      if (idx < 0) continue;
      const lineNo = text.slice(0, idx).split('\n').length;
      const line = text.split('\n')[lineNo - 1] || '';
      results.push({ p: full, s: st.size, m: st.mtimeMs, line: lineNo, snippet: line.trim().slice(0, 160) });
    }
  }
  return results;
}

// 列目录（只读），不递归
async function listDir(dirTarget, roots, opts = {}) {
  const r = typeof dirTarget === 'object' && dirTarget.real
    ? { ok: true, path: dirTarget.path, root: dirTarget }
    : resolveInRoots(dirTarget, roots);
  if (!r.ok) return { ok: false, error: r.error };
  const limit = Math.max(1, Math.min(Number(opts.limit) || MAX_LIST, 2000));

  let items;
  try {
    items = await fs.promises.readdir(r.path, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: '读不了这个目录：' + String(e && e.message || e) };
  }

  const out = [];
  for (const it of items) {
    if (out.length >= limit) break;
    const full = path.join(r.path, it.name);
    let st = null;
    try { st = await fs.promises.stat(full); } catch { /* 忽略坏条目 */ }
    out.push({
      p: full,
      name: it.name,
      dir: it.isDirectory(),
      s: st ? st.size : 0,
      m: st ? st.mtimeMs : 0
    });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { ok: true, path: r.path, root: r.root, items: out, truncated: items.length > out.length };
}

// 读文件正文（只读），先 stat 再读，超 256KB 截断
async function readFileText(filePath, roots, opts = {}) {
  const r = resolveInRoots(filePath, roots);
  if (!r.ok) return { ok: false, error: r.error };

  let st;
  try { st = await fs.promises.stat(r.path); } catch { return { ok: false, error: '这个文件不存在或读不到' }; }
  if (st.isDirectory()) return { ok: false, error: '这是一个目录，不是文件' };

  const maxChars = Math.max(100, Math.min(Number(opts.maxChars) || 20000, 200000));
  const maxBytes = Math.min(MAX_READ_BYTES, maxChars * 4);
  let text = '';
  let truncated = false;
  try {
    const fh = await fs.promises.open(r.path, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    text = buf.slice(0, bytesRead).toString('utf8');
    truncated = st.size > bytesRead;
  } catch (e) {
    return { ok: false, error: '读文件失败：' + String(e && e.message || e) };
  }
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  return { ok: true, path: r.path, size: st.size, mtime: st.mtimeMs, text, truncated };
}

// ---------- 写入操作：复制 / 移动（绝不自动覆盖） ----------

// 数一下这次操作会影响多少项（给确认框用），有上限避免卡死
async function countEntries(p, limit = 5000) {
  let st;
  try { st = await fs.promises.lstat(p); } catch { return { files: 0, dirs: 0 }; }
  if (!st.isDirectory()) return { files: 1, dirs: 0 };

  let files = 0, dirs = 0;
  const queue = [p];
  while (queue.length && files + dirs < limit) {
    const dir = queue.shift();
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (files + dirs >= limit) break;
      if (it.isDirectory()) { dirs++; queue.push(path.join(dir, it.name)); }
      else files++;
    }
  }
  return { files, dirs };
}

// 写入前的统一校验：src/dst 都要落在 rw 的 root 内；dst 已存在就直接拒绝（绝不覆盖）
async function checkWrite(src, dst, roots) {
  const rs = resolveInRoots(src, roots);
  if (!rs.ok) return { ok: false, error: '源路径：' + rs.error };
  if (rs.root.mode !== 'rw') return { ok: false, error: `源在只读目录 ${rs.root.path} 里，我不能改它` };

  let st;
  try { st = await fs.promises.lstat(rs.path); } catch { return { ok: false, error: '源不存在：' + rs.path }; }

  const rd = resolveInRoots(dst, roots);
  if (!rd.ok) return { ok: false, error: '目标路径：' + rd.error };
  if (rd.root.mode !== 'rw') return { ok: false, error: `目标在只读目录 ${rd.root.path} 里，我不能往那儿写` };
  if (lowerOnWin(rd.path) === lowerOnWin(rs.path)) return { ok: false, error: '源和目标是同一个位置，不用动' };
  if (fs.existsSync(rd.path)) return { ok: false, error: '目标已存在，我不会覆盖它：' + rd.path };
  if (st.isDirectory() && isInside(rd.path, rs.path)) {
    return { ok: false, error: '不能把一个目录挪进它自己的子目录里' };
  }
  const parent = path.dirname(rd.path);
  let pst;
  try { pst = await fs.promises.stat(parent); } catch { return { ok: false, error: '目标的上级目录不存在：' + parent }; }
  if (!pst.isDirectory()) return { ok: false, error: '目标的上级不是目录：' + parent };

  return { ok: true, src: rs.path, dst: rd.path, isDir: st.isDirectory() };
}

// 复制：目录递归复制；目标已存在直接失败
async function copyPath(src, dst, roots) {
  const c = await checkWrite(src, dst, roots);
  if (!c.ok) return c;
  try {
    await fs.promises.cp(c.src, c.dst, { recursive: true, force: false, errorOnExist: true });
  } catch (e) {
    return { ok: false, error: '复制失败：' + String(e && e.message || e) };
  }
  return { ok: true, op: 'copy', src: c.src, dst: c.dst, isDir: c.isDir };
}

// 移动：先 rename；跨盘（EXDEV）退回复制 + 删源
async function movePath(src, dst, roots) {
  const c = await checkWrite(src, dst, roots);
  if (!c.ok) return c;
  try {
    await fs.promises.rename(c.src, c.dst);
  } catch (e) {
    if (!e || e.code !== 'EXDEV') {
      return { ok: false, error: '移动失败：' + String(e && e.message || e) };
    }
    try {
      await fs.promises.cp(c.src, c.dst, { recursive: true, force: false, errorOnExist: true });
    } catch (e2) {
      return { ok: false, error: '移动失败（跨盘复制阶段）：' + String(e2 && e2.message || e2) };
    }
    try {
      await fs.promises.rm(c.src, { recursive: true, force: false });
    } catch (e2) {
      return { ok: false, error: '已复制到目标，但源删不掉，请手动处理：' + String(e2 && e2.message || e2) };
    }
  }
  return { ok: true, op: 'move', src: c.src, dst: c.dst, isDir: c.isDir };
}

// ---------- 删除前的校验（真正的删除由 electron 的 shell.trashItem 执行，这里只查拦不拦） ----------
async function checkTrash(target, roots) {
  const r = resolveInRoots(target, roots);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.root.mode !== 'rw') return { ok: false, error: `它在只读目录 ${r.root.path} 里，我不能删` };

  let st;
  try { st = await fs.promises.lstat(r.path); } catch { return { ok: false, error: '路径不存在：' + r.path }; }

  // 授权根目录本身永远不许删
  if (lowerOnWin(r.path) === lowerOnWin(r.root.real) || lowerOnWin(r.path) === lowerOnWin(r.root.path)) {
    return { ok: false, error: '这是授权目录的根目录本身，我绝不会删它' };
  }
  // 含 .git 的目录是代码仓库，不许删
  if (st.isDirectory()) {
    try {
      const names = await fs.promises.readdir(r.path);
      if (names.some(n => n.toLowerCase() === '.git')) {
        return { ok: false, error: '这个目录里有 .git，是个代码仓库，我不能删' };
      }
    } catch { /* 读不了就按不能删处理 */ return { ok: false, error: '读不了这个目录，我不敢删' }; }
  }
  return { ok: true, path: r.path, isDir: st.isDirectory() };
}

// ---------- 批量移动（整理用）：先整体校验出计划，再一次确认、顺序执行 ----------

// 找出 dst 上级中还不存在的目录链（需要新建的），并要求落在 rw root 内
function missingParents(p, roots) {
  const missing = [];
  let cur = path.dirname(p);
  while (!fs.existsSync(cur)) {
    missing.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (!missing.length) return { ok: true, missing };
  const r = resolveInRoots(cur, roots);
  if (!r.ok || r.root.mode !== 'rw') {
    return { ok: false, error: '要新建的目录不在可写授权目录里：' + missing[0] };
  }
  return { ok: true, missing };
}

// 把模型给的 [{src,dst}, ...] 逐条校验成可执行计划；过不了的进 errors，不拖垮整批
async function planMoves(ops, roots) {
  const items = [];
  const errors = [];
  const mkdirSet = new Set();
  const seenSrc = new Set();
  const seenDst = new Set();

  for (const raw of Array.isArray(ops) ? ops : []) {
    const src = String(raw && raw.src || '').trim();
    const dst = String(raw && raw.dst || '').trim();
    const fail = (error) => errors.push({ src, dst, error });
    if (!src || !dst) { fail('源或目标路径是空的'); continue; }

    const rs = resolveInRoots(src, roots);
    if (!rs.ok) { fail('源：' + rs.error); continue; }
    if (rs.root.mode !== 'rw') { fail(`源在只读目录 ${rs.root.path} 里`); continue; }
    let st;
    try { st = await fs.promises.lstat(rs.path); } catch { fail('源不存在：' + rs.path); continue; }

    const rd = resolveInRoots(dst, roots);
    if (!rd.ok) { fail('目标：' + rd.error); continue; }
    if (rd.root.mode !== 'rw') { fail(`目标在只读目录 ${rd.root.path} 里`); continue; }
    if (lowerOnWin(rd.path) === lowerOnWin(rs.path)) { fail('源和目标是同一个位置'); continue; }
    if (fs.existsSync(rd.path)) { fail('目标已存在，不覆盖：' + rd.path); continue; }
    if (st.isDirectory() && isInside(rd.path, rs.path)) { fail('不能把目录挪进它自己的子目录'); continue; }

    const srcKey = lowerOnWin(rs.path);
    const dstKey = lowerOnWin(rd.path);
    if (seenSrc.has(srcKey)) { fail('同一个源在计划里出现了两次'); continue; }
    if (seenDst.has(dstKey)) { fail('两条计划指向同一个目标'); continue; }

    const mp = missingParents(rd.path, roots);
    if (!mp.ok) { fail(mp.error); continue; }

    seenSrc.add(srcKey);
    seenDst.add(dstKey);
    for (const m of mp.missing) mkdirSet.add(m);
    items.push({ src: rs.path, dst: rd.path, isDir: st.isDirectory() });
  }
  return { items, errors, mkdirs: [...mkdirSet] };
}

// 执行计划：先建目录，再逐条 move（每条执行前仍重新校验，状态变了就跳过并记入 failed）
async function applyMoves(plan, roots) {
  const moved = [];
  const failed = [];
  for (const d of plan.mkdirs || []) {
    try { await fs.promises.mkdir(d, { recursive: true }); } catch { /* 失败由后续 move 校验兜底 */ }
  }
  for (const it of plan.items || []) {
    const r = await movePath(it.src, it.dst, roots);
    if (r.ok) moved.push({ src: r.src, dst: r.dst });
    else failed.push({ src: it.src, dst: it.dst, error: r.error });
  }
  return { moved, failed, mkdirs: plan.mkdirs || [] };
}

module.exports = {
  IGNORE_DIRS,
  TEXT_EXTS,
  MAX_READ_BYTES,
  normalizeRoots,
  resolveInRoots,
  isInside,
  buildIndex,
  searchIndex,
  searchInFiles,
  listDir,
  readFileText,
  countEntries,
  checkWrite,
  copyPath,
  movePath,
  checkTrash,
  planMoves,
  applyMoves
};
