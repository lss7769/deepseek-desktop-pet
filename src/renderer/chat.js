// 独立聊天窗口：气泡列表 + 输入框，复用主进程 pet:chat / 历史记录广播
const list = document.getElementById('list');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const clearBtn = document.getElementById('clear');

let sending = false;

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function modelLabel(model) {
  if (!model) return '';
  return model.includes('pro') ? 'v4-pro' : 'v4-flash';
}

// 她在回答里用到的工具（查天气/看时间/开应用）
const TOOL_NAMES = {
  get_current_time: '看时间',
  get_weather: '查天气',
  open_app: '开应用'
};

function toolLabel(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  return ' · ' + tools.map((t) => TOOL_NAMES[t] || t).join('/');
}

function scrollToEnd() { list.scrollTop = list.scrollHeight; }

function removeEmptyHint() {
  const hint = list.querySelector('.empty');
  if (hint) hint.remove();
}

function showEmptyHint() {
  if (list.children.length) return;
  const hint = document.createElement('div');
  hint.className = 'empty';
  hint.textContent = '还没有聊天记录～在下面说点什么吧';
  list.appendChild(hint);
}

function addMsg(rec) {
  removeEmptyHint();
  const isUser = rec.role === 'user';

  const row = document.createElement('div');
  row.className = 'row ' + (isUser ? 'me' : 'pet');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = rec.text;
  if (!isUser) {
    bubble.classList.add('replayable');
    bubble.title = '点一下让她重念这句';
    bubble.addEventListener('click', () => window.petAPI.replay(rec.text));
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = isUser
    ? fmtTime(rec.ts)
    : `${fmtTime(rec.ts)} · ${modelLabel(rec.model)}${rec.tokens ? ' · ' + rec.tokens + ' tok' : ''}${toolLabel(rec.tools)}`;

  row.appendChild(bubble);
  row.appendChild(meta);
  list.appendChild(row);
  scrollToEnd();
}

function clearList() {
  list.innerHTML = '';
  showEmptyHint();
}

function errorReply(err, status) {
  if (err === 'no_key') return '你还没告诉我 API Key 呢，在桌宠右键「设置 API Key」吧～';
  if (err === 'key_broken') return '我的 Key 好像失效了，右键重新设置一次 API Key 吧～';
  if (err === 'api_status') {
    if (status === 401) return '这个 Key 好像不对哦，再检查一下？';
    if (status === 402) return '账户没钱啦，去 DeepSeek 平台充点值吧～';
    if (status === 429) return '问得太急啦，让我喘口气…';
    return `接口开小差了（${status}），等会儿再试`;
  }
  if (err === 'empty') return '我脑子空了一下，再说一遍？';
  return '网络断啦，我游不过去…';
}

async function send() {
  const msg = input.value.trim();
  if (!msg || sending) return;
  input.value = '';
  sending = true;
  sendBtn.disabled = true;

  // 用户气泡由主进程广播回来（实时显示）；这里只在失败时本地补一条提示
  const r = await window.petAPI.chat(msg);

  sending = false;
  sendBtn.disabled = false;
  input.focus();
  if (!r || !r.ok) {
    // no_key 时主进程提前返回、不会广播用户消息，这里补上回显
    if (r && r.error === 'no_key') addMsg({ role: 'user', text: msg, ts: Date.now() });
    addMsg({ role: 'pet', text: errorReply(r && r.error, r && r.status), ts: Date.now() });
  }
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

clearBtn.addEventListener('click', async () => {
  await window.petAPI.clearHistory();
  clearList();
});

document.getElementById('events-btn').addEventListener('click', () => window.petAPI.openEventsWindow());

window.petAPI.onHistoryAppend((rec) => addMsg(rec));
window.petAPI.onHistoryClear(() => clearList());

// ---------- 记忆面板 ----------
const memoryBtn = document.getElementById('memory-btn');
const memoryPanel = document.getElementById('memory-panel');
const rulesList = document.getElementById('rules-list');
const ruleInput = document.getElementById('rule-input');
const ruleAddBtn = document.getElementById('rule-add-btn');
const profileInput = document.getElementById('profile-input');
const memorySave = document.getElementById('memory-save');
const memoryCancel = document.getElementById('memory-cancel');
const summaryView = document.getElementById('summary-view');

let draftRules = [];

function renderRules() {
  rulesList.innerHTML = '';
  if (!draftRules.length) {
    const empty = document.createElement('div');
    empty.className = 'rule-empty';
    empty.textContent = '还没有规则';
    rulesList.appendChild(empty);
    return;
  }
  draftRules.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'rule-row';
    const span = document.createElement('span');
    span.textContent = r;
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', () => { draftRules.splice(i, 1); renderRules(); });
    row.appendChild(span);
    row.appendChild(del);
    rulesList.appendChild(row);
  });
}

function addRule() {
  const v = ruleInput.value.trim();
  if (!v) return;
  draftRules.push(v);
  ruleInput.value = '';
  renderRules();
}

async function openMemoryPanel() {
  const mem = await window.petAPI.getMemory();
  draftRules = Array.isArray(mem.rules) ? mem.rules.slice() : [];
  profileInput.value = mem.profile || '';
  summaryView.textContent = mem.summary || '（还没有积累要点，聊多了她会自动整理）';
  renderRules();
  memoryPanel.classList.remove('hidden');
  ruleInput.focus();
}

async function saveMemorySettings() {
  const mem = await window.petAPI.setMemory({ rules: draftRules, profile: profileInput.value.trim() });
  draftRules = Array.isArray(mem.rules) ? mem.rules : [];
  memoryPanel.classList.add('hidden');
}

memoryBtn.addEventListener('click', openMemoryPanel);
memoryCancel.addEventListener('click', () => memoryPanel.classList.add('hidden'));
memorySave.addEventListener('click', saveMemorySettings);
ruleAddBtn.addEventListener('click', addRule);
ruleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addRule(); });

async function load() {
  const h = await window.petAPI.getHistory();
  h.forEach(addMsg);
  showEmptyHint();
  input.focus();
}

load();
