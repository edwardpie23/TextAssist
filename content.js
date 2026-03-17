// Content script — injected into every page.
// Handles: conversation reading, floating panel UI, text insertion.

(function () {
  'use strict';

  if (window.__textAssistLoaded) return;
  window.__textAssistLoaded = true;

  // ─── State ────────────────────────────────────────────────────────────────

  let panel = null;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // The last input/textarea/contenteditable the user touched — updated on focusin
  let lastFocusedInput = null;
  // Locked at Generate-click time so Insert always uses the same target
  let lockedInsertTarget = null;
  // True when waiting for the user to click a target
  let pickingTarget = false;

  // Never track focus inside our own panel
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (isOurElement(el)) return;
    if (
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'INPUT' ||
      el.contentEditable === 'true'
    ) {
      lastFocusedInput = el;
    }
  }, true);

  function isOurElement(el) {
    const p = document.getElementById('textassist-panel');
    const t = document.getElementById('textassist-trigger');
    return (p && p.contains(el)) || (t && t === el);
  }

  // ─── Panel HTML ───────────────────────────────────────────────────────────

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

        <!-- Target indicator -->
        <div id="ta-target-row">
          <span id="ta-target-label">Insert into: <strong id="ta-target-name">not set</strong></span>
          <button id="ta-pick-target">Pick ✎</button>
        </div>

        <!-- Status -->
        <div id="ta-status">Click <strong>Generate Replies</strong> to get AI suggestions.</div>

        <!-- Replies -->
        <div id="ta-replies"></div>

        <!-- Manual conversation paste (shown when auto-read fails) -->
        <div id="ta-manual-section" style="display:none">
          <div class="ta-manual-label">Paste the conversation here:</div>
          <textarea id="ta-manual-input" rows="5" placeholder="Paste the chat messages here, then click Generate Replies…"></textarea>
        </div>

        <!-- Actions -->
        <div id="ta-actions">
          <button id="ta-generate-btn">⚡ Generate Replies</button>
        </div>

        <!-- Tone row -->
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
    panel.style.bottom = '80px';
    panel.style.right = '20px';

    bindPanelEvents();
    updateTargetLabel();
  }

  function bindPanelEvents() {
    panel.querySelector('#ta-header').addEventListener('mousedown', startDrag);
    panel.querySelector('#ta-close').addEventListener('click', closePanel);
    panel.querySelector('#ta-minimize').addEventListener('click', minimizePanel);
    panel.querySelector('#ta-expand').addEventListener('click', expandPanel);
    panel.querySelector('#ta-generate-btn').addEventListener('click', onGenerate);
    panel.querySelector('#ta-pick-target').addEventListener('click', startPickTarget);
    panel.querySelectorAll('.ta-tone-btn').forEach(btn => {
      btn.addEventListener('click', () => onGenerate(btn.dataset.tone));
    });
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
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

  // ─── Pick Target ──────────────────────────────────────────────────────────

  function startPickTarget() {
    pickingTarget = true;
    setStatus('👆 Click the chat input box you want to type into…');
    minimizePanel();

    document.addEventListener('click', onPickTargetClick, { capture: true, once: true });
    // Cancel on Escape
    document.addEventListener('keydown', cancelPickTarget, { once: true });
  }

  function onPickTargetClick(e) {
    if (isOurElement(e.target)) {
      // They clicked our panel — cancel
      pickingTarget = false;
      expandPanel();
      setStatus('Pick cancelled.');
      return;
    }

    const el = e.target;
    if (
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'INPUT' ||
      el.contentEditable === 'true'
    ) {
      lockedInsertTarget = el;
      lastFocusedInput = el;
      pickingTarget = false;
      expandPanel();
      updateTargetLabel();
      setStatus('✅ Target set! Now click Generate Replies.');
    } else {
      pickingTarget = false;
      expandPanel();
      setStatus('⚠️ That doesn\'t look like a text box. Try clicking directly inside the message input.');
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function cancelPickTarget(e) {
    if (e.key === 'Escape') {
      pickingTarget = false;
      expandPanel();
      setStatus('Pick cancelled.');
      document.removeEventListener('click', onPickTargetClick, { capture: true });
    }
  }

  function updateTargetLabel() {
    if (!panel) return;
    const nameEl = panel.querySelector('#ta-target-name');
    const target = lockedInsertTarget || lastFocusedInput;
    if (!target) {
      nameEl.textContent = 'not set — click Pick ✎';
      nameEl.style.color = '#f38ba8';
    } else {
      nameEl.textContent = describeElement(target);
      nameEl.style.color = '#a6e3a1';
    }
  }

  function describeElement(el) {
    if (!el) return 'unknown';
    const tag = el.tagName.toLowerCase();
    const ph = el.placeholder || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '';
    if (ph) return `${tag} "${ph.slice(0, 30)}"`;
    const cls = Array.from(el.classList).slice(0, 2).join('.');
    return cls ? `${tag}.${cls}` : tag;
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

    // Lock the insert target NOW — before anything else changes focus
    lockedInsertTarget = lockedInsertTarget || lastFocusedInput || findInputTarget();
    updateTargetLabel();

    setStatus('Reading conversation…');
    setReplies([]);

    // Try auto-reading first
    let conversation = readConversation();

    // If auto-read failed, check if user pasted manually
    if (!conversation.length) {
      const manualText = panel.querySelector('#ta-manual-input')?.value?.trim();
      if (manualText) {
        conversation = parseManualText(manualText);
      }
    }

    // Still nothing — show manual paste area and stop
    if (!conversation.length) {
      panel.querySelector('#ta-manual-section').style.display = 'block';
      setStatus('⚠️ Could not auto-read this page\'s conversation. Paste the chat messages in the box below, then click Generate again.');
      return;
    }

    setStatus(`Generating replies based on ${conversation.length} messages…`);
    panel.querySelector('#ta-generate-btn').disabled = true;

    try {
      const settings = await getSettings();
      const payload = {
        conversation,
        styleProfile: settings.styleProfile,
        apiKey: settings.apiKey,
        model: settings.model,
      };

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

  function parseManualText(text) {
    // Split pasted text into lines and treat as alternating speakers
    return text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map((text, i) => ({ sender: i % 2 === 0 ? 'Them' : 'You', text }));
  }

  function setStatus(text) {
    if (!panel) return;
    panel.querySelector('#ta-status').innerHTML = text;
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
    const target = lockedInsertTarget || findInputTarget();

    if (!target || !document.contains(target)) {
      setStatus('⚠️ No target set. Click <strong>Pick ✎</strong> and then click the chat input box.');
      return;
    }

    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      // Use native setter so React/Vue state picks it up
      const proto = target.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
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
      // Clear existing content and insert new text
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      // Fallback if execCommand didn't work
      if (!target.textContent.includes(text.slice(0, 20))) {
        target.textContent = text;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }

    setStatus('✅ Inserted! Review and press Send when ready.');
  }

  // ─── Find Input (fallback, excludes our panel) ────────────────────────────

  function findInputTarget() {
    const selectors = [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"].Am.Al.editable',
      '[contenteditable="true"][data-tab]',
      '[contenteditable="true"]',
      'textarea:not([readonly]):not([disabled])',
      'input[type="text"]:not([readonly]):not([disabled])',
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (!isOurElement(el) && isVisible(el)) return el;
      }
    }
    return null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ─── Conversation Reader ──────────────────────────────────────────────────

  // IMPORTANT: every reader must exclude our own panel elements.
  function notOurs(el) {
    return !isOurElement(el);
  }

  function readConversation() {
    const strategies = [
      readFacebookMessenger,
      readGmail,
      readWhatsAppWeb,
      readTuro,
      readGenericChat,
    ];
    // Note: NO generic fallback that reads all divs — that caused the panel-reading bug.

    for (const fn of strategies) {
      try {
        const result = fn();
        if (result && result.length >= 2) return result;
      } catch (_) {}
    }
    return [];
  }

  function readFacebookMessenger() {
    const rows = document.querySelectorAll('[data-testid="messenger-thread-view"] [class*="message"]');
    return extractFromElements([...rows].filter(notOurs), el => el.textContent.trim());
  }

  function readGmail() {
    const messages = document.querySelectorAll('.h7, .gs, [data-message-id]');
    return [...messages].filter(notOurs).map((el, i) => {
      const sender = el.querySelector('.gD')?.getAttribute('email') ||
                     el.querySelector('.go')?.textContent ||
                     (i % 2 === 0 ? 'Them' : 'You');
      const body = el.querySelector('.a3s, .adP')?.textContent?.trim() || el.textContent.trim();
      return { sender, text: body };
    }).filter(m => m.text.length > 0);
  }

  function readWhatsAppWeb() {
    const rows = document.querySelectorAll('[class*="message-in"], [class*="message-out"]');
    return [...rows].filter(notOurs).map(el => {
      const isOut = el.className.includes('message-out');
      const text = el.querySelector('[class*="copyable-text"], span[dir]')?.textContent?.trim() || '';
      return { sender: isOut ? 'You' : 'Them', text };
    }).filter(m => m.text.length > 0);
  }

  function readTuro() {
    const rows = document.querySelectorAll('[class*="chat-message"], [class*="ChatMessage"], [class*="message-bubble"]');
    return extractFromElements([...rows].filter(notOurs), el => el.textContent.trim());
  }

  function readGenericChat() {
    const selectors = [
      '[role="listitem"]',
      '[data-message]',
      '[class*="message-row"]',
      '[class*="msg-row"]',
      '[class*="chat-row"]',
      '[class*="ConversationItem"]',
      '[class*="thread"]',
    ];
    for (const sel of selectors) {
      const els = [...document.querySelectorAll(sel)].filter(notOurs);
      if (els.length >= 2) {
        const results = extractFromElements(els, el => el.textContent.trim());
        if (results.length >= 2) return results;
      }
    }
    return [];
  }

  function extractFromElements(els, getText) {
    return els.map((el, i) => ({
      sender: i % 2 === 0 ? 'Them' : 'You',
      text: getText(el),
    })).filter(m => m.text && m.text.length > 0 && m.text.length < 2000);
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  function getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(['apiKey', 'styleProfile', 'model'], resolve);
    });
  }

  // ─── Trigger Button ───────────────────────────────────────────────────────

  function createTriggerButton() {
    if (document.getElementById('textassist-trigger')) return;
    const btn = document.createElement('button');
    btn.id = 'textassist-trigger';
    btn.title = 'TextAssist — Generate Reply';
    btn.innerHTML = '✦';
    document.body.appendChild(btn);
    btn.addEventListener('click', () => {
      if (!panel) createPanel();
      else expandPanel();
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  createTriggerButton();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'OPEN_PANEL') {
      if (!panel) createPanel();
      else expandPanel();
    }
  });
})();
