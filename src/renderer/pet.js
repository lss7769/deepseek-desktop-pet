// M1+M2+M3：鲸鱼娘桌宠 —— 透明置顶 + 点击穿透 + 台词 + DeepSeek 对话 + TTS 语音 + 动态效果
// 角色图：src/assets/pet/whale-girl.png（原生透明通道，无需抠图）

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const bubble = document.getElementById('bubble');
const chatBar = document.getElementById('chat-bar');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const keyBar = document.getElementById('key-bar');
const keyInput = document.getElementById('key-input');
const keySave = document.getElementById('key-save');

// 右下角小状态条（显示当前模型/token）
const statusLine = document.createElement('div');
statusLine.id = 'status-line';
document.body.appendChild(statusLine);
let statusTimer = null;
function setStatusLine(text) {
  statusLine.textContent = text;
  statusLine.style.opacity = '0.7';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusLine.style.opacity = '0'; }, 4000);
}

const QUOTES = [
  '我在这儿呢～',
  '今天也要好好学 C 语言哦',
  '摸鱼不是罪，是充电～',
  '算法题做不出来？先喝口水',
  '叫我干嘛？我听得见～',
  '蓝鲸也是要睡觉的…zzZ',
  '唔…又有人来卷了',
  '记得多喝水，眼睛也要休息',
  '我可是吃白饭的蓝色大肥鱼！'
];

const PET_H = 214;        // 角色显示高度
const PET_BOTTOM = 8;     // 距窗口底部留白
const BOUNCE_MS = 380;    // 点击蹦跳时长

let petSprite = null;
let floatOffset = 0;
let startedAt = 0;

// ---------- 动画状态 ----------
let animState = 'idle';   // idle | talking
let bounceUntil = 0;      // 点击蹦跳结束时刻
let muted = false;
let chatOpen = false;
let keyOpen = false;

// ---------- 加载角色 ----------
function loadPet() {
  if (!window.PET_IMAGE_DATA_URL) return;
  const img = new Image();
  img.onload = () => { petSprite = img; };
  img.src = window.PET_IMAGE_DATA_URL;
}

// ---------- 绘制（单一 rAF 驱动，transform 合成） ----------
function drawPet(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!petSprite) return;

  const sh = petSprite.naturalHeight;
  const sw = petSprite.naturalWidth;
  const scale = PET_H / sh;
  const w = sw * scale;
  const cx = canvas.width / 2;
  const bottom = (chatOpen || keyOpen) ? 56 : PET_BOTTOM; // 输入框打开时把角色上移
  const baseY = canvas.height - PET_H - bottom + floatOffset;

  ctx.save();
  // 以脚底中心为支点：呼吸/摇摆更自然
  ctx.translate(cx, baseY + PET_H);

  const sway = Math.sin(t / 1500) * 0.02;          // 左右轻摆
  const breathe = 1 + Math.sin(t / 1300) * 0.025;  // 呼吸缩放
  ctx.rotate(sway);
  ctx.scale(1, breathe);

  // 说话时上下颠；点击时蹦一下
  let dy = 0;
  if (animState === 'talking') dy -= Math.abs(Math.sin(t / 90)) * 5;
  if (t < bounceUntil) {
    const p = (bounceUntil - t) / BOUNCE_MS;
    dy -= Math.sin(p * Math.PI) * 16;
  }

  ctx.translate(0, dy - PET_H);
  ctx.drawImage(petSprite, -w / 2, 0, w, PET_H);
  ctx.restore();
}

function tick(ts) {
  if (!startedAt) startedAt = ts;
  const t = ts - startedAt;
  floatOffset = Math.sin(t / 700) * 4;
  drawPet(t);
  requestAnimationFrame(tick);
}

loadPet();
requestAnimationFrame(tick);

// ---------- 气泡 + 语音（TTS） ----------
let bubbleVisibleUntil = 0;
let hideTimer = null;

function showBubble(text, ms = 3500) {
  bubble.textContent = text;
  bubble.classList.remove('hidden');
  bubbleVisibleUntil = Date.now() + ms;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    bubble.classList.add('hidden');
    bubbleVisibleUntil = 0;
  }, ms);
}

// 语音：Edge 神经网络语音（晓晓/云希等），主进程 msedge-tts 合成 mp3 后播放
let currentAudio = null;

async function speak(text) {
  if (muted || !text) return;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  const r = await window.petAPI.tts(text);
  if (!r.ok) return;
  try {
    currentAudio = new Audio('data:audio/mp3;base64,' + r.data);
    currentAudio.onplay = () => { animState = 'talking'; };
    currentAudio.onended = () => { animState = 'idle'; currentAudio = null; };
    currentAudio.onerror = () => { animState = 'idle'; currentAudio = null; };
    currentAudio.play().catch(() => { animState = 'idle'; });
  } catch { animState = 'idle'; }
}

// 说一句话：冒泡 + 朗读
function say(text, ms) {
  showBubble(text, ms);
  speak(text);
}

function randomQuote() { return QUOTES[Math.floor(Math.random() * QUOTES.length)]; }

// ---------- 穿透控制 ----------
let lastIgnore = null;
function setIgnore(ignore) {
  if (ignore === lastIgnore) return;
  lastIgnore = ignore;
  window.petAPI.setIgnoreMouse(ignore);
}

function alphaAt(x, y) {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
  return ctx.getImageData(px, py, 1, 1).data[3];
}

function isOverBubble(clientX, clientY) {
  if (bubble.classList.contains('hidden') || Date.now() > bubbleVisibleUntil) return false;
  const r = bubble.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

canvas.addEventListener('mousemove', (e) => {
  // 输入框打开时整窗不穿透，便于点击输入
  if (chatOpen || keyOpen) { setIgnore(false); return; }
  const overPet = alphaAt(e.offsetX, e.offsetY) > 24;
  const overBubble = isOverBubble(e.clientX, e.clientY);
  setIgnore(!(overPet || overBubble));
});

document.addEventListener('mouseleave', () => {
  if (!chatOpen && !keyOpen) setIgnore(true);
});

// ---------- 拖拽 + 点击 ----------
let dragging = false;
let moved = false;
let downX = 0, downY = 0, lastX = 0, lastY = 0;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 输入框打开时点击角色 = 关闭输入框，不拖拽
  if (chatOpen || keyOpen) {
    closeChat(); closeKey();
    return;
  }
  dragging = true;
  moved = false;
  downX = lastX = e.screenX;
  downY = lastY = e.screenY;
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  if (dx !== 0 || dy !== 0) {
    window.petAPI.moveWindow(dx, dy);
    lastX = e.screenX;
    lastY = e.screenY;
  }
  if (Math.hypot(e.screenX - downX, e.screenY - downY) > 4) moved = true;
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (!moved) {
    bounceUntil = performance.now() + BOUNCE_MS; // 点击蹦跳
    say(randomQuote());
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.openContextMenu();
});

// ---------- 聊天 ----------
let forceFlash = false; // Flash 快聊模式：固定用 v4-flash
function openChat(opts) {
  forceFlash = !!(opts && opts.forceFlash);
  chatOpen = true;
  chatBar.classList.remove('hidden');
  chatInput.value = '';
  chatInput.placeholder = forceFlash ? 'v4-flash 快聊…（省钱又快）' : '想说点什么？';
  chatInput.focus();
  setIgnore(false);
}
function closeChat() {
  chatOpen = false;
  forceFlash = false;
  chatBar.classList.add('hidden');
  if (!keyOpen) setIgnore(true);
}

async function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  chatInput.value = '';
  showBubble('……');
  const opts = forceFlash ? { forceModel: 'deepseek-v4-flash' } : undefined;
  const r = await window.petAPI.chat(msg, opts);
  if (r.ok) {
    say(r.content, 6000);
    // 右下角小字显示用了哪个模型 + 本次 token
    if (r.meta) {
      const modelName = r.meta.model.includes('pro') ? 'v4-pro' : 'v4-flash';
      setStatusLine(`${modelName} · ${r.meta.tokens} tok`);
    }
  } else {
    say(errorReply(r.error, r.status), 5000);
  }
}

function errorReply(err, status) {
  if (err === 'no_key') return '你还没告诉我 API Key 呢，右键「设置 API Key」吧～';
  if (err === 'api_status') {
    if (status === 401) return '这个 Key 好像不对哦，再检查一下？';
    if (status === 402) return '账户没钱啦，去 DeepSeek 平台充点值吧～';
    if (status === 404) return '模型地址不对…等我修修。';
    if (status === 429) return '问得太急啦，让我喘口气…';
    return `接口开小差了（${status}），等会儿再试`;
  }
  if (err === 'empty') return '我脑子空了一下，再说一遍？';
  return '网络断啦，我游不过去…';
}

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// ---------- API Key ----------
function openKey() {
  keyOpen = true;
  keyBar.classList.remove('hidden');
  keyInput.value = '';
  keyInput.focus();
  setIgnore(false);
}
function closeKey() {
  keyOpen = false;
  keyBar.classList.add('hidden');
  if (!chatOpen) setIgnore(true);
}

async function saveKey() {
  const k = keyInput.value.trim();
  closeKey();
  if (!k) return;
  await window.petAPI.setConfig({ deepseekApiKey: k });
  say('记下啦，现在可以聊天了～');
}

keySave.addEventListener('click', saveKey);
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });

// Escape 关闭输入框
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeChat(); closeKey(); }
});

// ---------- 主进程事件 ----------
window.petAPI.onOpenChat(() => { closeKey(); openChat(); });
window.petAPI.onOpenChatFlash(() => { closeKey(); openChat({ forceFlash: true }); });
window.petAPI.onSetKey(() => { closeChat(); openKey(); });
window.petAPI.onSayRandom(() => say(randomQuote()));
window.petAPI.onSay((text) => say(text));
window.petAPI.onSetMuted((m) => {
  muted = m;
  if (muted && currentAudio) { currentAudio.pause(); currentAudio = null; }
  animState = 'idle';
});
window.petAPI.onVoiceChanged(() => {
  // 换声音后立刻试一句，让用户听到效果
  say('换好啦，听听我的新声音～');
});
