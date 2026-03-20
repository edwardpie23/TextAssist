// Offscreen document — runs webkitSpeechRecognition on behalf of the extension.
// Receives START/STOP commands from the background; sends results back.

let recognition = null;
let finalTranscript = '';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'VOICE_START') startRecognition();
  if (msg.type === 'VOICE_STOP') stopRecognition();
});

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    chrome.runtime.sendMessage({ type: 'VOICE_ERROR', error: 'not-supported' });
    return;
  }

  finalTranscript = '';
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    chrome.runtime.sendMessage({ type: 'VOICE_STARTED' });
  };

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + ' ';
      }
    }
    const lastResult = event.results[event.results.length - 1];
    const interim = lastResult.isFinal ? '' : lastResult[0].transcript;
    chrome.runtime.sendMessage({
      type: 'VOICE_RESULT',
      transcript: (finalTranscript + interim).trim(),
    });
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed') {
      chrome.runtime.sendMessage({ type: 'VOICE_ERROR', error: 'not-allowed' });
    }
    // ignore no-speech in continuous mode
  };

  recognition.onend = () => {
    chrome.runtime.sendMessage({ type: 'VOICE_ENDED', transcript: finalTranscript.trim() });
  };

  try {
    recognition.start();
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'VOICE_ERROR', error: e.message });
  }
}

function stopRecognition() {
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
}
