// Content script — injected into every page.
// Handles: conversation reading, floating panel UI, text insertion.

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__textAssistLoaded) return;
  window.__textAssistLoaded = true;

  // ─── Panel State ──────────────────────────────────────────────────────────

  let panel = null;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let lastFocusedInput = null;

  // Track last focused input/textarea/contenteditable
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'INPUT' ||
      el.contentEditable === 'true'
    ) {
      lastFocusedInput = el;
    }
  }, true);

  // ─── Panel Creation ───────────────────────────────────────────────────────

  function createPanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'textassist-panel';
    panel.innerHTML = `
      <div id="ta-header">
        <span id="ta-logo">✦ TextAssist</span>
        <div id="ta-header-actions">
          <button id="ta-minimize" title="Minimize">−</button>
          <button id="ta-close" title="Close">×</button>
        </div>
      </div>
      <div id="ta-body">
        <div id="ta-status">Click <strong>Generate Replies</strong> to get AI suggestions.</div>
        <div id="ta-replies"></div>
        <div id="ta-actions">
          <button id="ta-generate-btn">⚡ Generate Replies</button>
        </div>
        <div id="ta-tone-row">
          <span class="ta-tone-label">Adjust tone:</span>
          <button class="ta-tone-btn" data-tone="shorter">Shorter</button>
          <button class="ta-tone-btn" data-tone="firmer">More Firm</button>
          <button class="ta-tone-btn" data-tone="friendlier">Friendlier</button>
          <button class="ta-tone-btn" data-tone="professional">Professional</button>
        </div>
      </div>
      <div id="ta-minimized-bar" style="display:none">
        <span>✦ TextAssist</span>
        <button id="ta-expand">Expand</button>
      </div>
    `;

    document.body.appendChild(panel);

    // Position bottom-right
    panel.style.bottom = '20px';
    panel.style.right = '20px';

    bindPanelEvents();
  }

  function bindPanelEvents() {
    // Drag header
    const header = panel.querySelector('#ta-header');
    header.addEventListener('mousedown', startDrag);

    // Close
    panel.querySelector('#ta-close').addEventListener('click', () => {
      panel.remove();
      panel = null;
    });

    // Minimize / expand
    panel.querySelector('#ta-minimize').addEventListener('click', minimizePanel);
    panel.querySelector('#ta-expand').addEventListener('click', expandPanel);

    // Generate
    panel.querySelector('#ta-generate-btn').addEventListener('click', onGenerate);

    // Tone buttons — regenerate with tone modifier
    panel.querySelectorAll('.ta-tone-btn').forEach(btn => {
      btn.addEventListener('click', () => onGenerate(btn.dataset.tone));
    });
  }

  function minimizePanel() {
    panel.querySelector('#ta-body').style.display = 'none';
    panel.querySelector('#ta-header').style.display = 'none';
    panel.querySelector('#ta-minimized-bar').style.display = 'flex';
    panel.style.width = 'auto';
  }

  function expandPanel() {
    panel.querySelector('#ta-body').style.display = 'block';
    panel.querySelector('#ta-header').style.display = 'flex';
    panel.querySelector('#ta-minimized-bar').style.display = 'none';
    panel.style.width = '';
  }

  // ─── Drag ─────────────────────────────────────────────────────────────────

  function startDrag(e) {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    e.preventDefault();
  }

  function onDrag(e) {
    if (!isDragging) return;
    panel.style.left = `${e.clientX - dragOffsetX}px`;
    panel.style.top = `${e.clientY - dragOffsetY}px`;
  }

  function stopDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
  }

  // ─── Generate Replies ─────────────────────────────────────────────────────

  async function onGenerate(toneModifier) {
    const tone = typeof toneModifier === 'string' ? toneModifier : null;
    setStatus('Reading conversation…');
    setReplies([]);

    const conversation = readConversation();
    if (!conversation.length) {
      setStatus('⚠️ No conversation found on this page. Try focusing the chat area first.');
      return;
    }

    setStatus('Generating replies…');
    panel.querySelector('#ta-generate-btn').disabled = true;

    try {
      const settings = await getSettings();
      const payload = {
        conversation,
        styleProfile: settings.styleProfile,
        apiKey: settings.apiKey,
        model: settings.model,
      };

      // Append tone instruction to style profile if modifier was requested
      if (tone) {
        const toneMap = {
          shorter: 'Make the reply shorter and more concise.',
          firmer: 'Make the reply more firm and assertive.',
          friendlier: 'Make the reply warmer and more friendly.',
          professional: 'Make the reply more professional and formal.',
        };
        payload.styleProfile = (payload.styleProfile || '') + '\n\nAdditional instruction: ' + toneMap[tone];
      }

      const response = await chrome.runtime.sendMessage({ type: 'GENERATE_REPLIES', payload });

      if (response.error) {
        setStatus(`❌ ${response.error}`);
        return;
      }

      if (!response.replies || !response.replies.length) {
        setStatus('No replies generated. Try again.');
        return;
      }

      setStatus('Click a reply to insert it into the chat box:');
      setReplies(response.replies);
    } catch (err) {
      setStatus(`❌ ${err.message}`);
    } finally {
      panel.querySelector('#ta-generate-btn').disabled = false;
    }
  }

  function setStatus(text) {
    const el = panel.querySelector('#ta-status');
    el.innerHTML = text;
  }

  function setReplies(replies) {
    const container = panel.querySelector('#ta-replies');
    container.innerHTML = '';
    replies.forEach((text, i) => {
      const card = document.createElement('div');
      card.className = 'ta-reply-card';
      card.innerHTML = `
        <div class="ta-reply-label">Option ${i + 1}</div>
        <div class="ta-reply-text">${escapeHtml(text)}</div>
        <button class="ta-insert-btn">Insert ↵</button>
      `;
      card.querySelector('.ta-insert-btn').addEventListener('click', () => insertReply(text));
      container.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── Text Insertion ───────────────────────────────────────────────────────

  function insertReply(text) {
    const target = findInputTarget();
    if (!target) {
      alert('TextAssist: Could not find the chat input box. Click inside the message field first, then try again.');
      return;
    }

    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                           Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(target, text);
      } else {
        target.value = text;
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
    } else if (target.contentEditable === 'true') {
      target.focus();
      // Use execCommand for contenteditable (works in most chat apps)
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      // Fallback
      if (!target.textContent.includes(text)) {
        target.textContent = text;
        target.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }

    setStatus(`✅ Inserted! Review and press Send when ready.`);
  }

  function findInputTarget() {
    // Priority 1: last focused element
    if (lastFocusedInput && document.contains(lastFocusedInput)) {
      return lastFocusedInput;
    }

    // Priority 2: site-specific selectors
    const siteSelectors = [
      // Facebook Messenger
      '[contenteditable="true"][role="textbox"]',
      // Gmail compose
      '[contenteditable="true"].Am.Al.editable',
      // WhatsApp Web
      '[contenteditable="true"][data-tab]',
      // Generic contenteditable
      '[contenteditable="true"]',
      // Generic textarea/input
      'textarea:not([readonly]):not([disabled])',
      'input[type="text"]:not([readonly]):not([disabled])',
    ];

    for (const sel of siteSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }

    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ─── Conversation Reader ──────────────────────────────────────────────────

  function readConversation() {
    const strategies = [
      readFacebookMessenger,
      readGmail,
      readWhatsAppWeb,
      readTuro,
      readGenericChat,
      readGenericFallback,
    ];

    for (const fn of strategies) {
      try {
        const result = fn();
        if (result && result.length >= 1) return result;
      } catch (_) {}
    }

    return [];
  }

  function readFacebookMessenger() {
    // Facebook Messenger message bubbles
    const rows = document.querySelectorAll('[data-testid="messenger-thread-view"] [class*="message"]');
    if (!rows.length) return [];
    return extractFromElements(rows, el => el.textContent.trim());
  }

  function readGmail() {
    // Gmail thread view
    const messages = document.querySelectorAll('.h7, .gs, [data-message-id]');
    if (!messages.length) return [];
    return Array.from(messages).map((el, i) => {
      const sender = el.querySelector('.gD')?.getAttribute('email') ||
                     el.querySelector('.go')?.textContent ||
                     (i % 2 === 0 ? 'Them' : 'You');
      const body = el.querySelector('.a3s, .adP')?.textContent?.trim() || el.textContent.trim();
      return { sender, text: body };
    }).filter(m => m.text.length > 0);
  }

  function readWhatsAppWeb() {
    const rows = document.querySelectorAll('[class*="message-in"], [class*="message-out"]');
    if (!rows.length) return [];
    return Array.from(rows).map(el => {
      const isOut = el.className.includes('message-out');
      const text = el.querySelector('[class*="copyable-text"], span[dir]')?.textContent?.trim() || '';
      return { sender: isOut ? 'You' : 'Them', text };
    }).filter(m => m.text.length > 0);
  }

  function readTuro() {
    // Turo chat — generic enough to be caught by fallback, but try specific first
    const rows = document.querySelectorAll('[class*="chat-message"], [class*="ChatMessage"], [class*="message-bubble"]');
    if (!rows.length) return [];
    return extractFromElements(rows, el => el.textContent.trim());
  }

  function readGenericChat() {
    // Common chat patterns
    const selectors = [
      '[role="listitem"]',
      '[data-message]',
      '[class*="message-row"]',
      '[class*="msg-row"]',
      '[class*="chat-row"]',
      '[class*="ConversationItem"]',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length >= 2) return extractFromElements(els, el => el.textContent.trim());
    }
    return [];
  }

  function readGenericFallback() {
    // Last resort: grab all text content from the visible area that looks like chat
    const candidates = Array.from(document.querySelectorAll('p, div, span'))
      .filter(el => {
        const t = el.textContent.trim();
        return t.length > 5 && t.length < 1000 && el.children.length === 0;
      })
      .slice(-30); // last 30 text nodes

    if (candidates.length < 3) return [];
    return candidates.map((el, i) => ({
      sender: i % 2 === 0 ? 'Them' : 'You',
      text: el.textContent.trim(),
    }));
  }

  function extractFromElements(els, getText) {
    return Array.from(els).map((el, i) => ({
      sender: i % 2 === 0 ? 'Them' : 'You',
      text: getText(el),
    })).filter(m => m.text.length > 0);
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  function getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(['apiKey', 'styleProfile', 'model'], resolve);
    });
  }

  // ─── Floating Trigger Button ───────────────────────────────────────────────

  function createTriggerButton() {
    if (document.getElementById('textassist-trigger')) return;

    const btn = document.createElement('button');
    btn.id = 'textassist-trigger';
    btn.title = 'TextAssist — Generate Reply';
    btn.innerHTML = '✦';
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      if (!panel) {
        createPanel();
      } else {
        // Already open — just bring attention to generate button
        expandPanel();
      }
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  createTriggerButton();

  // Listen for messages from popup (e.g., "open panel")
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'OPEN_PANEL') {
      if (!panel) createPanel();
      else expandPanel();
    }
  });
})();
