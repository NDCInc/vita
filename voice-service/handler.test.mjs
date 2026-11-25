import assert from 'node:assert/strict';
import test from 'node:test';
import {createVoiceHandler} from './handler.mjs';
import {createLiveTranscribe} from './live.mjs';

const origin = 'https://vita.example.test';

function recording(seconds = 1) {
  const size = 32_000 * seconds;
  const audio = Buffer.alloc(44 + size);
  audio.write('RIFF',0);
  audio.writeUInt32LE(36 + size,4);
  audio.write('WAVEfmt ',8);
  audio.writeUInt32LE(16,16);
  audio.writeUInt16LE(1,20);
  audio.writeUInt16LE(1,22);
  audio.writeUInt32LE(16_000,24);
  audio.writeUInt32LE(32_000,28);
  audio.writeUInt16LE(2,32);
  audio.writeUInt16LE(16,34);
  audio.write('data',36);
  audio.writeUInt32LE(size,40);
  return audio;
}

function event(audio = recording()) {
  return {rawPath:'/api/dictation', requestContext:{http:{method:'POST'}},
    headers:{origin,'content-type':'audio/wav'},isBase64Encoded:true,body:audio.toString('base64')};
}

function server(overrides = {}) {
  return createVoiceHandler({origin,table:'test',limit:300,...overrides});
}

test('valid audio reserves rounded seconds before the one transcription call', async () => {
  const calls = [];
  const handler = server({reserve:async s => { calls.push(s); return true; },read:async audio => {
    calls.push(audio.length);
    return 'I checked financial reports.';
  }});
  const result = await handler(event(recording(2.5)));
  assert.equal(result.statusCode,200);
  assert.equal(result.headers['cache-control'],'no-store');
  assert.deepEqual(JSON.parse(result.body),{text:'I checked financial reports.'});
  assert.deepEqual(calls,[3,80044]);
});

test('a full allowance and a missing configuration prevent a provider call', async () => {
  const shouldNotRun = () => assert.fail('provider was called');
  const handler = server({reserve:async () => false,read:shouldNotRun});
  const result = await handler(event());
  assert.equal(result.statusCode,429);
  assert.deepEqual(JSON.parse(result.body),{code:'voice_allowance'});
  const unconfigured = server({limit:NaN,reserve:shouldNotRun,read:shouldNotRun});
  assert.equal((await unconfigured(event())).statusCode,503);
});

test('rejects wrong origins, methods, formats and recording lengths before reservation', async () => {
  const unused = () => assert.fail('invalid requests are free');
  const handler = server({reserve:unused,read:unused});
  const untrusted = event(); untrusted.headers.origin = 'https://elsewhere.example.test';
  const get = event(); get.requestContext.http.method = 'GET';
  const wrong = event(); wrong.headers['content-type'] = 'application/json';
  const badHeader = recording(); badHeader.writeUInt16LE(2,22);
  for (const [request,status] of [[untrusted,403],[get,405],[wrong,415],[event(recording(.49)),422],[event(recording(121)),422],[event(badHeader),422],[event(Buffer.from('short')),422]]) {
    assert.equal((await handler(request)).statusCode,status);
  }
});

test('half a second and exactly two minutes are supported and silence returns a clear result', async () => {
  const seconds = [];
  const handler = server({reserve:async s => { seconds.push(s); return true; },read:async () => ''});
  for (const span of [.5,120]) assert.equal(JSON.parse((await handler(event(recording(span)))).body).code,'no_speech');
  assert.deepEqual(seconds,[1,120]);
});

const offerSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const answerSdp = 'v=0\r\ns=fixture\r\n';
const call = 'rtc_vita_fixture';
const broker = (overrides = {}) => createLiveTranscribe({
  provider:'test-provider',account:'test-account',queueUrl:'test-queue',limit:300,
  getToken:async () => 'role-token',...overrides,
});
function liveEvent(sdp = offerSdp) {
  return {...event(),rawPath:'/api/dictation/live',headers:{origin,'content-type':'application/sdp'},isBase64Encoded:false,body:sdp};
}
function clientToken() {
  return Response.json({value:'ephemeral-fixture',session:{type:'transcription'}});
}

test('live calls reserve capacity before requesting an English transcription session and queue an expiry',async () => {
  const steps = [];
  const live = broker({
    request:async (url,options) => {
      if (url.endsWith('/client_secrets')) {
        steps.push('session');
        const {session,expires_after:expiry} = JSON.parse(options.body);
        assert.deepEqual(expiry,{anchor:'created_at',seconds:10});
        assert.equal(session.type,'transcription');
        assert.deepEqual(session.audio.input,{transcription:{model:'gpt-live-transcribe',languages:['en']},turn_detection:null});
        assert.equal(options.headers.authorization,'Bearer role-token');
        return clientToken();
      }
      steps.push('call');
      assert.equal(options.headers.authorization,'Bearer ephemeral-fixture');
      assert.equal(options.body,offerSdp);
      return new Response(answerSdp,{status:201,headers:{location:'/v1/realtime/calls/' + call}});
    },
    enqueue:async id => { assert.equal(id,call); steps.push('expiry'); },
  });
  const handler = server({live,reserve:async (seconds,options) => {
    assert.equal(seconds,145);
    assert.equal(options.prefix,'live#');
    assert.equal(options.table,'test');
    steps.push('reserve');
    return true;
  }});
  const event = liveEvent();
  event.isBase64Encoded = true;
  event.body = Buffer.from(event.body).toString('base64');
  const result = await handler(event);
  assert.equal(result.statusCode,200);
  assert.deepEqual(JSON.parse(result.body),{sdp:answerSdp});
  assert.deepEqual(steps,['reserve','session','call','expiry']);
});

test('open circuit, site limit and provider quota preserve Amazon dictation',async () => {
  let quota = false, calls = 0;
  const live = broker({request:async () => { calls++; return Response.json({}, {status:429}); }});
  const handler = server({live,reserve:async (_,{prefix}) => !prefix || quota,read:async () => 'Backup words.'});
  assert.equal((await handler(liveEvent())).statusCode,429);
  assert.equal(calls,0);
  quota = true;
  assert.equal((await handler(liveEvent())).statusCode,503);
  assert.equal((await handler(liveEvent())).statusCode,503);
  assert.equal(calls,1);
  assert.deepEqual(JSON.parse((await handler(event())).body),{text:'Backup words.'});
});

test('bad or disabled live offers do not request a token or reserve a call',async () => {
  const fail = () => assert.fail('bad offers must be free');
  const live = broker({getToken:fail,request:fail,enqueue:fail});
  const handler = server({live,reserve:fail});
  const video = liveEvent(offerSdp + 'm=video 9 RTP/AVP 31\r\n');
  for (const req of [liveEvent('invalid'),video,liveEvent(offerSdp + '!'.repeat(32768))]) {
    assert.equal((await handler(req)).statusCode,422);
  }
  const disabled = server({live:broker({limit:0,getToken:fail}),reserve:fail});
  assert.equal((await disabled(liveEvent())).statusCode,503);
});

test('a call without a scheduled expiry is closed immediately and withheld from the browser',async () => {
  const steps = [];
  const live = broker({
    request:async url => {
      if (url.endsWith('/client_secrets')) return clientToken();
      if (url.endsWith('/hangup')) { steps.push('hangup'); return new Response(null,{status:204}); }
      return new Response(answerSdp,{status:201,headers:{location:'/v1/realtime/calls/' + call}});
    },
    enqueue:async () => { steps.push('failed expiry'); throw new Error('queue'); },
  });
  const handler = server({live,reserve:async () => true});
  assert.equal((await handler(liveEvent())).statusCode,503);
  assert.deepEqual(steps,['failed expiry','hangup']);
});
