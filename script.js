'use strict';
/* =====================================================
   NaviAble AI – OCR + Text-to-Speech + Voice Commands
   Sections: 1) Helpers  2) OCR  3) Text-to-Speech  4) Voice commands
   ===================================================== */

/* ---------- 1) Helpers ---------- */
const $ = (id) => document.getElementById(id);

const el = {
  banner: $('banner'), dropzone: $('dropzone'), fileInput: $('fileInput'),
  preview: $('preview'), dropHint: $('dropHint'), ocrLang: $('ocrLang'),
  enhance: $('enhance'), extractBtn: $('extractBtn'), progressWrap: $('progressWrap'),
  progressText: $('progressText'), progressPct: $('progressPct'),
  bar: $('bar'), barFill: $('barFill'), text: $('text'),
  copyBtn: $('copyBtn'), clearBtn: $('clearBtn'),
  readBtn: $('readBtn'), pauseBtn: $('pauseBtn'), resumeBtn: $('resumeBtn'), stopBtn: $('stopBtn'),
  speechLang: $('speechLang'), voiceSelect: $('voiceSelect'),
  rate: $('rate'), rateOut: $('rateOut'),
  micBtn: $('micBtn'), micStatus: $('micStatus'), micLang: $('micLang'),
};

let bannerTimer;
/** Show a message at the top. type = 'error' (default) or 'info'. */
function showBanner(message, type = 'error') {
  el.banner.textContent = message;
  el.banner.className = 'banner' + (type === 'info' ? ' info' : '');
  el.banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.banner.hidden = true), 8000);
}

/* ---------- 2) OCR with Tesseract.js ---------- */
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
let selectedFile = null;

/** Validate and show the chosen image. */
function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    return showBanner('That file is not an image. Please choose a JPG, PNG or WebP picture.');
  }
  if (file.size > MAX_SIZE) {
    return showBanner('That image is larger than 10 MB. Please choose a smaller one.');
  }
  selectedFile = file;
  if (el.preview.src) URL.revokeObjectURL(el.preview.src);
  el.preview.src = URL.createObjectURL(file);
  el.preview.hidden = false;
  el.dropHint.hidden = true;
  el.extractBtn.disabled = false;
}

// Choose via click
el.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
// Keyboard: Enter / Space opens the file picker
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
// Drag and drop
['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('over'); }));
el.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

function setProgress(pct, label) {
  const p = Math.round(pct);
  el.barFill.style.width = p + '%';
  el.bar.setAttribute('aria-valuenow', p);
  el.progressPct.textContent = p + '%';
  if (label) el.progressText.textContent = label;
}

// Friendly names for Tesseract's internal status messages
const STATUS_LABELS = {
  'loading tesseract core': 'Loading OCR engine…',
  'initializing tesseract': 'Starting OCR engine…',
  'loading language traineddata': 'Downloading language data (first time only)…',
  'initializing api': 'Getting ready…',
  'recognizing text': 'Reading the image…',
};

/** Make the image easier for Tesseract: resize, greyscale, stretch contrast,
    and flip light-on-dark text (boards, signs) so it becomes dark-on-light. */
async function preprocessImage(file) {
  const bmp = await createImageBitmap(file);
  // Aim for ~2000 px on the long side: enlarge small images, shrink huge photos.
  const scale = Math.min(3, Math.max(0.4, 2000 / Math.max(bmp.width, bmp.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';                       // transparent PNGs become white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const gray = new Uint8Array(d.length / 4);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    gray[p] = g; hist[g]++; sum += g;
  }
  // Contrast stretch: ignore the darkest and lightest 1% of pixels
  const total = gray.length;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  const invert = sum / total < 110;             // mostly dark picture = light text on dark board
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = Math.min(255, Math.max(0, ((gray[p] - lo) * 255) / range));
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** Fix common OCR mistakes. Tesseract often reads a capital "I" as "|". */
function cleanOCR(text) {
  return text
    .replace(/(^|\s)\|(?=\s+[a-z])/gm, '$1I')                      // lone "| am" -> "I am"
    .replace(/(^|\s)\|(?=[a-z'’])/gm, '$1I')                        // "|t's" -> "It's"
    .replace(/[ \t]*\|[ \t]*$/gm, '')                               // stray cursor line at the end of a line
    .trim();
}

async function runOCR() {
  if (!selectedFile) return showBanner('Please choose an image first.');
  if (typeof Tesseract === 'undefined') {
    return showBanner('The OCR library did not load. Check your internet connection and refresh the page.');
  }

  el.extractBtn.disabled = true;
  el.extractBtn.textContent = 'Reading…';
  el.progressWrap.hidden = false;
  setProgress(0, 'Starting…');

  let worker;
  try {
    // "eng", "hin" or "eng+hin"
    worker = await Tesseract.createWorker(el.ocrLang.value, 1, {
      logger: (m) => setProgress((m.progress || 0) * 100, STATUS_LABELS[m.status] || m.status),
    });
    setProgress(0, 'Preparing image…');
    const input = el.enhance.checked ? await preprocessImage(selectedFile) : selectedFile;
    const { data } = await worker.recognize(input);
    const result = cleanOCR(data.text);

    if (!result) {
      showBanner('No text was found. Try a sharper, well-lit image, or change the language.');
    } else {
      el.text.value = result;
      autoPickSpeechLanguage(result);
      setProgress(100, 'Done');
      showBanner('Text extracted. Press "Read aloud" or say "Read".', 'info');
    }
  } catch (err) {
    console.error(err);
    showBanner('OCR failed. Check your internet connection (language data is downloaded once) and try again.');
  } finally {
    if (worker) await worker.terminate();
    el.extractBtn.disabled = false;
    el.extractBtn.textContent = 'Extract text';
  }
}
el.extractBtn.addEventListener('click', runOCR);

/** If most letters are Devanagari, switch the speech language to Hindi. */
function autoPickSpeechLanguage(text) {
  const hindi = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  setSpeechLanguage(hindi > latin ? 'hi' : 'en');
}

el.copyBtn.addEventListener('click', async () => {
  if (!el.text.value) return showBanner('There is no text to copy.');
  try { await navigator.clipboard.writeText(el.text.value); showBanner('Copied to clipboard.', 'info'); }
  catch { el.text.select(); showBanner('Could not copy automatically. The text is selected, press Ctrl+C.'); }
});
el.clearBtn.addEventListener('click', () => { stopSpeech(); el.text.value = ''; });

/* ---------- 3) Text-to-Speech (SpeechSynthesis) ---------- */
const synth = window.speechSynthesis;
let voices = [];
let runId = 0; // changes every time we start/stop so old callbacks are ignored

if (!synth) {
  showBanner('Your browser does not support text-to-speech. Please use Chrome, Edge or Safari.');
  [el.readBtn, el.pauseBtn, el.resumeBtn, el.stopBtn].forEach((b) => (b.disabled = true));
}

const langPrefix = () => el.speechLang.value; // 'en' or 'hi'
const langTag = () => (langPrefix() === 'hi' ? 'hi-IN' : 'en-IN');

/** Fill the voice list for the chosen language. Voices load asynchronously. */
function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix()));
  el.voiceSelect.innerHTML = '';
  const auto = new Option(matching.length ? 'Automatic' : 'No voice found (browser default)', '');
  el.voiceSelect.add(auto);
  matching.forEach((v) => el.voiceSelect.add(new Option(`${v.name} (${v.lang})`, v.name)));
}
if (synth) {
  loadVoices();
  synth.addEventListener('voiceschanged', loadVoices);
}

function setSpeechLanguage(lang) {
  el.speechLang.value = lang;
  loadVoices();
}
el.speechLang.addEventListener('change', loadVoices);
el.rate.addEventListener('input', () => (el.rateOut.textContent = Number(el.rate.value).toFixed(1) + '×'));

/** Chrome stops long utterances, so we read the text in short chunks. */
function splitText(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?।\n]+[.!?।]*/g) || [text];
  const chunks = [];
  parts.forEach((p) => {
    p = p.trim();
    while (p.length > 70) {            // break long sentences at a space (small pieces = precise resume)
      let cut = p.lastIndexOf(' ', 70);
      if (cut < 25) cut = 70;
      chunks.push(p.slice(0, cut));
      p = p.slice(cut).trim();
    }
    if (p) chunks.push(p);
  });
  return chunks;
}

/** Enable/disable buttons for 'idle', 'speaking' or 'paused'. */
let speechState = 'idle';
function setSpeechState(state) {
  speechState = state;
  el.readBtn.disabled = state !== 'idle';
  el.pauseBtn.disabled = state !== 'speaking';
  el.resumeBtn.disabled = state !== 'paused';
  el.stopBtn.disabled = state === 'idle';
}

let chunks = [];       // the sentences being read
let currentIndex = 0;  // the sentence being spoken right now
let spokenChar = 0;    // how far into that piece the voice has got (from word events)

/** Speak the sentences one by one, starting at startIndex. */
function speakFrom(startIndex) {
  const myRun = ++runId;
  const chosen = voices.find((v) => v.name === el.voiceSelect.value);
  let i = startIndex;

  const speakNext = () => {
    if (myRun !== runId) return;                 // stopped, paused or restarted
    if (i >= chunks.length) return setSpeechState('idle');
    currentIndex = i;
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    u.lang = chosen ? chosen.lang : langTag();
    if (chosen) u.voice = chosen;
    u.rate = Number(el.rate.value);              // speed changes apply to the next sentence
    spokenChar = 0;
    u.onboundary = (e) => { spokenChar = e.charIndex; };  // fires on every word (if the voice supports it)
    u.onend = speakNext;
    u.onerror = (e) => {
      if (myRun !== runId || e.error === 'canceled' || e.error === 'interrupted') return;
      showBanner('Speech failed: ' + e.error);
      setSpeechState('idle');
    };
    synth.speak(u);
  };

  setSpeechState('speaking');
  speakNext();
}

function readAloud() {
  if (!synth) return;
  const text = el.text.value.trim();
  if (!text) return showBanner('There is nothing to read yet. Upload an image or type some text.');

  stopSpeech();
  chunks = splitText(text);
  const hasLangVoice = voices.some((v) => v.lang.toLowerCase().startsWith(langPrefix()));
  if (!hasLangVoice) {
    showBanner(`No ${langPrefix() === 'hi' ? 'Hindi' : 'English'} voice is installed on this device, so it may sound wrong. Install one in your system language settings.`);
  }
  speakFrom(0);
}

/* Pause = stop speaking but remember the sentence. Resume = start again from that sentence.
   (The browser's own pause/resume fails with some voices, e.g. Edge "Natural" voices.) */
function pauseSpeech() {
  if (!synth || speechState !== 'speaking') return;
  runId++;
  synth.cancel();
  if (spokenChar > 0) chunks[currentIndex] = chunks[currentIndex].slice(spokenChar).trimStart();
  setSpeechState('paused');
}
function resumeSpeech() {
  if (!synth || speechState !== 'paused') return;
  speakFrom(currentIndex);
}
function stopSpeech() {
  if (!synth) return;
  runId++;            // invalidates any running sentence loop
  synth.cancel();
  setSpeechState('idle');
}

el.readBtn.addEventListener('click', readAloud);
el.pauseBtn.addEventListener('click', pauseSpeech);
el.resumeBtn.addEventListener('click', resumeSpeech);
el.stopBtn.addEventListener('click', stopSpeech);
setSpeechState('idle');

/* ---------- 4) Voice commands (Web Speech API) ---------- */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

/* Keywords in English, Hindi script and common Hindi-recognizer spellings.
   Hindi text is cleaned (see normalize) so nukta dots do not matter.
   Order matters: the first matching command wins. */
const COMMANDS = [
  { name: 'Pause',   words: ['pause', 'wait', 'पॉज', 'पाउज', 'ठहरो', 'ठहरिए'],            run: pauseSpeech },
  { name: 'Resume',  words: ['resume', 'continue', 'रेज्यूम', 'रिज्यूम', 'जारी', 'आगे'],   run: resumeSpeech },
  { name: 'Stop',    words: ['stop', 'स्टॉप', 'रुको', 'रुकिए', 'बंद', 'बन्द'],             run: stopSpeech },
  { name: 'English', words: ['english', 'इंग्लिश', 'अंग्रेजी'],                            run: () => setSpeechLanguage('en') },
  { name: 'Hindi',   words: ['hindi', 'हिंदी', 'हिन्दी', 'हिंदि'],                         run: () => setSpeechLanguage('hi') },
  { name: 'Read',    words: ['read', 'रीड', 'पढो', 'पढें', 'पढ़ें', 'सुनाओ', 'सुनाइए', 'पढ़ो'], run: readAloud },
];

/** Lowercase, drop punctuation and Hindi nukta marks so matching is forgiving. */
function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/\u093c/g, '').normalize('NFC').replace(/[.,!?।]/g, ' ');
}

function handleCommand(heard) {
  const said = normalize(heard);
  const cmd = COMMANDS.find((c) => c.words.some((w) => said.includes(normalize(w))));
  if (!cmd) {
    el.micStatus.innerHTML = `Heard: “${heard}”. Not a command. Try Read, Pause, Resume, Stop, English or Hindi.`;
    return;
  }
  el.micStatus.innerHTML = `Heard: “${heard}”. Running <b>${cmd.name}</b>.`;
  cmd.run();
  // Highlight the matching chip briefly
  document.querySelectorAll('.chips li').forEach((li) => {
    li.classList.toggle('hit', li.textContent.startsWith(cmd.name));
  });
  setTimeout(() => document.querySelectorAll('.chips li').forEach((li) => li.classList.remove('hit')), 1500);
}

function setMicUI(on) {
  listening = on;
  el.micBtn.classList.toggle('on', on);
  el.micBtn.setAttribute('aria-pressed', on);
  el.micBtn.setAttribute('aria-label', on ? 'Stop voice commands' : 'Start voice commands');
}

let starting = false;

async function startListening() {
  if (!SpeechRecognition) {
    return showBanner('Voice commands are not supported in this browser. Please use Chrome.');
  }
  if (starting) return;
  starting = true;
  el.micStatus.textContent = 'Step 1: checking the microphone…';

  // STEP 1: can the browser open the microphone at all?
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());   // we only wanted to test it
    }
  } catch (err) {
    const reasons = {
      NotAllowedError: 'The microphone is blocked. Allow it for this site (icon left of the address bar) and in Windows Settings > Privacy & security > Microphone.',
      NotFoundError: 'No microphone was found. Plug one in, or enable it in Windows Sound settings.',
      NotReadableError: 'The microphone is busy. Close other apps that use it (Zoom, Teams, Meet) and try again.',
    };
    const msg = (reasons[err.name] || 'Could not open the microphone.') + ' [' + err.name + ']';
    showBanner(msg);
    setMicUI(false);
    el.micStatus.textContent = msg;
    starting = false;
    return;
  }

  // STEP 2: start speech recognition (Chrome sends the audio to Google, so this needs internet)
  el.micStatus.textContent = 'Step 2: starting speech recognition…';
  recognition = new SpeechRecognition();
  recognition.lang = el.micLang.value;
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onstart = () => { el.micStatus.textContent = 'Listening… say a command.'; };
  recognition.onsoundstart = () => { el.micStatus.textContent = 'Hearing sound… keep going.'; };
  recognition.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    handleCommand(last[0].transcript.trim());
  };
  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return; // harmless
    let msg;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      msg = 'Speech recognition is not allowed in this browser.';
    } else if (e.error === 'audio-capture') {
      msg = 'No microphone was found.';
    } else if (e.error === 'network') {
      msg = 'Could not reach the speech service. Chrome needs internet access to Google for this, and some college or office networks block it.';
    } else if (e.error === 'language-not-supported') {
      msg = 'This language is not supported for voice recognition here.';
    } else {
      msg = 'Voice error.';
    }
    msg += ' [' + e.error + ']';
    showBanner(msg);
    stopListening(msg);
  };
  // The browser ends recognition after silence. Restart while the mic is on.
  recognition.onend = () => { if (listening) { try { recognition.start(); } catch {} } };

  try {
    setMicUI(true);
    recognition.start();
  } catch (err) {
    setMicUI(false);
    showBanner('Could not start voice recognition: ' + err.message);
  }
  starting = false;
}

function stopListening(message) {
  setMicUI(false);
  if (recognition) { recognition.onend = null; recognition.stop(); }
  el.micStatus.textContent = message || 'Microphone is off.';
}

el.micBtn.addEventListener('click', () => (listening ? stopListening() : startListening()));
// Changing the listening language restarts the mic with the new language
el.micLang.addEventListener('change', () => { if (listening) { stopListening(); startListening(); } });

if (!SpeechRecognition) {
  el.micStatus.textContent = 'Voice commands need Chrome or Edge.';
}
