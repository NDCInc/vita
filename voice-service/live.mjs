import {GetWebIdentityTokenCommand, STSClient} from '@aws-sdk/client-sts';
import {SendMessageCommand, SQSClient} from '@aws-sdk/client-sqs';

const audience = 'https://api.openai.com/v1';
const callsUrl = audience + '/realtime/calls';
const sessionUrl = audience + '/realtime/client_secrets';
const maxSdpBytes = 32_768;
const leaseSeconds = 145;
const expiryDelay = 130;
const callIdPattern = /^[A-Za-z0-9_-]{8,160}$/u;
const sts = new STSClient({maxAttempts:1});
const queue = new SQSClient({maxAttempts:2});

// Keep the role's short-lived tokens in Lambda memory and deduplicate warm refreshes.
function workloadToken(provider, account, exchange = fetch) {
  let cached, pending;
  async function refresh() {
    const jwt = await sts.send(new GetWebIdentityTokenCommand({
      Audience:[audience], SigningAlgorithm:'ES384', DurationSeconds:60,
    }), {abortSignal:AbortSignal.timeout(2500)});
    if (typeof jwt.WebIdentityToken !== 'string') throw new Error('InvalidAwsIdentity');
    const result = await exchange('https://auth.openai.com/oauth/token',{
      method:'POST', headers:{'content-type':'application/json'}, signal:AbortSignal.timeout(3500),
      body:JSON.stringify({
        grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type:'urn:ietf:params:oauth:token-type:jwt',
        subject_token:jwt.WebIdentityToken, identity_provider_id:provider, service_account_id:account,
      }),
    });
    if (!result.ok) throw new Error('IdentityExchange' + result.status);
    const value = await result.json();
    if (typeof value.access_token !== 'string' || !Number.isFinite(value.expires_at)) throw new Error('InvalidIdentityExchange');
    cached = {token:value.access_token,expiresAt:value.expires_at * 1000};
    return cached.token;
  }
  return async () => {
    if (cached?.expiresAt > Date.now() + 60_000) return cached.token;
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  };
}

function callId(location) {
  if (typeof location !== 'string') return '';
  try {
    const path = new URL(location,callsUrl).pathname;
    const id = /^\/v1\/realtime\/calls\/([^/]+)$/u.exec(path)?.[1];
    return callIdPattern.test(id ?? '') ? id : '';
  } catch { return ''; }
}

function sdpOffer(event) {
  const body = event.body;
  if (typeof body !== 'string' || body.length > (event.isBase64Encoded ? maxSdpBytes * 4 / 3 + 4 : maxSdpBytes)) return '';
  const offer = event.isBase64Encoded ? Buffer.from(body,'base64').toString('utf8') : body;
  if (Buffer.byteLength(offer) > maxSdpBytes || !offer.startsWith('v=0\r\n') || !/^m=audio /mu.test(offer) ||
      !/^m=application /mu.test(offer) || /^m=video /mu.test(offer)) return '';
  return offer;
}

export function createLiveTranscribe({
  provider = process.env.OPENAI_VITA_IDENTITY_PROVIDER, account = process.env.OPENAI_VITA_SERVICE_ACCOUNT,
  queueUrl = process.env.VITA_LIVE_EXPIRY_QUEUE, limit = Number(process.env.VITA_LIVE_MONTHLY_SECONDS),
  getToken = workloadToken(provider,account),
  request = fetch, enqueue = (id) => queue.send(new SendMessageCommand({
    QueueUrl:queueUrl, MessageBody:id, DelaySeconds:expiryDelay,
  }), {abortSignal:AbortSignal.timeout(2500)}),
  clock = () => new Date(),
} = {}) {
  let retryAfter = 0;

  const enabled = Boolean(provider && account && queueUrl && Number.isSafeInteger(limit) && limit >= leaseSeconds);

  async function terminate(id, token = '') {
    if (!callIdPattern.test(id)) return;
    const result = await request(callsUrl + '/' + id + '/hangup',{
      method:'POST', headers:{authorization:'Bearer ' + (token || await getToken())},
      redirect:'error', signal:AbortSignal.timeout(3500),
    });
    if (!result.ok && ![404,409,410].includes(result.status)) throw new Error('CallHangup' + result.status);
  }

  async function offer(event, reserve) {
    const now = clock();
    if (!enabled || now.valueOf() < retryAfter) return {status:503,body:{code:'live_unavailable'}};
    if (event.headers?.['content-type'] !== 'application/sdp') return {status:415,body:{code:'format'}};
    const sdp = sdpOffer(event);
    if (!sdp) return {status:422,body:{code:'offer'}};
    const access = await getToken().catch(error => {
      const providerStatus = /^IdentityExchange[1-5]\d\d$/u.test(error.message) ? error.message : error.name;
      console.warn(JSON.stringify({operation:'live-identity',error:providerStatus}));
      return '';
    });
    if (!access) {
      retryAfter = now.valueOf() + 60_000;
      return {status:503,body:{code:'live_unavailable'}};
    }
    if (!await reserve(leaseSeconds,{now,limit,prefix:'live#'})) {
      return {status:429,body:{code:'voice_allowance'}};
    }
    function unavailable(status, operation) {
      console.warn(JSON.stringify({operation,status}));
      retryAfter = now.valueOf() + ([401,403,429].includes(status) ? 60_000 : 15_000);
      return {status:503,body:{code:'live_unavailable'}};
    }
    const token = await request(sessionUrl,{
      method:'POST', headers:{authorization:'Bearer ' + access,'content-type':'application/json'},
      redirect:'error', signal:AbortSignal.timeout(3500),
      body:JSON.stringify({
        expires_after:{anchor:'created_at',seconds:10},
        session:{
          type:'transcription',
          audio:{input:{transcription:{model:'gpt-live-transcribe',languages:['en']},turn_detection:null}},
        },
      }),
    });
    if (!token.ok) {
      const {error} = await token.json().catch(() => ({}));
      if (token.status === 400 && error) {
        // This request contains only the fixed session settings specified above.
        console.warn(JSON.stringify({operation:'live-session-settings',
          code:error.code, param:error.param,
          message:typeof error.message === 'string' ? error.message.replace(/(?:sk|ek|sess)[_-][\w-]+/gu,'[redacted]').slice(0,350) : '',
        }));
      }
      return unavailable(token.status,'live-session');
    }
    const session = await token.json();
    if (typeof session.value !== 'string' || session.session?.type !== 'transcription') {
      return unavailable(502,'live-session');
    }
    const result = await request(callsUrl,{
      method:'POST', headers:{authorization:'Bearer ' + session.value,'content-type':'application/sdp'}, body:sdp,
      redirect:'error', signal:AbortSignal.timeout(6000),
    });
    if (!result.ok) return unavailable(result.status,'live-call');
    const id = callId(result.headers.get('location'));
    if (!id) throw new Error('MissingCallId');
    try {
      const answer = await result.text();
      if (Buffer.byteLength(answer) > maxSdpBytes || !answer.startsWith('v=0\r\n')) throw new Error('InvalidAnswer');
      // The browser receives only an SDP answer. Every admitted call has a server-side stop.
      await enqueue(id);
      return {status:200,body:{sdp:answer}};
    } catch (error) {
      await terminate(id,access);
      throw error;
    }
  }
  return {offer,terminate};
}

