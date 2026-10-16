const { app, BrowserWindow, Menu, ipcMain, screen, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsSafe = require('./fs-safe');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// 运行时数据存放在独立目录，避免写向 %APPDATA%（自用，便于清理与迁移）
app.setPath('userData', 'D:\\DeepSeekPet');

const WIN_W = 300;
const WIN_H = 260;

// 鲸鱼娘默认人设：简短、俏皮、嘴硬心软
const DEFAULT_SYSTEM_PROMPT =
  '你是 DeepSeek 的鲸鱼娘「小鲸」，一只蓝色大肥鱼拟人少女，' +
  '性格可爱傲娇、偶尔自嘲吃白饭。回复简短口语化，不超过 40 字，' +
  '不要列表、不要解释、直接像朋友一样回话。';

let win = null;
let chatWin = null;
let muted = false;

// ---------- 配置 ----------
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    cfg = {};
  }
  // 文件助手相关默认值：缺失时补上（首次运行即为默认授权目录）
  if (!Array.isArray(cfg.fileRoots)) cfg.fileRoots = defaultFileRoots();
  if (typeof cfg.fileContentToModel !== 'boolean') cfg.fileContentToModel = true;
  return cfg;
}

// 默认授权目录：代码目录 + 桌面 / 文档 / 下载
function defaultFileRoots() {
  const list = ['D:\\code'];
  for (const k of ['desktop', 'documents', 'downloads']) {
    try { list.push(app.getPath(k)); } catch { /* 该目录取不到就跳过 */ }
  }
  const seen = new Set();
  return list
    .filter(p => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .map(p => ({ path: p, mode: 'rw' }));
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

// ---------- 记忆（主人定的规则 + 关于主人） ----------
const memoryPath = path.join(app.getPath('userData'), 'memory.json');

function loadMemory() {
  try {
    const m = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    return {
      rules: Array.isArray(m.rules) ? m.rules : [],
      profile: String(m.profile || ''),
      summary: String(m.summary || ''),
      summarizedCount: Number(m.summarizedCount) || 0
    };
  } catch {
    return { rules: [], profile: '', summary: '', summarizedCount: 0 };
  }
}

function saveMemory(mem) {
  fs.writeFileSync(memoryPath, JSON.stringify(mem, null, 2));
}

// 把「人设 + 规则 + 关于主人」拼成 system prompt
function buildSystemPrompt(cfg) {
  const parts = [cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT];
  const mem = loadMemory();
  if (mem.rules.length) {
    parts.push('【主人定的规则，必须遵守】\n' + mem.rules.map(r => '- ' + r).join('\n'));
  }
  if (mem.profile.trim()) {
    parts.push('【关于主人】\n' + mem.profile.trim());
  }
  if (mem.summary.trim()) {
    parts.push('【你还记得的往事（自动整理）】\n' + mem.summary.trim());
  }
  return parts.join('\n\n');
}

// ---------- API Key 加密（Windows DPAPI，绑定当前用户账户） ----------
// 存 base64(加密串)；旧版明文 sk-... 首次读取时自动迁移
function getApiKey(cfg) {
  const k = cfg.deepseekApiKey;
  if (!k) return null;
  if (k.startsWith('sk-')) {
    try {
      const enc = safeStorage.encryptString(k).toString('base64');
      saveConfig({ ...cfg, deepseekApiKey: enc });
    } catch { /* 加密失败就先用明文 */ }
    return k;
  }
  try {
    return safeStorage.decryptString(Buffer.from(k, 'base64'));
  } catch {
    return null;
  }
}

// ---------- Token 用量统计（按月重置） ----------
const DEFAULT_MONTHLY_BUDGET = 500000; // 默认月度预算 50 万 token

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getUsage(cfg) {
  const month = currentMonth();
  let u = cfg.usage || {};
  if (u.month !== month) {
    u = { month, input: 0, output: 0 };
  }
  return u;
}

function addUsage(cfg, promptTokens, completionTokens) {
  const u = getUsage(cfg);
  u.input += promptTokens || 0;
  u.output += completionTokens || 0;
  saveConfig({ ...cfg, usage: u });
  return u;
}

function budgetStatus(cfg) {
  const u = getUsage(cfg);
  const budget = cfg.monthlyBudget || DEFAULT_MONTHLY_BUDGET;
  const total = u.input + u.output;
  if (total >= budget) return { level: 'exceeded', total, budget };
  if (total >= budget * 0.8) return { level: 'warn', total, budget };
  return { level: 'ok', total, budget };
}

// ---------- 聊天记录（逐行 JSON 追加，便于导出/清理） ----------
const historyPath = path.join(app.getPath('userData'), 'history.jsonl');

function appendHistory(rec) {
  const full = { ts: Date.now(), ...rec };
  try {
    fs.appendFileSync(historyPath, JSON.stringify(full) + '\n', 'utf8');
  } catch { /* 记录失败不影响聊天 */ }
  broadcast('pet:history-append', full);
}

function readHistory() {
  try {
    return fs.readFileSync(historyPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function clearHistory() {
  try { fs.writeFileSync(historyPath, '', 'utf8'); } catch { /* ignore */ }
}

// ---------- 事件日记（用量 / 声音 / 报错的时间线） ----------
const eventsPath = path.join(app.getPath('userData'), 'events.jsonl');
const EVENTS_MAX = 500; // 只留最近 500 条，避免文件无限增长

function logEvent(type, fields) {
  const ev = { ts: Date.now(), type, ...(fields || {}) };
  try {
    fs.appendFileSync(eventsPath, JSON.stringify(ev) + '\n', 'utf8');
    trimEvents();
  } catch { /* 记录失败不影响主流程 */ }
  broadcast('pet:event-append', ev);
}

function trimEvents() {
  try {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= EVENTS_MAX) return;
    // 破坏性操作（fs_trash）永久留痕，不参与裁剪；其余按最近 EVENTS_MAX 条保留
    const keep = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('"type":"fs_trash"')) keep.add(i);
    }
    for (let i = lines.length - 1; i >= 0 && keep.size < EVENTS_MAX; i--) keep.add(i);
    fs.writeFileSync(eventsPath, lines.filter((_, i) => keep.has(i)).join('\n') + '\n', 'utf8');
  } catch { /* ignore */ }
}

function readEvents(limit = 200) {
  try {
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit);
  } catch {
    return [];
  }
}

function clearEvents() {
  try { fs.writeFileSync(eventsPath, '', 'utf8'); } catch { /* ignore */ }
}

// 向所有窗口广播（聊天窗口可实时收到新记录）
function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

// ---------- 文件助手：白名单目录 + 文件名索引 ----------
const fileIndexPath = path.join(app.getPath('userData'), 'file-index.json');
let fileEntries = [];
let indexTs = 0;
let indexScanning = false;

// 当前授权目录（补上实体路径，防 junction 外逃）
function currentRoots() {
  return fsSafe.normalizeRoots(loadConfig().fileRoots);
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

function loadIndexFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(fileIndexPath, 'utf8'));
    if (Array.isArray(j.entries)) { fileEntries = j.entries; indexTs = Number(j.ts) || 0; }
  } catch { /* 还没建过索引就算了 */ }
}

function saveIndexToDisk() {
  try {
    fs.writeFileSync(fileIndexPath, JSON.stringify({ ts: indexTs, entries: fileEntries }), 'utf8');
  } catch { /* 索引写盘失败不影响使用 */ }
}

// 异步扫描所有授权目录，分批让出主线程，过程中广播进度
async function rebuildIndex() {
  if (indexScanning) return;
  indexScanning = true;
  broadcast('pet:index-progress', { scanning: true, count: fileEntries.length });
  try {
    const res = await fsSafe.buildIndex(currentRoots(), {
      onProgress: (count, root) => broadcast('pet:index-progress', { scanning: true, count, root })
    });
    fileEntries = res.entries;
    indexTs = res.ts;
    saveIndexToDisk();
  } catch { /* 扫描失败保留旧索引 */ } finally {
    indexScanning = false;
    broadcast('pet:index-progress', { scanning: false, count: fileEntries.length, ts: indexTs });
  }
}

// ---------- 上下文记忆 ----------
const CONTEXT_MESSAGES = 6; // 每次请求带上最近 6 条历史（约 3 轮对话）

// ---------- 沉淀机制：把超出上下文窗口的旧对话压缩成「往事要点」 ----------
const DISTILL_TRIGGER = 16; // 历史超过 16 条时触发压缩
const DISTILL_KEEP = CONTEXT_MESSAGES; // 最近 6 条保留原文，不参与压缩
const DISTILL_MIN_BATCH = 6; // 至少积累 6 条（3 轮）才压一次，避免每句都触发
let distilling = false;

async function distillHistory(key) {
  if (distilling || !key) return;
  const before = loadMemory();
  const hist = readHistory();
  const end = hist.length - DISTILL_KEEP;
  if (hist.length <= DISTILL_TRIGGER) return;
  if (end - before.summarizedCount < DISTILL_MIN_BATCH) return;

  distilling = true;
  try {
    const batch = hist.slice(before.summarizedCount, end);
    const lines = batch
      .map(r => (r.role === 'user' ? '主人：' : '小鲸：') + String(r.text || ''))
      .join('\n');

    const prompt = [
      '你在帮桌面宠物「小鲸」整理长期记忆。把旧对话浓缩成不超过 120 字的要点，',
      '只保留值得长期记住的信息（主人的身份、偏好、约定、重要事件），丢掉寒暄和废话。',
      before.summary ? '【已有要点，请合并去重】\n' + before.summary : '',
      '【新增对话】\n' + lines,
      '直接输出合并后的要点，不要解释。'
    ].filter(Boolean).join('\n\n');

    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 400
      })
    });
    if (!res.ok) return;
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (!out) return;

    // 沉淀的花费也算进用量
    const usage = data?.usage || {};
    addUsage(loadConfig(), usage.prompt_tokens, usage.completion_tokens);
    saveMemory({ ...loadMemory(), summary: out, summarizedCount: end });
    logEvent('distill', { batch: batch.length, size: out.length });
    console.log(`[distill] 压缩 ${batch.length} 条 -> ${out.length} 字（cursor=${end}）`);
  } catch { /* 沉淀失败不影响聊天 */ } finally {
    distilling = false;
  }
}

// ---------- v4-pro 智能路由 ----------
const COMPLEX_KEYWORDS = [
  '代码', '函数', '算法', 'bug', '报错', '怎么写', '实现', '解释',
  '原理', '为什么', '区别', '优化', '数据结构', '递归', '复杂度',
  '代码', '编译', '调试', '性能', '架构'
];

function pickModel(message, deepMode) {
  if (deepMode) return 'deepseek-v4-pro';
  const len = String(message).length;
  const complex = COMPLEX_KEYWORDS.some(k => String(message).includes(k));
  if (len > 60 || complex) return 'deepseek-v4-pro';
  return 'deepseek-v4-flash';
}

// ---------- 工具调用（M5）：让小鲸能看时间、查天气、开应用 ----------
const API_URL = 'https://api.deepseek.com/chat/completions';

// 只允许打开这些常见应用（白名单，避免任意命令执行）
const APP_WHITELIST = {
  '记事本': 'notepad.exe', notepad: 'notepad.exe',
  '计算器': 'calc.exe', calc: 'calc.exe',
  '画图': 'mspaint.exe', paint: 'mspaint.exe',
  '资源管理器': 'explorer.exe', explorer: 'explorer.exe',
  vscode: 'code', '代码编辑器': 'code',
  '浏览器': 'msedge.exe', browser: 'msedge.exe'
};

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前的日期和时间（本地时间）。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询某个城市的实时天气。',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，例如「上海」「北京」' } },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: '在主人的电脑上打开一个常用应用。',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '应用名，可选：记事本 / 计算器 / 画图 / 资源管理器 / vscode / 浏览器' }
        },
        required: ['app']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在主人授权的目录里按文件名/路径搜索文件（只读）。返回真实路径清单，供后续 read_file 使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，会匹配文件名或路径' },
          dir: { type: 'string', description: '可选，限定搜索的绝对目录（必须是授权目录内）' },
          ext: { type: 'string', description: '可选，限定扩展名，例如 .md / .py / .txt' },
          limit: { type: 'integer', description: '可选，返回条数上限，默认 30' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_in_files',
      description: '在文件内容里搜索关键词（只读，仅文本文件，较慢）。返回命中的文件路径、行号和该行内容。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要搜索的关键词' },
          dir: { type: 'string', description: '可选，限定搜索的绝对目录（必须是授权目录内）' },
          ext: { type: 'string', description: '可选，限定扩展名，例如 .py' },
          limit: { type: 'integer', description: '可选，命中条数上限，默认 20' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出某个目录下的文件与子目录（只读）。dir 必须是授权目录内的绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '要列出的绝对目录路径' },
          limit: { type: 'integer', description: '可选，条数上限，默认 100' }
        },
        required: ['dir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件的内容（只读，最多 256KB）。path 必须来自 search_files / list_dir 返回的真实路径，不要自己编造。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径，必须来自搜索结果' },
          maxChars: { type: 'integer', description: '可选，最多返回多少字符，默认 4000' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_path',
      description: '用系统默认程序打开一个文件或文件夹（只读，不会修改文件）。path 必须是授权目录内的真实路径。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要打开的绝对路径' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_path',
      description: '把一个文件或目录复制到目标位置（写入操作，会弹确认框让主人确认）。src / dst 都必须是授权目录内的绝对路径，且所在目录是可写（rw）的；目标已存在时不会覆盖，直接中止。',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '源文件/目录的绝对路径，必须来自 search_files / list_dir 的结果' },
          dst: { type: 'string', description: '目标绝对路径（含文件名），上级目录必须已存在' }
        },
        required: ['src', 'dst']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: '把一个文件或目录移动（或重命名）到目标位置（写入操作，会弹确认框让主人确认）。src / dst 都必须是授权目录内的绝对路径，且所在目录是可写（rw）的；目标已存在时不会覆盖，直接中止。',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '源文件/目录的绝对路径，必须来自 search_files / list_dir 的结果' },
          dst: { type: 'string', description: '目标绝对路径（含新文件名），上级目录必须已存在' }
        },
        required: ['src', 'dst']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: '把一个文件移到系统回收站（破坏性操作，会弹确认框让主人确认；可以从回收站恢复）。path 必须是授权目录内、可写（rw）目录下的绝对路径；只能删文件，目录请让主人在文件助手窗口里操作。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要删除的文件的绝对路径，必须来自 search_files / list_dir 的结果' } },
        required: ['path']
      }
    }
  }
];

const WEATHER_CODES = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};

async function toolGetWeather(city) {
  const name = String(city || '').trim() || '北京';
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`
  ).then(r => r.json());
  const hit = geo?.results?.[0];
  if (!hit) return `没找到城市「${name}」`;
  const w = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`
  ).then(r => r.json());
  const c = w?.current;
  if (!c) return `查不到「${name}」的天气`;
  const desc = WEATHER_CODES[c.weather_code] || '未知';
  return `${hit.name}：${desc}，气温 ${c.temperature_2m}°C，湿度 ${c.relative_humidity_2m}%，风速 ${c.wind_speed_10m} km/h`;
}

function toolOpenApp(app) {
  const raw = String(app || '').trim();
  const cmd = APP_WHITELIST[raw.toLowerCase()] || APP_WHITELIST[raw];
  if (!cmd) return `「${raw}」不在白名单里，我只能打开：记事本、计算器、画图、资源管理器、vscode、浏览器`;
  try {
    const { spawn } = require('child_process');
    const child = spawn(cmd, [], { detached: true, stdio: 'ignore', shell: true });
    child.on('error', () => { /* 打不开就算了，别把主进程带崩 */ });
    child.unref();
    return `已经帮主人打开「${raw}」啦`;
  } catch (e) {
    return `打开「${raw}」失败：${String(e && e.message || e)}`;
  }
}

// ---------- 文件助手的只读工具实现 ----------
function toolSearchFiles(args) {
  const query = String(args.query || '').trim();
  if (!query) return '请给我一个搜索关键词。';
  const hits = fsSafe.searchIndex(fileEntries, query, {
    ext: args.ext, dir: args.dir, limit: args.limit || 30
  });
  logEvent('fs_search', { query: query.slice(0, 40), hits: hits.length });
  if (!hits.length) return `没找到和「${query}」匹配的文件。可以换个关键词或去掉类型限制。`;
  return `找到 ${hits.length} 个文件（以下是真实路径，可直接给 read_file 用）：\n` +
    hits.map((h, i) => `${i + 1}. ${h.p}  （${fmtSize(h.s)}，${fmtTime(h.m)}）`).join('\n');
}

async function toolSearchInFiles(args) {
  const keyword = String(args.keyword || '').trim();
  if (!keyword) return '请给我一个要搜索的关键词。';
  const res = await fsSafe.searchInFiles(currentRoots(), keyword, {
    dir: args.dir, ext: args.ext, limit: args.limit || 20
  });
  if (res && res.error) return res.error;
  logEvent('fs_search', { query: keyword.slice(0, 40), hits: res.length });
  if (!res.length) return `文件内容里没找到「${keyword}」。`;
  return `在 ${res.length} 个文件里找到「${keyword}」：\n` +
    res.map((h, i) => `${i + 1}. ${h.p}:${h.line}\n   ${h.snippet}`).join('\n');
}

async function toolListDir(args) {
  const dir = String(args.dir || '').trim();
  if (!dir) return '请给我一个要列出的目录路径。';
  const res = await fsSafe.listDir(dir, currentRoots(), { limit: args.limit || 100 });
  if (!res.ok) return res.error;
  if (!res.items.length) return `目录 ${res.path} 是空的。`;
  return `目录 ${res.path} 下有 ${res.items.length} 项${res.truncated ? '（只列了前面一部分）' : ''}：\n` +
    res.items.map((it, i) =>
      `${i + 1}. ${it.dir ? '[目录] ' : ''}${it.name}${it.dir ? '' : `  （${fmtSize(it.s)}，${fmtTime(it.m)}）`}`
    ).join('\n');
}

async function toolReadFile(args, cfg) {
  const p = String(args.path || '').trim();
  if (!p) return '请给我一个文件路径。';
  const res = await fsSafe.readFileText(p, currentRoots(), { maxChars: args.maxChars || 4000 });
  if (!res.ok) return res.error;
  // 隐私开关：关掉后只回文件名 + 前 200 字摘要，不把正文交给模型
  if (cfg.fileContentToModel === false) {
    return `文件 ${path.basename(res.path)}（${fmtSize(res.size)}）的内容已按隐私设置隐藏，` +
      `只能给你开头 200 字参考：${res.text.slice(0, 200)}…`;
  }
  return `文件：${res.path}（${fmtSize(res.size)}，改于 ${fmtTime(res.mtime)}）\n` +
    `内容${res.truncated ? '（已截断）' : ''}：\n` + res.text;
}

async function toolOpenPath(args) {
  const p = String(args.path || '').trim();
  if (!p) return '请给我一个要打开的文件或目录路径。';
  const r = fsSafe.resolveInRoots(p, currentRoots());
  if (!r.ok) return r.error;
  const err = await shell.openPath(r.path);
  if (err) return `打不开 ${r.path}：${err}`;
  return `已经帮主人打开 ${r.path} 啦`;
}

// ---------- 写入操作的确认框（复制 / 移动） ----------
// 文案必须含：操作类型 + 源绝对路径 + 目标绝对路径 + 是否可恢复 + 影响项数
async function confirmWrite(op, src, dst) {
  const verb = op === 'move' ? '移动' : '复制';
  let detail;
  try {
    const c = await fsSafe.countEntries(src);
    const total = c.files + c.dirs;
    const what = c.dirs > 0
      ? `${total} 项（其中 ${c.files} 个文件、${c.dirs} 个子目录）`
      : `${c.files} 个文件`;
    detail =
      `源：${src}\n` +
      `目标：${dst}\n\n` +
      `影响范围：${what}\n` +
      (op === 'move'
        ? '是否可恢复：源会被移走，可以再从目标移回原位\n'
        : '是否可恢复：源文件保持不动，随时能删掉新副本\n') +
      '若目标位置已有同名文件，她不会覆盖，会直接中止。';
  } catch {
    detail = `源：${src}\n目标：${dst}`;
  }
  const parent = (fileWin && !fileWin.isDestroyed()) ? fileWin
    : (win && !win.isDestroyed() ? win : null);
  const opts = {
    type: 'question',
    title: '小鲸文件助手',
    message: `要${verb}这个吗？`,
    detail,
    buttons: [`确认${verb}`, '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  };
  const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return res.response === 0;
}

// 写入操作统一入口：校验 → 确认框 → 执行 → 记日记（工具与 IPC 共用）
async function performWrite(op, src, dst) {
  const s = String(src || '').trim();
  const d = String(dst || '').trim();
  if (!s || !d) return { ok: false, error: '源路径和目标路径都要给' };
  const chk = await fsSafe.checkWrite(s, d, currentRoots());
  if (!chk.ok) return { ok: false, error: chk.error };
  const yes = await confirmWrite(op, chk.src, chk.dst);
  if (!yes) return { ok: false, canceled: true, error: '已取消' };
  const res = op === 'move'
    ? await fsSafe.movePath(chk.src, chk.dst, currentRoots())
    : await fsSafe.copyPath(chk.src, chk.dst, currentRoots());
  if (!res.ok) return { ok: false, error: res.error };
  logEvent('fs_op', { op, dest: res.dst });
  return { ok: true, op, src: res.src, dst: res.dst };
}

async function toolWritePath(op, args) {
  const src = String(args.src || '').trim();
  const dst = String(args.dst || '').trim();
  if (!src || !dst) return '请同时给我源路径和目标路径（都要是授权目录内的绝对路径）。';
  const r = await performWrite(op, src, dst);
  if (!r.ok) return r.canceled ? '主人取消了，我什么都没动。' : r.error;
  return `${op === 'move' ? '移动' : '复制'}好了：${r.src} → ${r.dst}`;
}

// ---------- 删除（移到回收站） ----------
const recentTrash = new Map(); // realpath -> ts：5 秒内重复删同一个直接拒
const TRASH_REPEAT_MS = 5000;
const TRASH_HOURLY_LIMIT = 20; // 单小时删除上限，超出要二次确认

function trashCountLastHour() {
  const since = Date.now() - 3600 * 1000;
  return readEvents(100000).filter(ev => ev.type === 'fs_trash' && ev.ts >= since).length;
}

// 删除的强确认框：文案含路径 / 影响项数 / 可恢复说明；超频再追加一次确认
async function confirmTrash(p, isDir, hourly) {
  const name = path.basename(p);
  let detail;
  try {
    const c = await fsSafe.countEntries(p);
    const total = c.files + c.dirs;
    const what = isDir ? `${total} 项（其中 ${c.files} 个文件、${c.dirs} 个子目录）` : '1 个文件';
    detail =
      `路径：${p}\n\n` +
      `影响范围：${what}\n` +
      '是否可恢复：可以，它会进系统回收站，随时能还原\n' +
      '注意：这是删除操作，确认后立刻执行。';
  } catch {
    detail = `路径：${p}`;
  }
  const parent = (fileWin && !fileWin.isDestroyed()) ? fileWin
    : (win && !win.isDestroyed() ? win : null);
  const box = (opts) => parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
  const res = await box({
    type: 'warning',
    title: '小鲸文件助手',
    message: `要把「${name}」丢进回收站吗？`,
    detail,
    buttons: ['移到回收站', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (res.response !== 0) return false;
  if (hourly >= TRASH_HOURLY_LIMIT) {
    const res2 = await box({
      type: 'warning',
      title: '小鲸文件助手',
      message: `这个小时已经删除过 ${hourly} 次了`,
      detail: '删得太频繁了，我怕出意外。确定还要继续吗？',
      buttons: ['确定继续', '算了'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    return res2.response === 0;
  }
  return true;
}

// 删除统一入口：校验 → 目录输名字 → 防重复 → 确认框 → trashItem → 永久留痕
async function performTrash(target, confirmName) {
  const chk = await fsSafe.checkTrash(target, currentRoots());
  if (!chk.ok) return { ok: false, error: chk.error };

  // 目录必须输入它自己的名字确认（防误删）
  if (chk.isDir) {
    const want = path.basename(chk.path);
    if (String(confirmName || '').trim() !== want) {
      return { ok: false, needName: true, name: want, error: `删除目录需要输入它的名字「${want}」确认` };
    }
  }

  const last = recentTrash.get(chk.path);
  if (last && Date.now() - last < TRASH_REPEAT_MS) {
    return { ok: false, error: '刚对它操作过，等几秒再来' };
  }

  const yes = await confirmTrash(chk.path, chk.isDir, trashCountLastHour());
  if (!yes) return { ok: false, canceled: true, error: '已取消' };

  try {
    await shell.trashItem(chk.path);
  } catch (e) {
    return { ok: false, error: '回收站失败，没有删除：' + String(e && e.message || e) };
  }
  recentTrash.set(chk.path, Date.now());
  logEvent('fs_trash', { name: path.basename(chk.path), path: chk.path });
  return { ok: true, path: chk.path };
}

async function toolDeletePath(args) {
  const p = String(args.path || '').trim();
  if (!p) return '请给我一个要删除的文件路径。';
  const chk = await fsSafe.checkTrash(p, currentRoots());
  if (!chk.ok) return chk.error;
  if (chk.isDir) return '这是目录。删除目录要主人在文件助手窗口里输入目录名确认，我先用不了。';
  const r = await performTrash(p);
  if (!r.ok) return r.canceled ? '主人取消了，我什么都没删。' : r.error;
  return `已经把 ${r.path} 丢进回收站啦，随时能捞回来。`;
}

// 执行模型请求的工具，返回给模型看的文本结果
async function executeTool(name, rawArgs) {
  let args = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* 参数解析失败按空参数处理 */ }
  try {
    if (name === 'get_current_time') {
      return `现在是 ${new Date().toLocaleString('zh-CN')}`;
    }
    if (name === 'get_weather') return await toolGetWeather(args.city);
    if (name === 'open_app') return toolOpenApp(args.app);
    if (name === 'search_files') return toolSearchFiles(args);
    if (name === 'search_in_files') return await toolSearchInFiles(args);
    if (name === 'list_dir') return await toolListDir(args);
    if (name === 'read_file') return await toolReadFile(args, loadConfig());
    if (name === 'open_path') return await toolOpenPath(args);
    if (name === 'copy_path') return await toolWritePath('copy', args);
    if (name === 'move_path') return await toolWritePath('move', args);
    if (name === 'delete_path') return await toolDeletePath(args);
    return `未知工具：${name}`;
  } catch (e) {
    return `工具执行失败：${String(e && e.message || e)}`;
  }
}

// ---------- 窗口 ----------
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.max(0, width - WIN_W - 40),
    y: Math.max(0, height - WIN_H - 40),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: path.join(__dirname, '..', 'src', 'assets', 'pet', 'whale-girl.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  // 默认整窗鼠标穿透；渲染层命中角色或气泡/输入框时再临时关闭穿透
  win.setIgnoreMouseEvents(true, { forward: true });

  win.on('closed', () => { win = null; });
}

// ---------- 独立聊天窗口 ----------
function openChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return; }
  chatWin = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 340,
    minHeight: 420,
    title: '和小鲸聊天',
    backgroundColor: '#0d1b2e',
    icon: path.join(__dirname, '..', 'src', 'assets', 'pet', 'whale-girl.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  chatWin.setMenuBarVisibility(false);
  chatWin.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'chat.html'));
  chatWin.on('closed', () => { chatWin = null; });
}

// ---------- 小鲸日记窗口 ----------
let eventsWin = null;

function openEventsWindow() {
  if (eventsWin && !eventsWin.isDestroyed()) { eventsWin.show(); eventsWin.focus(); return; }
  eventsWin = new BrowserWindow({
    width: 460,
    height: 600,
    minWidth: 360,
    minHeight: 400,
    title: '小鲸日记',
    backgroundColor: '#0d1b2e',
    icon: path.join(__dirname, '..', 'src', 'assets', 'pet', 'whale-girl.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  eventsWin.setMenuBarVisibility(false);
  eventsWin.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'events.html'));
  eventsWin.on('closed', () => { eventsWin = null; });
}

// ---------- 文件助手窗口 ----------
let fileWin = null;

function openFileWindow() {
  if (fileWin && !fileWin.isDestroyed()) { fileWin.show(); fileWin.focus(); rebuildIndex(); return; }
  fileWin = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 380,
    minHeight: 480,
    title: '小鲸文件助手',
    backgroundColor: '#0d1b2e',
    icon: path.join(__dirname, '..', 'src', 'assets', 'pet', 'whale-girl.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  fileWin.setMenuBarVisibility(false);
  fileWin.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'file.html'));
  fileWin.on('closed', () => { fileWin = null; });
  // 打开窗口时刷新一次索引（按目录 mtime 的思路，全量异步重扫，代价可接受）
  rebuildIndex();
}

// ---------- IPC ----------
ipcMain.on('pet:set-ignore-mouse', (_e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('pet:move-window', (_e, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.handle('pet:config-get', () => loadConfig());

ipcMain.handle('pet:config-set', (_e, patch) => {
  const cfg = loadConfig();
  // 保存 Key 时用 DPAPI 加密
  if (patch.deepseekApiKey) {
    try {
      patch.deepseekApiKey = safeStorage.encryptString(patch.deepseekApiKey).toString('base64');
    } catch { /* 加密失败就明文存，自用可接受 */ }
  }
  const merged = { ...cfg, ...patch };
  saveConfig(merged);
  return merged;
});

// ---------- 聊天记录 & 聊天窗口 IPC ----------
ipcMain.handle('pet:history-get', () => readHistory());

ipcMain.handle('pet:history-clear', () => {
  clearHistory();
  // 记录清空后，沉淀出的要点和游标一并归零
  const mem = loadMemory();
  saveMemory({ ...mem, summary: '', summarizedCount: 0 });
  logEvent('clear');
  broadcast('pet:history-clear');
  return { ok: true };
});

// ---------- 记忆 IPC ----------
ipcMain.handle('pet:memory-get', () => loadMemory());

ipcMain.handle('pet:memory-set', (_e, mem) => {
  const prev = loadMemory();
  const clean = {
    rules: Array.isArray(mem?.rules)
      ? mem.rules.map(String).map(s => s.trim()).filter(Boolean)
      : [],
    profile: String(mem?.profile || ''),
    // 要点和游标由沉淀机制维护，面板保存时原样保留
    summary: prev.summary,
    summarizedCount: prev.summarizedCount
  };
  saveMemory(clean);
  return clean;
});

ipcMain.on('pet:open-chat-window', () => openChatWindow());

// ---------- 小鲸日记 IPC ----------
ipcMain.handle('pet:events-get', () => readEvents());

ipcMain.handle('pet:events-clear', () => {
  clearEvents();
  broadcast('pet:events-clear');
  return { ok: true };
});

ipcMain.on('pet:open-events-window', () => openEventsWindow());

// ---------- 文件助手 IPC（只读部分） ----------
ipcMain.handle('pet:fs-search', (_e, opts) => {
  const o = opts || {};
  if (!fileEntries.length) return { ok: false, error: '索引还没建好，稍等一下再试' };
  const hits = fsSafe.searchIndex(fileEntries, o.query, {
    ext: o.ext, dir: o.dir, limit: o.limit || 50
  });
  return { ok: true, hits, total: fileEntries.length };
});

ipcMain.handle('pet:fs-list-dir', async (_e, dir, opts) => {
  return await fsSafe.listDir(dir, currentRoots(), opts || {});
});

ipcMain.handle('pet:fs-read', async (_e, opts) => {
  const o = opts || {};
  return await fsSafe.readFileText(o.path, currentRoots(), { maxChars: o.maxChars });
});

ipcMain.handle('pet:fs-open', async (_e, p) => {
  const r = fsSafe.resolveInRoots(p, currentRoots());
  if (!r.ok) return { ok: false, error: r.error };
  const err = await shell.openPath(r.path);
  return err ? { ok: false, error: err } : { ok: true, path: r.path };
});

ipcMain.handle('pet:fs-reveal', (_e, p) => {
  const r = fsSafe.resolveInRoots(p, currentRoots());
  if (!r.ok) return { ok: false, error: r.error };
  shell.showItemInFolder(r.path);
  return { ok: true };
});

// 写入：复制 / 移动（UI 触发同样走确认框，与模型工具共用同一套风控）
ipcMain.handle('pet:fs-copy', (_e, src, dst) => performWrite('copy', src, dst));
ipcMain.handle('pet:fs-move', (_e, src, dst) => performWrite('move', src, dst));

// 删除：移到回收站（confirmName 用于目录删前输名字确认）
ipcMain.handle('pet:fs-trash', (_e, target, confirmName) => performTrash(target, confirmName));

// 选择要授权的目录（原生选择框，多选）
ipcMain.handle('pet:fs-roots-pick', async () => {
  const opts = {
    title: '选择要授权给小鲸的目录',
    properties: ['openDirectory', 'multiSelections']
  };
  const res = fileWin && !fileWin.isDestroyed()
    ? await dialog.showOpenDialog(fileWin, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('pet:index-status-get', () => ({
  scanning: indexScanning,
  count: fileEntries.length,
  ts: indexTs
}));

ipcMain.on('pet:open-file-window', () => openFileWindow());

// 聊天窗口点历史里的回复 → 让桌宠重念一遍
ipcMain.on('pet:replay', (_e, text) => {
  if (win && !win.isDestroyed()) win.webContents.send('pet:say', String(text || ''));
});

// ---------- TTS（Edge 神经网络语音） ----------
// 每个声音配独立的 pitch/rate，让女声更萌、童声更甜
const TTS_VOICES = [
  { id: 'zh-CN-XiaoyiNeural',   name: '晓伊（可爱女童）', pitch: '+8Hz',  rate: '0.97' },
  { id: 'zh-CN-XiaoxuanNeural', name: '晓萱（甜美女声）', pitch: '+15Hz', rate: '0.95' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（温柔女声）', pitch: '+15Hz', rate: '0.95' },
  { id: 'zh-CN-YunxiNeural',    name: '云希（阳光男声）', pitch: '0Hz',   rate: '1.00' },
  { id: 'zh-CN-YunjianNeural',  name: '云健（新闻男声）', pitch: '0Hz',   rate: '1.00' }
];
const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';

let ttsInstance = null;
let ttsVoice = null;

async function getTts(voice) {
  if (ttsInstance && ttsVoice === voice) return ttsInstance;
  if (ttsInstance) { try { ttsInstance.close(); } catch {} }
  ttsInstance = new MsEdgeTTS();
  await ttsInstance.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  ttsVoice = voice;
  return ttsInstance;
}

ipcMain.handle('pet:tts', async (_e, text) => {
  if (!text) return { ok: false, error: 'empty' };
  const cfg = loadConfig();
  const voice = cfg.ttsVoice || DEFAULT_VOICE;
  const v = TTS_VOICES.find(x => x.id === voice) || TTS_VOICES[0];
  try {
    const tts = await getTts(voice);
    const { audioStream } = await tts.toStream(String(text).slice(0, 500), { pitch: v.pitch, rate: v.rate });
    const chunks = [];
    for await (const c of audioStream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    return { ok: true, data: buf.toString('base64') };
  } catch {
    ttsInstance = null; // 连接断了，下次重建
    logEvent('error', { code: 'tts_fail' });
    return { ok: false, error: 'tts_fail' };
  }
});

// 调用 DeepSeek：v4-flash / v4-pro 智能路由 + token 统计 + 预算控制 + 工具调用
// opts.forceModel 可强制指定模型（如 'deepseek-v4-flash'）
ipcMain.handle('pet:chat', async (_e, message, opts) => {
  const cfg = loadConfig();
  const key = getApiKey(cfg);
  if (!key) {
    // 有密文却解不开 = 加密密钥失效（例如换了数据目录），提示重设
    const code = cfg.deepseekApiKey ? 'key_broken' : 'no_key';
    logEvent('error', { code });
    return { ok: false, error: code };
  }

  const text = String(message).slice(0, 2000);
  const deepMode = !!cfg.deepMode;
  let model = opts?.forceModel || pickModel(text, deepMode);

  // 预算超了就强制 flash（更便宜），并提示用户
  const bs = budgetStatus(cfg);
  if (bs.level === 'exceeded' && model !== 'deepseek-v4-flash') {
    model = 'deepseek-v4-flash';
  }

  // 上下文记忆：取最近几条历史（在写入当前消息之前读，避免重复）
  const historyMessages = readHistory().slice(-CONTEXT_MESSAGES).map(r => ({
    role: r.role === 'user' ? 'user' : 'assistant',
    content: String(r.text || '')
  }));

  // 记录并广播用户消息（聊天窗口实时显示）
  appendHistory({ role: 'user', text });

  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...historyMessages,
    { role: 'user', content: text }
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let replyTokens = 0;
  const usedTools = [];
  let toolsEnabled = true; // 模型若不支持工具，静默退回普通对话

  try {
    // 可能来回多轮：模型先要求调工具，拿到结果后再回答
    for (let round = 0; round < 3; round++) {
      const body = { model, messages, temperature: 0.85, max_tokens: 800 };
      if (toolsEnabled) body.tools = TOOL_DEFS;

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        if (toolsEnabled && res.status === 400) { toolsEnabled = false; continue; }
        logEvent('error', { code: 'api_status', status: res.status });
        return { ok: false, error: 'api_status', status: res.status };
      }

      const data = await res.json();
      const usage = data?.usage || {};
      promptTokens += usage.prompt_tokens || 0;
      completionTokens += usage.completion_tokens || 0;
      replyTokens += usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens) || 0;

      const msg = data?.choices?.[0]?.message;

      // 模型要求调工具：本地执行，把结果喂回去继续下一轮
      if (msg && msg.tool_calls && msg.tool_calls.length) {
        messages.push(msg);
        for (const call of msg.tool_calls) {
          const name = call && call.function ? call.function.name : '';
          const result = await executeTool(name, call && call.function ? call.function.arguments : '{}');
          usedTools.push(name);
          logEvent('tool', { name });
          messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
        }
        continue;
      }

      const content = msg && msg.content;
      if (!content) {
        logEvent('error', { code: 'empty', model });
        return { ok: false, error: 'empty' };
      }

      // 累加 token 用量
      const u = addUsage(cfg, promptTokens, completionTokens);
      const total = u.input + u.output;
      const budget = cfg.monthlyBudget || DEFAULT_MONTHLY_BUDGET;

      // 记录并广播小鲸的回复
      const rec = { role: 'pet', text: content.trim(), model, tokens: replyTokens };
      if (usedTools.length) rec.tools = usedTools;
      appendHistory(rec);

      const chatEv = { model, tokens: replyTokens, len: text.length };
      if (usedTools.length) chatEv.tools = usedTools;
      logEvent('chat', chatEv);

      console.log(`[chat] model=${model} tokens=${replyTokens} tools=${usedTools.join(',') || '-'} monthTotal=${total}/${budget}`);

      // 后台沉淀：历史超阈值时把旧对话压成要点（不阻塞回复）
      distillHistory(key);

      return {
        ok: true,
        content: content.trim(),
        meta: {
          model,
          tokens: replyTokens,
          tools: usedTools,
          monthUsage: total,
          budget,
          budgetLevel: budgetStatus(loadConfig()).level
        }
      };
    }

    // 三轮下来还在要工具，认输
    logEvent('error', { code: 'tool_loop' });
    return { ok: false, error: 'empty' };
  } catch {
    logEvent('error', { code: 'network' });
    return { ok: false, error: 'network' };
  }
});

function showContextMenu() {
  if (!win || win.isDestroyed()) return;
  const cfg = loadConfig();
  const currentVoice = cfg.ttsVoice || DEFAULT_VOICE;
  const bs = budgetStatus(cfg);
  const u = getUsage(cfg);
  const total = u.input + u.output;
  const budget = cfg.monthlyBudget || DEFAULT_MONTHLY_BUDGET;
  const pct = Math.round((total / budget) * 100);
  const usageLabel = `本月用量：${total.toLocaleString()} / ${budget.toLocaleString()} token（${pct}%）`;
  Menu.buildFromTemplate([
    { label: '和我聊天…', click: () => win.webContents.send('pet:open-chat') },
    { label: 'Flash 快聊…（v4-flash）', click: () => win.webContents.send('pet:open-chat-flash') },
    { label: '打开聊天窗口…', click: () => openChatWindow() },
    { label: '小鲸日记…', click: () => openEventsWindow() },
    { label: '文件助手…（找文件）', click: () => openFileWindow() },
    { label: '设置 API Key…', click: () => win.webContents.send('pet:set-key') },
    {
      label: '换个声音',
      submenu: TTS_VOICES.map(v => ({
        label: v.name,
        type: 'radio',
        checked: v.id === currentVoice,
        click: () => {
          saveConfig({ ...loadConfig(), ttsVoice: v.id });
          ttsInstance = null; // 下次用新声音重建
          logEvent('voice', { voice: v.id, name: v.name });
          win.webContents.send('pet:voice-changed');
        }
      }))
    },
    { label: muted ? '取消静音' : '静音', click: () => { muted = !muted; win.webContents.send('pet:set-muted', muted); } },
    { type: 'separator' },
    {
      label: '深度模式（v4-pro）',
      type: 'checkbox',
      checked: !!cfg.deepMode,
      click: (item) => {
        saveConfig({ ...loadConfig(), deepMode: item.checked });
        logEvent('deepMode', { on: !!item.checked });
        win.webContents.send('pet:say', item.checked ? '好的，我会用更聪明的 v4-pro 回答～' : '切回省电模式啦');
      }
    },
    {
      label: usageLabel,
      enabled: false,
      click: () => {}
    },
    { type: 'separator' },
    { label: '再来一句', click: () => win.webContents.send('pet:say-random') },
    { label: '清空聊天记录', click: () => { clearHistory(); logEvent('clear'); broadcast('pet:history-clear'); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]).popup({ window: win });
}

ipcMain.on('pet:context-menu', showContextMenu);

app.whenReady().then(() => {
  createWindow();
  logEvent('start');
  // 启动后台异步建一次文件名索引（不阻塞桌宠显示）
  loadIndexFromDisk();
  setTimeout(rebuildIndex, 1500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { app.quit(); });
