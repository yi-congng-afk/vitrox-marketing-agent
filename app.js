const STORAGE_KEY = 'vitrox_chat_state';

const QUICK_ACTIONS = [
  { label: 'Write a Script', seed: 'I need a script/storyboard for a social media video.' },
  { label: 'Content Calendar', seed: 'Help me plan a content calendar.' },
  { label: 'SEO Audit', seed: 'I want to improve our website/blog for SEO.' },
  { label: 'Storyboard', seed: 'I need a storyboard/shot list for an event or video.' },
  { label: 'Analytics', seed: 'I want to review recent performance data.' },
  { label: 'Ad Campaign', seed: 'I need to set up or fix a Meta/Google ad campaign.' },
  { label: 'Meta Business Suite', seed: 'Something needs attention on our Facebook/Instagram Page or Business Suite.' },
  { label: 'Google Business Profile', seed: 'I want to update our Google Business Profile.' },
  { label: 'Caption', seed: 'I need a caption for a post.' },
];

const loginView = document.getElementById('login-view');
const chatView = document.getElementById('chat-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const quickActionsEl = document.getElementById('quick-actions');
const messageListEl = document.getElementById('message-list');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const newConversationBtn = document.getElementById('new-conversation-btn');

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through to fresh state
  }
  return createFreshState();
}

function createFreshState() {
  const id = `thread_${new Date().getTime()}`;
  return {
    activeThreadId: id,
    threads: { [id]: { title: 'New Conversation', createdAt: new Date().toISOString(), messages: [] } },
  };
}

let state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function activeThread() {
  return state.threads[state.activeThreadId];
}

function renderQuickActions() {
  quickActionsEl.innerHTML = '';
  QUICK_ACTIONS.forEach((action) => {
    const btn = document.createElement('button');
    btn.className = 'quick-action-btn';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      chatInput.value = action.seed;
      chatInput.focus();
    });
    quickActionsEl.appendChild(btn);
  });
}

function renderMessages() {
  messageListEl.innerHTML = '';
  activeThread().messages.forEach((msg) => appendMessageEl(msg));
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function appendMessageEl(msg) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${msg.role}`;
  wrapper.textContent = msg.content;
  messageListEl.appendChild(wrapper);

  if (msg.role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(msg.content);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download .txt';
    downloadBtn.addEventListener('click', () => {
      const blob = new Blob([msg.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vitrox-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });

    actions.appendChild(copyBtn);
    actions.appendChild(downloadBtn);
    messageListEl.appendChild(actions);
  }

  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function showThinking() {
  const el = document.createElement('div');
  el.className = 'message thinking';
  el.id = 'thinking-indicator';
  el.textContent = 'Thinking...';
  messageListEl.appendChild(el);
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

function hideThinking() {
  const el = document.getElementById('thinking-indicator');
  if (el) el.remove();
}

function showError(text) {
  const el = document.createElement('div');
  el.className = 'message error';
  el.textContent = text;
  messageListEl.appendChild(el);
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

async function sendMessage(text) {
  const thread = activeThread();
  thread.messages.push({ role: 'user', content: text, ts: new Date().toISOString() });
  saveState();
  renderMessages();
  showThinking();

  try {
    const res = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: thread.messages.map((m) => ({ role: m.role, content: m.content })) }),
    });

    hideThinking();

    if (res.status === 401) {
      showLogin();
      return;
    }

    const data = await res.json();

    if (!res.ok) {
      showError(`Error: ${data.error || 'Something went wrong.'}`);
      return;
    }

    thread.messages.push({ role: 'assistant', content: data.content, ts: new Date().toISOString() });
    saveState();
    renderMessages();
  } catch {
    hideThinking();
    showError('Network error — please try again.');
  }
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  sendMessage(text);
});

newConversationBtn.addEventListener('click', () => {
  const id = `thread_${new Date().getTime()}`;
  state.threads[id] = { title: 'New Conversation', createdAt: new Date().toISOString(), messages: [] };
  state.activeThreadId = id;
  saveState();
  renderMessages();
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/.netlify/functions/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      loginError.textContent = 'Incorrect password.';
      loginError.hidden = false;
      return;
    }

    showChat();
  } catch {
    loginError.textContent = 'Network error — please try again.';
    loginError.hidden = false;
  }
});

function showLogin() {
  loginView.hidden = false;
  chatView.hidden = true;
}

function showChat() {
  loginView.hidden = true;
  chatView.hidden = false;
  renderQuickActions();
  renderMessages();
}

async function checkAuthAndInit() {
  try {
    const res = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      showLogin();
    } else {
      showChat();
    }
  } catch {
    showLogin();
  }
}

checkAuthAndInit();
