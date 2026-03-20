// Background service worker — handles Groq API calls so the API key
// never touches page content scripts.

let voiceTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLIES') {
    handleGenerateReplies(message.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
  }

  if (message.type === 'VOICE_START') {
    voiceTabId = sender.tab ? sender.tab.id : voiceTabId;
    ensureOffscreen().then(() => {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'VOICE_START' });
    }).catch(err => {
      if (voiceTabId) chrome.tabs.sendMessage(voiceTabId, { type: 'VOICE_ERROR', error: err.message });
    });
    return;
  }

  if (message.type === 'VOICE_STOP') {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'VOICE_STOP' });
    return;
  }

  // Relay results from offscreen doc → content script
  if (['VOICE_STARTED', 'VOICE_RESULT', 'VOICE_ENDED', 'VOICE_ERROR'].includes(message.type)) {
    if (voiceTabId) chrome.tabs.sendMessage(voiceTabId, message);
    return;
  }
});

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Speech recognition for voice-to-instruction feature',
  });
}

async function handleGenerateReplies({ conversation, styleProfile, apiKey, model, userDraft }) {
  if (!apiKey) {
    throw new Error('No API key set. Open the TextAssist popup to add your Groq API key.');
  }

  const systemPrompt = buildSystemPrompt(styleProfile);
  const userPrompt = buildUserPrompt(conversation, userDraft);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API error ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || '';
  return { replies: parseReplies(raw) };
}

function buildSystemPrompt(styleProfile) {
  const baseInstructions = `You are a reply assistant for a service business owner. Generate exactly 3 distinct reply options for the conversation below.

Format your response EXACTLY like this — nothing else:
REPLY_1: <reply text>
REPLY_2: <reply text>
REPLY_3: <reply text>

Rules:
- Always write in a professional yet friendly, natural tone — confident and warm, never stiff or overly formal
- Sound like a real person, not a corporate script
- Keep each reply concise and to the point
- Do NOT number within the reply text
- Do NOT add explanations or labels after the replies
- Vary the replies slightly (e.g., one brief, one with a bit more detail, one that asks a follow-up)`;

  if (styleProfile && styleProfile.trim()) {
    return `${baseInstructions}\n\nUser's personal communication style (match this closely):\n${styleProfile}`;
  }
  return baseInstructions;
}

function buildUserPrompt(conversation, userDraft) {
  const lines = conversation
    .slice(-12)
    .map(m => `${m.sender}: ${m.text}`)
    .join('\n');

  if (userDraft && userDraft.trim()) {
    return `Conversation:\n${lines}\n\nInstruction: ${userDraft.trim()}\n\nUsing the conversation above for context, follow the instruction to generate 3 reply options. For example, if the instruction says "confirm the job and provide pricing", confirm the specific job discussed in the conversation and suggest realistic pricing for it.`;
  }

  return `Conversation:\n${lines}\n\nGenerate 3 reply options for the last message above.`;
}

function parseReplies(raw) {
  const replies = [];
  const regex = /REPLY_\d+:\s*(.+)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const text = match[1].trim();
    if (text) replies.push(text);
  }

  // Fallback: split by newlines if regex found nothing
  if (replies.length === 0) {
    raw.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 10)
      .slice(0, 3)
      .forEach(l => replies.push(l));
  }

  return replies.slice(0, 3);
}
