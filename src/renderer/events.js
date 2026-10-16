// 小鲸日记：本月用量卡片 + 事件时间线（从新到旧）
const list = document.getElementById('list');
const usageNum = document.getElementById('usage-num');
const usageBar = document.getElementById('usage-bar');
const budgetHint = document.getElementById('budget-hint');
const modeHint = document.getElementById('mode-hint');
const clearBtn = document.getElementById('clear');

const MAX_ROWS = 200; // 界面最多保留这么多条

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function modelShort(m) {
  return m && m.includes('pro') ? 'v4-pro' : 'v4-flash';
}

function describeError(ev) {
  if (ev.code === 'api_status') {
    const s = ev.status;
    if (s === 401) return 'API Key 无效（401）';
    if (s === 402) return '账户余额不足（402）';
    if (s === 429) return '请求太频繁（429）';
    return `接口返回异常（${s}）`;
  }
  const map = {
    no_key: '还没设置 API Key，先跟她说句话试试',
    key_broken: 'API Key 解不开，需要重新设置',
    empty: '回复是空的（可能思考阶段耗尽了 token）',
    network: '网络请求失败',
    tts_fail: '语音合成失败',
    tool_loop: '工具调用绕不出来了，只好放弃'
  };
  return map[ev.code] || `出错了（${ev.code}）`;
}

// 工具的中文名
const TOOL_NAMES = {
  get_current_time: '看时间',
  get_weather: '查天气',
  open_app: '开应用',
  search_files: '找文件',
  search_in_files: '搜内容',
  list_dir: '列目录',
  read_file: '读文件',
  open_path: '打开文件',
  copy_path: '复制文件',
  move_path: '移动文件',
  delete_path: '删除文件',
  apply_moves: '批量整理'
};

// 每类事件的圆点颜色与文案
function describe(ev) {
  switch (ev.type) {
    case 'start':
      return { dot: 'gray', text: '小鲸上线了' };
    case 'chat':
      return { dot: 'blue', text: `${modelShort(ev.model)} 回答了一句 · ${(ev.tokens || 0).toLocaleString()} token` };
    case 'voice':
      return { dot: 'purple', text: `换成声音「${ev.name || ev.voice}」` };
    case 'deepMode':
      return { dot: 'cyan', text: ev.on ? '开启深度模式（强制 v4-pro）' : '关闭深度模式，恢复自动路由' };
    case 'distill':
      return { dot: 'green', text: `把 ${ev.batch} 条旧对话整理成 ${ev.size} 字要点` };
    case 'clear':
      return { dot: 'orange', text: '清空了聊天记录' };
    case 'tool':
      return { dot: 'teal', text: `用了工具「${TOOL_NAMES[ev.name] || ev.name}」` };
    case 'fs_search':
      return { dot: 'gray', text: `翻了翻文件，找「${ev.query}」命中 ${ev.hits} 个` };
    case 'fs_op':
      if (ev.op === 'batch') return { dot: 'teal', text: `批量整理了 ${ev.count} 个文件` };
      return { dot: 'teal', text: `${ev.op === 'move' ? '移动' : '复制'}了文件（${ev.dest || ''}）` };
    case 'fs_trash':
      return { dot: 'orange', text: `把「${ev.name || ev.path || '一个文件'}」丢进了回收站` };
    case 'error':
      return { dot: 'red', text: describeError(ev) };
    default:
      return { dot: 'gray', text: String(ev.type || '事件') };
  }
}

function makeRow(ev) {
  const { dot, text } = describe(ev);

  const row = document.createElement('div');
  row.className = 'ev';

  const d = document.createElement('span');
  d.className = 'dot dot-' + dot;

  const main = document.createElement('span');
  main.className = 'ev-text';
  main.textContent = text;

  const time = document.createElement('span');
  time.className = 'ev-time';
  time.textContent = fmtTime(ev.ts);

  row.appendChild(d);
  row.appendChild(main);
  row.appendChild(time);
  return row;
}

function removeEmptyHint() {
  const hint = list.querySelector('.empty');
  if (hint) hint.remove();
}

function showEmptyHint() {
  if (list.children.length) return;
  const hint = document.createElement('div');
  hint.className = 'empty';
  hint.textContent = '还没有日记～多和她说说话吧';
  list.appendChild(hint);
}

// prepend=true 时插到最前面（新事件实时到来）
function addEvent(ev, prepend) {
  removeEmptyHint();
  if (prepend && list.firstChild) list.insertBefore(makeRow(ev), list.firstChild);
  else list.appendChild(makeRow(ev));

  const rows = list.querySelectorAll('.ev');
  for (let i = MAX_ROWS; i < rows.length; i++) rows[i].remove();
}

// ---------- 用量卡片 ----------
async function renderUsage() {
  const cfg = await window.petAPI.getConfig();
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const u = cfg.usage && cfg.usage.month === month ? cfg.usage : {};
  const total = (u.input || 0) + (u.output || 0);
  const budget = cfg.monthlyBudget || 500000;
  const pct = Math.round((total / budget) * 100);

  usageNum.textContent = `${total.toLocaleString()} / ${budget.toLocaleString()} token`;
  usageBar.style.width = Math.min(100, pct) + '%';
  usageBar.className = 'bar-fill ' + (pct >= 100 ? 'exceeded' : pct >= 80 ? 'warn' : 'ok');
  budgetHint.textContent = `预算已用 ${pct}%`;
  modeHint.textContent = cfg.deepMode
    ? '模式：深度（v4-pro）'
    : '模式：自动路由（闲聊 flash / 难题 pro）';
}

clearBtn.addEventListener('click', async () => {
  await window.petAPI.clearEvents();
  list.innerHTML = '';
  showEmptyHint();
});

window.petAPI.onEventAppend((ev) => { addEvent(ev, true); renderUsage(); });
window.petAPI.onEventClear(() => { list.innerHTML = ''; showEmptyHint(); });

async function load() {
  const events = await window.petAPI.getEvents();
  // 文件里旧的在前，倒着渲染让最新的排在最上面
  for (let i = events.length - 1; i >= 0; i--) addEvent(events[i], false);
  showEmptyHint();
  renderUsage();
}

load();
