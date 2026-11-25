import {DynamoDBClient, UpdateItemCommand} from '@aws-sdk/client-dynamodb';
import {TranscribeAudioCommand, TranscribeClient} from '@aws-sdk/client-transcribe';
import {createLiveTranscribe} from './live.mjs';

const sampleRate = 16_000;
const frameBytes = 2;
const headerBytes = 44;
const minBytes = headerBytes + sampleRate * frameBytes / 2;
const maxBytes = headerBytes + sampleRate * frameBytes * 120;
const encodedLimit = 4 * Math.ceil(maxBytes / 3);
const ddb = new DynamoDBClient({maxAttempts:2});
const transcribe = new TranscribeClient({maxAttempts:1});

function response(statusCode, body) {
  return {statusCode, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}, body:JSON.stringify(body)};
}

function waveform(event) {
  if (typeof event.body !== 'string' || !event.isBase64Encoded || event.body.length > encodedLimit) return null;
  const bytes = Buffer.from(event.body,'base64');
  if (bytes.length < minBytes || bytes.length > maxBytes || (bytes.length - headerBytes) % frameBytes) return null;
  if (bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,16) !== 'WAVEfmt ' ||
      bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(16) !== 16 ||
      bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== sampleRate ||
      bytes.readUInt32LE(28) !== sampleRate * frameBytes || bytes.readUInt16LE(32) !== frameBytes ||
      bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii',36,40) !== 'data' ||
      bytes.readUInt32LE(40) !== bytes.length - headerBytes) return null;
  return bytes;
}

async function reserveSeconds(seconds, {now, table, limit, prefix = ''}) {
  if (seconds > limit) return false;
  // One conditional update prevents concurrent requests from exceeding the month's allowance.
  const period = prefix + now.toISOString().slice(0,7);
  try {
    await ddb.send(new UpdateItemCommand({
      TableName:table, Key:{period:{S:period}},
      UpdateExpression:'SET expiresAt = :expires ADD secondsUsed :amount',
      ConditionExpression:'attribute_not_exists(secondsUsed) OR secondsUsed <= :available',
      ExpressionAttributeValues:{
        ':amount':{N:String(seconds)}, ':available':{N:String(limit - seconds)},
        ':expires':{N:String(Math.floor(now.valueOf() / 1000) + 70 * 86400)},
      },
    }), {abortSignal:AbortSignal.timeout(4000)});
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function recognize(audio) {
  const result = await transcribe.send(new TranscribeAudioCommand({Media:{MediaBytes:audio},Language:'en'}), {
    abortSignal:AbortSignal.timeout(20_000),
  });
  return result.TranscriptResponse?.Results?.Transcript?.trim() ?? '';
}

export function createVoiceHandler({
  origin = process.env.VITA_ORIGIN, table = process.env.VOICE_USAGE_TABLE,
  limit = Number(process.env.VOICE_MONTHLY_SECONDS), reserve = reserveSeconds, read = recognize, clock = () => new Date(),
  live = createLiveTranscribe(),
} = {}) {
  return async event => {
    if (event.Records?.every(record => record.eventSource === 'aws:sqs')) {
      await Promise.all(event.Records.map(record => live.terminate(record.body)));
      return;
    }
    const isLive = event.rawPath === '/api/dictation/live';
    if ((!isLive && event.rawPath !== '/api/dictation') || event.requestContext?.http?.method !== 'POST') return response(405,{code:'method'});
    if (!origin || event.headers?.origin !== origin) return response(403,{code:'origin'});
    if (isLive) {
      if (!table) return response(503,{code:'live_unavailable'});
      try {
        const result = await live.offer(event,(seconds, options) => reserve(seconds,{...options,table}));
        return response(result.status,result.body);
      } catch (error) {
        console.warn(JSON.stringify({operation:'live-dictation',error:error.name,requestId:event.requestContext?.requestId}));
        return response(503,{code:'live_unavailable'});
      }
    }
    if (event.headers?.['content-type'] !== 'audio/wav') return response(415,{code:'format'});
    if (!table || !Number.isSafeInteger(limit) || limit < 1) return response(503,{code:'unavailable'});
    const audio = waveform(event);
    if (!audio) return response(422,{code:'recording'});
    const seconds = Math.ceil((audio.length - headerBytes) / (sampleRate * frameBytes));
    try {
      if (!await reserve(seconds,{now:clock(),table,limit})) return response(429,{code:'voice_allowance'});
      const text = await read(audio);
      return text ? response(200,{text}) : response(422,{code:'no_speech'});
    } catch (error) {
      // Only operational metadata goes to CloudWatch.
      console.warn(JSON.stringify({operation:'dictation',error:error.name,requestId:event.requestContext?.requestId}));
      const code = error.name === 'LimitExceededException' ? 503 : 502;
      return response(code,{code:'unavailable'});
    }
  };
}

export const handler = createVoiceHandler();
