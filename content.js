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
  let lockedInsertTarget = null;

  // Track focus so we always know the last input the user touched
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (isOurElement(el)) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.contentEditable === 'true') {
      if (!isSearchInput(el)) lockedInsertTarget = el;
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

        <!-- Status -->
        <div id="ta-status">Click <strong>Generate Replies</strong> to get AI suggestions.</div>

        <!-- Replies -->
        <div id="ta-replies"></div>

        <!-- Manual conversation paste (shown when auto-read fails) -->
        <div id="ta-manual-section" style="display:none">
          <div class="ta-manual-label">Could not auto-read the conversation. Paste it here:</div>
          <textarea id="ta-manual-input" rows="5" placeholder="Paste the chat messages here, then click Generate Replies…"></textarea>
        </div>

        <!-- User draft / intent -->
        <div id="ta-draft-section">
          <div class="ta-draft-label">Your draft <span class="ta-optional">(optional)</span></div>
          <textarea id="ta-draft-input" rows="2" placeholder="e.g. I can't do that job, ask for more details, tell them the price is $200…"></textarea>
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

    // Auto-detect insert target on open (respects any focus that happened before)
    if (!lockedInsertTarget) lockedInsertTarget = findInputTarget();

    bindPanelEvents();
  }

  function bindPanelEvents() {
    panel.querySelector('#ta-header').addEventListener('mousedown', startDrag);
    panel.querySelector('#ta-close').addEventListener('click', closePanel);
    panel.querySelector('#ta-minimize').addEventListener('click', minimizePanel);
    panel.querySelector('#ta-expand').addEventListener('click', expandPanel);
    panel.querySelector('#ta-generate-btn').addEventListener('click', onGenerate);
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

    // Re-detect insert target every time in case focus changed
    lockedInsertTarget = lockedInsertTarget || findInputTarget();

    setStatus('Reading conversation…');
    setReplies([]);

    let conversation = readConversation();

    // If auto-read failed, check manual paste
    if (!conversation.length) {
      const manualText = panel.querySelector('#ta-manual-input')?.value?.trim();
      if (manualText) conversation = parseManualText(manualText);
    }

    // Still nothing — show manual paste area
    if (!conversation.length) {
      panel.querySelector('#ta-manual-section').style.display = 'block';
      setStatus('⚠️ Could not auto-read this conversation. Paste the chat messages in the box below, then click Generate again.');
      return;
    }

    const userDraft = panel.querySelector('#ta-draft-input')?.value?.trim() || '';
    setStatus(`Generating replies based on ${conversation.length} messages…`);
    panel.querySelector('#ta-generate-btn').disabled = true;

    try {
      const settings = await getSettings();
      const payload = { conversation, styleProfile: settings.styleProfile, apiKey: settings.apiKey, model: settings.model, userDraft };

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

      if (response.error) { setStatus(`❌ ${response.error}`); return; }
      if (!response.replies || !response.replies.length) { setStatus('No replies generated. Try again.'); return; }

      setStatus('Click a reply to insert it into the chat box:');
      setReplies(response.replies);
    } catch (err) {
      setStatus(`❌ ${err.message}`);
    } finally {
      panel.querySelector('#ta-generate-btn').disabled = false;
    }
  }

  function parseManualText(text) {
    return text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map((t, i) => ({ sender: i % 2 === 0 ? 'Them' : 'You', text: t }));
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
      setStatus('⚠️ Could not find the chat input. Click inside the message box first, then try again.');
      return;
    }

    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (nativeSetter && nativeSetter.set) nativeSetter.set.call(target, text);
      else target.value = text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
    } else if (target.contentEditable === 'true') {
      target.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      if (!target.textContent.includes(text.slice(0, 20))) {
        target.textContent = text;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }

    setStatus('✅ Inserted! Review and press Send when ready.');
  }

  // ─── Find Insert Target ───────────────────────────────────────────────────

  function isSearchInput(el) {
    const ph = (el.placeholder || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').toLowerCase();
    const name = (el.name || el.id || '').toLowerCase();
    return ph.includes('search') || name.includes('search');
  }

  function findInputTarget() {
    // Priority 1: message-like placeholder text
    const messagePlaceholders = [
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="reply" i]',
      'textarea[placeholder*="write" i]',
      'textarea[placeholder*="type" i]',
      '[contenteditable][data-placeholder*="message" i]',
      '[contenteditable][aria-placeholder*="message" i]',
      '[contenteditable][aria-label*="message" i]',
    ];
    for (const sel of messagePlaceholders) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isOurElement(el) && isVisible(el) && !isSearchInput(el)) return el;
      }
    }

    // Priority 2: role-based contenteditable
    for (const sel of ['[contenteditable="true"][role="textbox"]']) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isOurElement(el) && isVisible(el) && !isSearchInput(el)) return el;
      }
    }

    // Priority 3: any visible textarea that is not a search box
    for (const el of document.querySelectorAll('textarea:not([readonly]):not([disabled])')) {
      if (!isOurElement(el) && isVisible(el) && !isSearchInput(el)) return el;
    }

    // Priority 4: any contenteditable
    for (const el of document.querySelectorAll('[contenteditable="true"]')) {
      if (!isOurElement(el) && isVisible(el) && !isSearchInput(el)) return el;
    }

    return null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isReallyVisible(el) {
    if (!isVisible(el)) return false;
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName?.toLowerCase();
      if (['script', 'style', 'pre', 'code', 'noscript', 'template'].includes(tag)) return false;
      node = node.parentElement;
    }
    try {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    } catch (_) {}
    return true;
  }

  // Returns true if a string looks like a real chat message (not code, not UI labels)
  function looksLikeMessage(text) {
    if (!text || text.length < 10 || text.length > 2000) return false;
    if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(text)) return false; // pure timestamp
    // Must have at least 2 words — filters out single-word nav labels like "Pipeline", "Payroll"
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length < 2) return false;
    // Reject concatenated nav text like "HomeInbox99+ScheduleCustomersMy moneyPayroll..."
    // Real sentences have roughly 1 space per 6–8 chars; nav dumps have almost none.
    const spaceCount = (text.match(/ /g) || []).length;
    if (text.length > 25 && spaceCount / text.length < 0.04) return false;
    // Reject code-like strings
    const codeSignals = ['{', '}', '=>', 'function(', 'const ', 'var ', 'let ', 'import ', 'export ', '();', '===', '!==', '/*', '*/', 'getElementById', 'querySelector'];
    if (codeSignals.filter(s => text.includes(s)).length >= 2) return false;
    // Require mostly alphabetic characters
    const alphaRatio = (text.match(/[a-zA-Z ]/g) || []).length / text.length;
    return alphaRatio >= 0.4;
  }

  // ─── Conversation Reader ──────────────────────────────────────────────────
  //
  // Position-based approach: forget DOM structure entirely.
  // Find every visible text element whose CENTER X falls inside the chat
  // pane (bounded by the pane's left edge and the textarea's right edge)
  // and is above the textarea. Sort by vertical position → the conversation.
  //
  // Key insight: the textarea is narrower than the chat pane — messages
  // span the full pane width, so we walk UP from the textarea to find the
  // pane's actual left edge rather than using inputRect.left directly.

  // Walk up from the input to find the chat pane's left boundary.
  // The pane is the first ancestor that extends >150px further left than the input.
  function getChatPaneLeft(inputEl) {
    const inputLeft = inputEl.getBoundingClientRect().left;
    let node = inputEl.parentElement;
    for (let i = 0; i < 15; i++) {
      if (!node || node === document.body) break;
      const r = node.getBoundingClientRect();
      if (inputLeft - r.left > 150) return r.left;
      node = node.parentElement;
    }
    return inputLeft - 500;
  }

  function readConversation() {
    const inputEl = findInputTarget();
    if (!inputEl) return [];

    const inputRect = inputEl.getBoundingClientRect();
    const inputCenterX = (inputRect.left + inputRect.right) / 2;
    const paneLeft = getChatPaneLeft(inputEl);
    console.log('[TA] readConversation: inputRect=', Math.round(inputRect.left), Math.round(inputRect.top), 'paneLeft=', Math.round(paneLeft));

    const seen = new Set();
    const found = [];

    // Walk the full element tree including shadow DOM roots (Thumbtack renders
    // its chat in web components with shadow roots, invisible to normal querySelectorAll).
    function* walkAll(root) {
      for (const el of root.querySelectorAll('*')) {
        yield el;
        if (el.shadowRoot) yield* walkAll(el.shadowRoot);
      }
    }

    const SKIP_TAGS = new Set(['SCRIPT','STYLE','HEAD','META','LINK','SVG','PATH','G','DEFS','NOSCRIPT','IFRAME','CANVAS','VIDEO','AUDIO','IMG','INPUT','TEXTAREA','SELECT','BUTTON','OPTION']);
    let dbgTotal = 0, dbgMsg = 0, dbgRect = 0, dbgAbove = 0, dbgHdr = 0, dbgX = 0;
    for (const el of walkAll(document)) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (isOurElement(el)) continue;
      if (el === inputEl || el.contains(inputEl) || inputEl.contains(el)) continue;
      dbgTotal++;

      const text = el.textContent.trim();
      if (!looksLikeMessage(text)) continue;
      if (seen.has(text)) continue;
      dbgMsg++;

      // Skip wrapper elements: if a direct child carries the exact same text,
      // this node is just a container — the child will be picked up instead.
      if ([...el.children].some(c => c.textContent.trim() === text)) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 4) { dbgRect++; continue; }

      // Must be above the input
      if (r.bottom > inputRect.top + 10) { dbgAbove++; continue; }

      // Skip page-header elements pinned near the top of the viewport
      if (r.top < 50) { dbgHdr++; continue; }

      // The element's center X must fall within the chat pane.
      // paneLeft is the left edge of the panel that contains the textarea;
      // sidebar / thread-list elements are further left and get excluded.
      const elCenterX = r.left + r.width / 2;
      if (elCenterX < paneLeft || elCenterX > inputRect.right + 80) {
        dbgX++;
        console.log('[TA] X-filtered:', el.tagName, el.className.substring(0,40), 'cx='+Math.round(elCenterX), 'text='+text.substring(0,40));
        continue;
      }

      seen.add(text);
      found.push({ el, text, top: r.top, bottom: r.bottom, height: r.height });
    }
    console.log('[TA] scan done: total='+dbgTotal+' passedMsg='+dbgMsg+' rect='+dbgRect+' below='+dbgAbove+' hdr='+dbgHdr+' x='+dbgX+' found='+found.length);

    if (found.length === 0) return [];

    // Sort top-to-bottom = chronological
    found.sort((a, b) => a.top - b.top);

    // Remove vertical duplicates (in case a wrapper snuck through)
    const messages = [];
    for (const m of found) {
      const overlaps = messages.some(d => {
        const overlapPx = Math.min(m.bottom, d.bottom) - Math.max(m.top, d.top);
        return overlapPx > Math.min(m.height, d.height) * 0.5;
      });
      if (!overlaps) messages.push(m);
    }

    return messages.map(({ el, text }) => ({
      sender: determineSender(el, inputCenterX),
      text,
    }));
  }

  // Determine whether a message element was sent by "You" or "Them"
  function determineSender(el, midX) {
    // 1. Class-name keywords (most reliable when present)
    const allClasses = collectClassNames(el);
    if (/\b(sent|outgoing|outbound|message-out|msg-out|self|mine|owner)\b/.test(allClasses)) return 'You';
    if (/\b(received|incoming|inbound|message-in|msg-in|other|theirs|remote)\b/.test(allClasses)) return 'Them';

    // 2. CSS on the element itself
    try {
      const s = window.getComputedStyle(el);
      if (s.alignSelf === 'flex-end' || s.justifySelf === 'flex-end') return 'You';
      if (s.textAlign === 'right') return 'You';
      if (s.marginLeft === 'auto' && s.marginRight !== 'auto') return 'You';
    } catch (_) {}

    // 3. CSS on immediate children (message bubble is often nested one level)
    for (const child of el.children) {
      try {
        const cs = window.getComputedStyle(child);
        if (cs.alignSelf === 'flex-end' || cs.marginLeft === 'auto') return 'You';
      } catch (_) {}
    }

    // 4. X position — if the element sits in the right half of the container
    const r = el.getBoundingClientRect();
    const elMid = r.left + r.width / 2;
    if (elMid > midX + 20) return 'You'; // clear right-side bias

    return 'Them';
  }

  // Collect all class names from an element and its descendants (space-separated, lowercase)
  function collectClassNames(el) {
    const parts = [el.className || ''];
    for (const child of el.querySelectorAll('[class]')) {
      parts.push(child.className || '');
    }
    return parts.join(' ').toLowerCase();
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
