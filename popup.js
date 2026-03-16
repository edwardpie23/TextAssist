// TextAssist popup script — settings management

const $ = id => document.getElementById(id);

// ── Load saved settings on open ───────────────────────────────────────────

chrome.storage.local.get(['apiKey', 'styleProfile', 'model'], ({ apiKey, styleProfile, model }) => {
  if (apiKey) $('api-key').value = apiKey;
  if (styleProfile) $('style-profile').value = styleProfile;
  if (model) $('model-select').value = model;
});

// ── Toggle API key visibility ─────────────────────────────────────────────

$('toggle-key').addEventListener('click', () => {
  const input = $('api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

// ── Save settings ─────────────────────────────────────────────────────────

$('save-btn').addEventListener('click', () => {
  const apiKey = $('api-key').value.trim();
  const styleProfile = $('style-profile').value.trim();
  const model = $('model-select').value;

  if (!apiKey) {
    showStatus('⚠️ Please enter your Grok API key.', '#f38ba8');
    return;
  }

  if (!apiKey.startsWith('xai-')) {
    showStatus('⚠️ Grok API key should start with "xai-".', '#f38ba8');
    return;
  }

  chrome.storage.local.set({ apiKey, styleProfile, model }, () => {
    showStatus('✅ Settings saved!', '#a6e3a1');
  });
});

// ── Open panel on active tab ───────────────────────────────────────────────

$('open-panel-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' });
  window.close(); // close popup after triggering
});

// ── Helper ────────────────────────────────────────────────────────────────

function showStatus(msg, color = '#a6e3a1') {
  const el = $('save-status');
  el.textContent = msg;
  el.style.color = color;
  setTimeout(() => { el.textContent = ''; }, 3000);
}
