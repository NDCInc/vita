const connectTimeout = 4700;
const finalTimeout = 4700;
const modelSampleRate = 24_000;
const maximumQueuedBytes = 512 * 1024;

export async function postDictation(path, contentType, body, signal) {
  const checksum = await crypto.subtle.digest('SHA-256',body);
  const hex = Array.from(new Uint8Array(checksum),byte => byte.toString(16).padStart(2,'0')).join('');
  return fetch(path,{
    method:'POST', body, signal,
    headers:{'Content-Type':contentType,'x-amz-content-sha256':hex},
  });
}

function pcmEncoder(sourceRate) {
  const step = sourceRate / modelSampleRate;
  let weight = 0, sum = 0;
  return samples => {
    const buffer = new Uint8Array(Math.ceil((samples.length + weight) / step) * 2);
    const pcm = new DataView(buffer.buffer);
    let offset = 0;
    // Carry the partial output sample across capture chunks to keep the audio continuous.
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const part = Math.min(step - weight,remaining);
        sum += sample * part;
        weight += part;
        remaining -= part;
        if (weight < step - 1e-8) continue;
        const value = Math.max(-1,Math.min(1,sum / step));
        pcm.setInt16(offset,Math.round(value * (value < 0 ? 32768 : 32767)),true);
        offset += 2;
        weight = sum = 0;
      }
    }
    return btoa(String.fromCharCode(...buffer.subarray(0,offset)));
  };
}

// Send both audio and commit on the ordered channel. Audio captured during setup can be replayed first.
export function startLiveDictation(sampleRate, {onReady,onText,onUnavailable}) {
  if (!window.RTCPeerConnection) {
    onUnavailable();
    return null;
  }
  const peer = new RTCPeerConnection();
  let channel;
  try {
    peer.addTransceiver('audio',{direction:'sendonly'});
    channel = peer.createDataChannel('oai-events');
  } catch {
    peer.close();
    onUnavailable();
    return null;
  }
  const encode = pcmEncoder(sampleRate);
  const request = new AbortController();
  const partial = new Map();
  const completed = new Map();
  let status = 'connecting', sessionReady = false, committedId, finish;
  const startTimer = setTimeout(() => close(),connectTimeout);
  let settleTimer, disconnectTimer;

  function close(result = '') {
    if (status === 'closed') return;
    status = 'closed';
    request.abort();
    clearTimeout(startTimer);
    clearTimeout(settleTimer);
    clearTimeout(disconnectTimer);
    channel.close();
    peer.close();
    if (!result) onUnavailable();
    finish?.(result);
  }

  function ready() {
    if (status !== 'connecting' || !sessionReady || channel.readyState !== 'open') return;
    status = 'recording';
    clearTimeout(startTimer);
    onReady();
  }

  function checkComplete() {
    if (status === 'finishing' && committedId && completed.has(committedId)) {
      close(completed.get(committedId));
    }
  }

  channel.onopen = ready;
  channel.onclose = channel.onerror = () => close();
  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    clearTimeout(disconnectTimer);
    if (state === 'failed') close();
    if (state === 'disconnected') disconnectTimer = setTimeout(() => close(),1300);
  };
  channel.onmessage = ({data}) => {
    if (status === 'closed' || typeof data !== 'string' || data.length > 24_000) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    const {type,item_id:id,session} = event ?? {};
    if (type === 'error' || type === 'conversation.item.input_audio_transcription.failed') { close(); return; }
    if (type === 'session.created' || type === 'session.updated') {
      const model = session?.audio?.input?.transcription?.model;
      if (session?.type !== 'transcription' || (model && !/^gpt-live-transcribe(?:-|$)/u.test(model))) {
        close();
        return;
      }
      sessionReady = true;
      ready();
    }
    if (typeof id !== 'string' || id.length > 160) return;
    if (type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string') {
      if (partial.size >= 4 && !partial.has(id)) { close(); return; }
      const text = ((partial.get(id) ?? '') + event.delta).slice(0,16_000);
      partial.set(id,text);
      if (status === 'recording' || status === 'finishing') onText(text);
    }
    if (type === 'input_audio_buffer.committed' && status === 'finishing') {
      committedId = id;
      checkComplete();
    }
    if (type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') {
      if (completed.size >= 4 && !completed.has(id)) { close(); return; }
      completed.set(id,event.transcript.trim().slice(0,16_000));
      checkComplete();
    }
  };

  async function connect() {
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (status === 'closed') return;
      const offerBytes = new TextEncoder().encode(peer.localDescription.sdp);
      const reply = await postDictation('/api/dictation/live','application/sdp',offerBytes,request.signal);
      if (!reply.ok) { close(); return; }
      const {sdp} = await reply.json();
      if (status === 'closed') return;
      if (typeof sdp !== 'string' || !sdp.startsWith('v=0\r\n')) { close(); return; }
      await peer.setRemoteDescription({type:'answer',sdp});
    } catch { close(); }
  }
  connect();

  return {
    close,
    append(samples) {
      if (status !== 'recording') return false;
      if (channel.bufferedAmount > maximumQueuedBytes) {
        close();
        return false;
      }
      try {
        const audio = encode(samples);
        if (audio) channel.send(JSON.stringify({type:'input_audio_buffer.append',audio}));
        return true;
      } catch {
        close();
        return false;
      }
    },
    commit() {
      if (status !== 'recording' || channel.readyState !== 'open') {
        close();
        return Promise.resolve('');
      }
      status = 'finishing';
      return new Promise(resolve => {
        finish = resolve;
        settleTimer = setTimeout(() => close(),finalTimeout);
        try { channel.send(JSON.stringify({type:'input_audio_buffer.commit'})); }
        catch { close(); }
      });
    },
  };
}

