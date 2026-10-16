const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
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
  const cfg = { ...loadConfig(), ...patch };
  saveConfig(cfg);
  return cfg;
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

// 调用 DeepSeek v4-flash；错误不泄漏密钥，只返回错误类型
ipcMain.handle('pet:chat', async (_e, message) => {
  const cfg = loadConfig();
  const key = cfg.deepseekApiKey;
  if (!key) return { ok: false, error: 'no_key' };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT },
          { role: 'user', content: String(message).slice(0, 2000) }
        ],
        temperature: 0.85,
        max_tokens: 300
      })
    });
    if (!res.ok) return { ok: false, error: 'api_status', status: res.status };
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: 'empty' };
    return { ok: true, content: content.trim() };
  } catch {
    return { ok: false, error: 'network' };
  }
});

function showContextMenu() {
  if (!win || win.isDestroyed()) return;
  const cfg = loadConfig();
  const currentVoice = cfg.ttsVoice || DEFAULT_VOICE;
  Menu.buildFromTemplate([
    { label: '和我聊天…', click: () => win.webContents.send('pet:open-chat') },
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
    { label: '再来一句', click: () => win.webContents.send('pet:say-random') },
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
