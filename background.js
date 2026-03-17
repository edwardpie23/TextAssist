// Background service worker — handles Grok (xAI) API calls so the API key
// never touches page content scripts.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_REPLIES') {
    handleGenerateReplies(message.payload).then(sendResponse).catch(err => {
      sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
  }
});

async function handleGenerateReplies({ conversation, styleProfile, apiKey, model }) {
  if (!apiKey) {
    throw new Error('No API key set. Open the TextAssist popup to add your Grok API key.');
  }

  const systemPrompt = buildSystemPrompt(styleProfile);
  const userPrompt = buildUserPrompt(conversation);

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'grok-2-1212',
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
    throw new Error(err.error?.message || `Grok API error ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || '';
  return { replies: parseReplies(raw) };
}

function buildSystemPrompt(styleProfile) {
  const baseInstructions = `You are a reply assistant. Generate exactly 3 distinct reply options for the conversation below.

Format your response EXACTLY like this — nothing else:
REPLY_1: <reply text>
REPLY_2: <reply text>
REPLY_3: <reply text>

Rules:
- Keep each reply concise and natural
- Do NOT number within the reply text
- Do NOT add explanations or labels after the replies
- Vary the tone slightly across the 3 options (e.g., brief, friendly, more detailed)`;

  if (styleProfile && styleProfile.trim()) {
    return `${baseInstructions}\n\nUser's personal communication style (match this closely):\n${styleProfile}`;
  }
  return baseInstructions;
}

function buildUserPrompt(conversation) {
  const lines = conversation
    .slice(-12) // last 12 messages for context
    .map(m => `${m.sender}: ${m.text}`)
    .join('\n');

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
