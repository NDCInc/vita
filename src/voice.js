import captureUrl from './voice-capture.js?url&no-inline';
import {postDictation,startLiveDictation} from './live-dictation.js';

const Audio = window.AudioContext || window.webkitAudioContext;
const OfflineAudio = window.OfflineAudioContext || window.webkitOfflineAudioContext;
const maxSeconds = 120;
const sampleRate = 16_000;
let current;
let retryable;

function stopTracks(stream) {
  for (const track of stream?.getTracks() ?? []) {
    track.onended = track.onmute = track.onunmute = null;
    track.stop();
  }
}

function releaseMic(job) {
  clearTimeout(job.permissionTimer);
  clearTimeout(job.interrupt);
  clearInterval(job.clock);
  job.flush?.();
  if (job.node?.port) job.node.port.onmessage = null;
  else if (job.node) job.node.onaudioprocess = null;
  job.node?.disconnect();
  job.source?.disconnect();
  job.sink?.disconnect();
  stopTracks(job.stream);
  if (job.context && job.context.state !== 'closed') job.context.close().catch(() => {});
  job.stream = job.node = job.source = job.sink = job.context = null;
}

function available(ui) {
  return ui.root.isConnected && !ui.root.closest('[hidden], details:not([open])');
}

function present(ui, phase, message = '') {
  const listening = phase === 'recording';
  const busy = phase !== 'idle';
  ui.root.dataset.phase = phase;
  ui.label.textContent = listening ? 'Use recording' : 'Dictate';
  ui.mic.setAttribute('aria-disabled', String(busy && !listening));
  ui.memo.hidden = busy;
  ui.cancel.hidden = !busy;
  ui.meter.hidden = !listening;
  ui.clock.hidden = !listening;
  ui.undo.hidden = busy || !ui.lastInsert;
  if (ui.status.textContent !== message) ui.status.textContent = message;
}

function finishSession(job, message = '') {
  if (current !== job) return;
  current = null;
  job.observer.disconnect();
  job.live?.close();
  job.live = null;
  releaseMic(job);
  job.parts = [];
  job.ui.caption.hidden = true;
  job.ui.caption.textContent = '';
  present(job.ui, 'idle', message);
}

function cancel(job, focus = false) {
  if (current !== job) return;
  job.request?.abort();
  finishSession(job);
  job.samples = null;
  if (focus && available(job.ui)) job.ui.mic.focus({preventScroll:true});
}

function microphoneError(error) {
  if (['NotAllowedError','SecurityError'].includes(error?.name)) return 'Microphone access is off. Allow it in your browser or use a voice memo.';
  if (['NotFoundError','DevicesNotFoundError'].includes(error?.name)) return 'No microphone found. Connect one or use a voice memo.';
  if (['NotReadableError','AbortError'].includes(error?.name)) return 'The microphone is busy or disconnected. Try again or use a voice memo.';
  return 'The microphone could not start. Try again or use a voice memo.';
}

function fail(job, message, retry = false) {
  if (current !== job) return;
  job.request?.abort();
  finishSession(job, message);
  if (retry) {
    retryable = job;
    job.ui.retry.hidden = false;
    job.retryTimer = setTimeout(() => { if (retryable === job) clearRetry(); },120_000);
  } else {
    job.samples = null;
  }
}

function clearRetry(keepSamples = false) {
  if (retryable) {
    retryable.ui.retry.hidden = true;
    clearTimeout(retryable.retryTimer);
    if (!keepSamples) retryable.samples = null;
  }
  retryable = null;
}

function prepare(ui, previous) {
  if (current && !available(current.ui)) cancel(current);
  if (current) {
    current.ui.status.textContent = 'Finish or cancel this recording first.';
    current.ui.mic.focus({preventScroll:true});
    return null;
  }
  clearRetry(Boolean(previous));
  ui.recovery.hidden = true;
  ui.words.value = '';
  const length = ui.field.value.length;
  const job = previous ?? {
    ui, before:ui.field.value,
    start:ui.touched ? ui.field.selectionStart : length,
    end:ui.touched ? ui.field.selectionEnd : length,
  };
  current = job;
  job.parts = [];
  job.count = 0;
  job.primaryReady = false;
  job.observer = new MutationObserver(() => { if (!available(ui)) cancel(job); });
  job.observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['hidden','open']});
  return job;
}

function drawWave(ui, level = 0) {
  const canvas = ui.meter;
  const context = canvas.getContext('2d');
  if (!context) return;
  ui.wave.shift();
  ui.wave.push(level);
  const {width,height} = canvas;
  context.clearRect(0,0,width,height);
  context.fillStyle = ui.waveInk;
  const step = width / ui.wave.length;
  ui.wave.forEach((power,index) => {
    const barHeight = Math.min(height - 2, 3 + Math.sqrt(power) * height * 1.9);
    context.fillRect(index * step + 1, (height - barHeight) / 2, step - 2, barHeight);
  });
}

function accept(job, data) {
  if (current !== job || !['recording','finishing'].includes(job.phase) || !(data instanceof Float32Array)) return;
  const limit = job.context.sampleRate * maxSeconds;
  const part = data.subarray(0,limit - job.count);
  if (!part.length) return;
  job.parts.push(part);
  job.count += part.length;
  if (job.primaryReady) job.live?.append(part);
  let power = 0;
  for (let i = 0; i < part.length; i += 8) power += part[i] * part[i];
  drawWave(job.ui,Math.sqrt(power / Math.ceil(part.length / 8)));
  if (job.count >= limit) finishRecording(job);
}

async function record(ui) {
  if (!Audio || !OfflineAudio || !navigator.mediaDevices?.getUserMedia) {
    present(ui,'idle','Microphone dictation is unavailable in this browser. Use a voice memo or keyboard dictation.');
    return;
  }
  const job = prepare(ui);
  if (!job) return;
  present(ui,'permission','Waiting for microphone permission…');
  job.phase = 'permission';
  job.permissionTimer = setTimeout(() => fail(job,'Microphone permission is still pending. Try again or use a voice memo.'),25_000);
  try {
    const context = new Audio();
    job.context = context;
    // Resume during the click so iPhone and iPad can start the microphone graph.
    const wake = context.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    if (current !== job) { stopTracks(stream); return; }
    job.stream = stream;
    await wake;
    if (current !== job) return;
    job.source = context.createMediaStreamSource(stream);
    job.sink = context.createGain();
    job.sink.gain.value = 0;
    job.sink.connect(context.destination);
    if (context.audioWorklet) {
      try {
        await context.audioWorklet.addModule(captureUrl);
        if (current !== job) return;
        job.node = new AudioWorkletNode(context,'vita-microphone');
        job.node.port.onmessage = ({data}) => data === 'flushed' ? job.flush?.() : accept(job,data);
      } catch { if (current !== job) return; }
    }
    if (!job.node) {
      job.node = context.createScriptProcessor(4096,1,1);
      job.node.onaudioprocess = event => accept(job,event.inputBuffer.getChannelData(0).slice());
    }
    if (document.hidden || !available(ui)) { cancel(job); return; }
    clearTimeout(job.permissionTimer);
    for (const track of stream.getAudioTracks()) {
      track.onended = () => finishRecording(job);
      track.onmute = () => { clearTimeout(job.interrupt); job.interrupt = setTimeout(() => finishRecording(job),1800); };
      track.onunmute = () => clearTimeout(job.interrupt);
    }
    const started = performance.now();
    ui.wave.fill(0);
    ui.waveInk = getComputedStyle(ui.meter).color;
    ui.clock.textContent = '0:00';
    job.phase = 'recording';
    present(ui,'recording','Getting ready…');
    drawWave(ui);
    job.source.connect(job.node);
    job.node.connect(job.sink);
    connectLive(job);
    job.clock = setInterval(() => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      ui.clock.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2,'0');
      if (seconds >= maxSeconds) finishRecording(job);
    },250);
  } catch (error) { fail(job,microphoneError(error)); }
}

function connectLive(job) {
  const {ui} = job;
  function showListening() {
    if (current === job && job.phase === 'recording') present(ui,'recording','Listening…');
  }
  function unavailable() {
    if (current !== job) return;
    job.primaryReady = false;
    ui.caption.hidden = true;
    ui.caption.textContent = '';
    showListening();
  }
  try {
    job.live = startLiveDictation(job.context.sampleRate,{
      onReady() {
        if (current !== job || job.phase !== 'recording') { job.live?.close(); return; }
        job.primaryReady = true;
        for (const part of job.parts) if (!job.live.append(part)) break;
        showListening();
      },
      onText(text) {
        if (current !== job || !job.primaryReady) return;
        ui.caption.textContent = text;
        ui.caption.hidden = !text.trim();
        ui.caption.scrollTop = ui.caption.scrollHeight;
      },
      onUnavailable:unavailable,
    });
  } catch { unavailable(); }
}

async function resample(buffer) {
  const frames = Math.min(buffer.length, Math.round(maxSeconds * buffer.sampleRate));
  const offline = new OfflineAudio(1,Math.max(1,Math.round(frames * sampleRate / buffer.sampleRate)),sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0,0,frames / buffer.sampleRate);
  const output = await offline.startRendering();
  return output.getChannelData(0).slice();
}

async function finishRecording(job) {
  if (current !== job || job.phase !== 'recording') return;
  job.phase = 'finishing';
  clearInterval(job.clock);
  present(job.ui,'working','Finishing your recording…');
  try {
    if (job.node?.port) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve,200);
        job.flush = () => { clearTimeout(timer); resolve(); };
        job.node.port.postMessage('flush');
      });
    }
    if (current !== job) return;
    const frames = Math.min(job.count,job.context.sampleRate * maxSeconds);
    if (!frames) { fail(job,'No audio reached Vita. Check the microphone and try again.'); return; }
    const audio = job.context.createBuffer(1,frames,job.context.sampleRate);
    const target = audio.getChannelData(0);
    let offset = 0;
    for (const part of job.parts) {
      const keep = part.subarray(0,frames - offset);
      target.set(keep,offset);
      offset += keep.length;
      if (offset === frames) break;
    }
    job.parts = [];
    releaseMic(job);
    job.samples = await resample(audio);
    if (current !== job) return;
    if (job.primaryReady && heardSpeech(job.samples)) {
      present(job.ui,'working','Turning speech into text…');
      const text = await job.live?.commit();
      if (current !== job) return;
      if (text) { insert(job,text); return; }
    }
    job.live?.close();
    transcribe(job);
  } catch { fail(job,'Could not prepare the recording. Try again or use a voice memo.'); }
}

async function readMemo(ui, file) {
  if (!file) return;
  if (file.size > 30 * 1024 * 1024 || !file.size) { present(ui,'idle','Choose a recording under 30 MB that contains speech.'); return; }
  if (!Audio || !OfflineAudio) { present(ui,'idle','This browser could not open audio. Try keyboard dictation.'); return; }
  const job = prepare(ui);
  if (!job) return;
  present(ui,'working','Opening voice memo…');
  let context;
  try {
    context = new Audio();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (current !== job) return;
    if (decoded.duration > maxSeconds + .1) { fail(job,'Choose a recording of two minutes or less.'); return; }
    job.samples = await resample(decoded);
    transcribe(job);
  } catch { fail(job,'This recording could not be opened. Try a WAV, MP3 or M4A file.'); }
  finally { if (context?.state !== 'closed') await context?.close().catch(() => {}); }
}

function heardSpeech(samples) {
  // Background noise and a click are poor evidence of speech.
  if (samples.length < sampleRate / 2) return false;
  let voiced = 0;
  for (let i = 0; i + 320 <= samples.length; i += 320) {
    let power = 0;
    for (let j = i; j < i + 320; j++) power += samples[j] * samples[j];
    if (power / 320 > .0000025 && ++voiced >= 6) return true;
  }
  return false;
}

function makeWav(samples) {
  const size = samples.length * 2;
  const buffer = new ArrayBuffer(44 + size);
  const bytes = new DataView(buffer);
  bytes.setUint32(0,0x52494646); // RIFF
  bytes.setUint32(4,36 + size,true);
  bytes.setUint32(8,0x57415645); // WAVE
  bytes.setUint32(12,0x666d7420); // fmt
  bytes.setUint32(16,16,true);
  bytes.setUint16(20,1,true); // Linear PCM
  bytes.setUint16(22,1,true);
  bytes.setUint32(24,sampleRate,true);
  bytes.setUint32(28,sampleRate * 2,true);
  bytes.setUint16(32,2,true);
  bytes.setUint16(34,16,true);
  bytes.setUint32(36,0x64617461); // data
  bytes.setUint32(40,size,true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1,Math.min(1,samples[i]));
    bytes.setInt16(44 + i * 2,Math.round(sample * (sample < 0 ? 32768 : 32767)),true);
  }
  return buffer;
}

async function transcribe(job) {
  if (current !== job) return;
  if (!heardSpeech(job.samples)) { fail(job,'No clear speech was heard. Try again closer to the microphone.'); return; }
  present(job.ui,'working','Turning speech into text…');
  const request = new AbortController();
  job.request = request;
  const deadline = setTimeout(() => request.abort(),32_000);
  try {
    const result = await postDictation('/api/dictation','audio/wav',makeWav(job.samples),request.signal);
    const payload = await result.json().catch(() => ({}));
    if (current !== job) return;
    if (result.ok && typeof payload.text === 'string' && payload.text.trim()) {
      insert(job,payload.text.trim());
    } else if (result.status === 429 && payload.code === 'voice_allowance') {
      fail(job,'Dictation has reached its monthly limit. You can still edit by typing.');
    } else if (payload.code === 'no_speech' || payload.code === 'recording') {
      fail(job,'No clear speech was heard. Try a clearer recording.');
    } else {
      fail(job,'Dictation is temporarily unavailable. Try again.',true);
    }
  } catch {
    fail(job,'Dictation could not finish. Check your connection and retry.',true);
  } finally { clearTimeout(deadline); }
}

function insert(job, text) {
  const {ui} = job;
  job.samples = null;
  if (!available(ui)) { cancel(job); return; }
  const field = ui.field;
  const oldValue = field.value;
  const start = oldValue === job.before ? job.start : oldValue.length;
  const end = oldValue === job.before ? job.end : start;
  const left = oldValue.slice(0,start);
  const right = oldValue.slice(end);
  const prefix = left && !/\s$/u.test(left) && !/^[,.;:!?)]/u.test(text) ? ' ' : '';
  const suffix = right && !/^[\s,.;:!?)]/u.test(right) ? ' ' : '';
  const added = prefix + text + suffix;
  const value = left + added + right;
  if (field.maxLength < 0 || value.length <= field.maxLength) {
    field.value = value;
    field.dispatchEvent(new Event('input',{bubbles:true}));
    if (field.value === value) {
      field.setSelectionRange(left.length + added.length,left.length + added.length);
      finishSession(job,'Added to this field.');
      ui.lastInsert = {oldValue, value, start, end};
      ui.undo.hidden = false;
      return;
    }
  }
  finishSession(job,'The text limit was reached. You can copy your words below.');
  ui.words.value = text;
  ui.recovery.hidden = false;
}

function mount(field, root) {
  const get = name => root.querySelector('[data-voice-' + name + ']');
  const ui = {root,field,mic:get('mic'),label:get('label'),memo:get('memo'),file:get('file'),cancel:get('cancel'),meter:get('meter'),clock:get('clock'),status:get('status'),caption:get('caption'),retry:get('retry'),undo:get('undo'),recovery:get('recovery'),words:get('words'),wave:new Array(27).fill(0)};
  field.addEventListener('focus',() => { ui.touched = true; });
  field.addEventListener('input',() => {
    if (!ui.lastInsert) return;
    ui.lastInsert = null;
    ui.undo.hidden = true;
    if (ui.status.textContent === 'Added to this field.') ui.status.textContent = '';
  });
  ui.mic.addEventListener('click',() => {
    if (current?.ui === ui) {
      if (current.phase === 'recording') finishRecording(current);
    } else record(ui);
  });
  ui.memo.addEventListener('click',() => { if (!current) ui.file.click(); });
  ui.file.addEventListener('change',() => {
    const file = ui.file.files[0];
    ui.file.value = '';
    if (!current) readMemo(ui,file);
  });
  ui.cancel.addEventListener('click',() => { if (current?.ui === ui) cancel(current,true); });
  root.addEventListener('keydown',event => {
    if (event.key !== 'Escape' || current?.ui !== ui) return;
    event.preventDefault();
    cancel(current,true);
  });
  ui.retry.addEventListener('click',() => {
    if (retryable?.ui === ui) {
      const job = prepare(ui,retryable);
      if (job) transcribe(job);
    }
  });
  ui.undo.addEventListener('click',() => {
    const snapshot = ui.lastInsert;
    if (!snapshot || current?.ui === ui) return;
    if (field.value !== snapshot.value) {
      ui.lastInsert = null;
      ui.undo.hidden = true;
      return;
    }
    field.value = snapshot.oldValue;
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.setSelectionRange(snapshot.start,snapshot.end);
    ui.mic.focus({preventScroll:true});
    ui.status.textContent = 'Dictation undone.';
  });
}

export function attachDictation(root) {
  const template = document.querySelector('#voice-controls');
  for (const field of root.querySelectorAll('textarea:not([data-voice-words])')) {
    if (field.dataset.voiceReady) continue;
    field.dataset.voiceReady = 'true';
    const controls = template.content.firstElementChild.cloneNode(true);
    const label = field.closest('label');
    const wrapper = document.createElement('div');
    wrapper.className = 'voice-field';
    if (label?.classList.contains('full')) wrapper.classList.add('full');
    if (label?.id === 'guide-followup') wrapper.dataset.guideVoice = '';
    const anchor = label || field;
    anchor.before(wrapper);
    wrapper.append(anchor,controls);
    mount(field,controls);
  }
}

export function cancelDictation() {
  if (current) cancel(current);
  clearRetry();
}

document.addEventListener('visibilitychange',() => {
  if (document.hidden && current?.phase === 'recording') finishRecording(current);
});
window.addEventListener('pagehide',cancelDictation);
