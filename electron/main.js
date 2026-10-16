const { app, BrowserWindow, Menu, ipcMain, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// 运行时数据写回项目目录，避免写向 %APPDATA%（自用，便于清理与迁移）
app.setPath('userData', path.join(__dirname, '..', '.electron-data'));

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
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
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

// 向所有窗口广播（聊天窗口可实时收到新记录）
function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
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
  broadcast('pet:history-clear');
  return { ok: true };
});

ipcMain.on('pet:open-chat-window', () => openChatWindow());

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
    return { ok: false, error: 'tts_fail' };
  }
});

// 调用 DeepSeek：v4-flash / v4-pro 智能路由 + token 统计 + 预算控制
// opts.forceModel 可强制指定模型（如 'deepseek-v4-flash'）
ipcMain.handle('pet:chat', async (_e, message, opts) => {
  const cfg = loadConfig();
  const key = getApiKey(cfg);
  if (!key) return { ok: false, error: 'no_key' };

  const text = String(message).slice(0, 2000);
  const deepMode = !!cfg.deepMode;
  let model = opts?.forceModel || pickModel(text, deepMode);

  // 预算超了就强制 flash（更便宜），并提示用户
  const bs = budgetStatus(cfg);
  if (bs.level === 'exceeded' && model !== 'deepseek-v4-flash') {
    model = 'deepseek-v4-flash';
  }

  // 记录并广播用户消息（聊天窗口实时显示）
  appendHistory({ role: 'user', text });

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        temperature: 0.85,
        max_tokens: 800
      })
    });
    if (!res.ok) return { ok: false, error: 'api_status', status: res.status };
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'empty' };

    // 累加 token 用量
    const usage = data?.usage || {};
    const u = addUsage(cfg, usage.prompt_tokens, usage.completion_tokens);
    const total = u.input + u.output;
    const budget = cfg.monthlyBudget || DEFAULT_MONTHLY_BUDGET;

    // 记录并广播小鲸的回复
    appendHistory({
      role: 'pet',
      text: content.trim(),
      model,
      tokens: usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens) || 0
    });

    console.log(`[chat] model=${model} tokens=${usage.total_tokens} monthTotal=${total}/${budget}`);

    return {
      ok: true,
      content: content.trim(),
      meta: {
        model,
        tokens: usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens) || 0,
        monthUsage: total,
        budget,
        budgetLevel: budgetStatus(loadConfig()).level
      }
    };
  } catch {
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
    { label: '清空聊天记录', click: () => { clearHistory(); broadcast('pet:history-clear'); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]).popup({ window: win });
}

ipcMain.on('pet:context-menu', showContextMenu);

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { app.quit(); });
