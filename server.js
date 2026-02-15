// server.js (FULL FILE WITH ALL CHANGES)

const http = require('http');
const WebSocket = require('ws');

const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const { CloudClient } = require('chromadb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.SERVER_URL ||
  `http://127.0.0.1:${port}`;

const PUBLIC_WSS_URL = process.env.PUBLIC_WSS_URL || null;

function absUrl(path) {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${PUBLIC_BASE_URL}${path}`;
}

function getMediaStreamUrl(callSid) {
  if (!PUBLIC_WSS_URL) return null;
  return `${PUBLIC_WSS_URL}/media-stream?callSid=${encodeURIComponent(callSid)}`;
}

/**
 * µ-law decode
 */
function mulawDecodeSample(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= 0x84;
  return sign ? -sample : sample;
}

function decodeMulawBase64ToInt16(base64) {
  const buf = Buffer.from(base64, 'base64');
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawDecodeSample(buf[i]);
  return out;
}

function frameRms(int16) {
  let sumSq = 0;
  for (let i = 0; i < int16.length; i++) {
    const x = int16[i] / 32768;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq / Math.max(1, int16.length));
}

function frameZcr(int16) {
  let zc = 0;
  let prev = int16[0] || 0;
  for (let i = 1; i < int16.length; i++) {
    const cur = int16[i];
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) zc++;
    prev = cur;
  }
  return zc / Math.max(1, int16.length);
}

function rmsToDb(rms) {
  const eps = 1e-6;
  return 20 * Math.log10(Math.max(eps, rms));
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2) return a[mid];
  return (a[mid - 1] + a[mid]) / 2;
}

function iqr(arr) {
  if (!arr || arr.length < 4) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const q1 = a[Math.floor((a.length - 1) * 0.25)];
  const q3 = a[Math.floor((a.length - 1) * 0.75)];
  return q3 - q1;
}

/**
 * Simple pitch estimator via autocorrelation on 8kHz
 * Returns Hz or null
 */
function estimateF0Hz(pcm, sampleRate = 8000) {
  // Use up to 320 samples (40 ms at 8kHz) if available
  const n = Math.min(pcm.length, 320);
  if (n < 160) return null;

  // Normalize to float
  const x = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += pcm[i];
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const v = (pcm[i] - mean) / 32768;
    x[i] = v;
    energy += v * v;
  }
  if (energy < 1e-5) return null;

  // Human voice rough range 60 to 400 Hz
  const minLag = Math.floor(sampleRate / 400); // 20 at 8k
  const maxLag = Math.floor(sampleRate / 60);  // 133 at 8k
  if (maxLag >= n) return null;

  let bestLag = -1;
  let bestCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) corr += x[i] * x[i + lag];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return null;

  // Basic voicing check: correlation must be strong enough
  const norm = energy;
  const strength = bestCorr / (norm + 1e-9);
  if (strength < 0.15) return null;

  return sampleRate / bestLag;
}

/**
 * Spectral centroid and flatness using a small DFT (256)
 * This is light enough when sampled sparsely.
 */
function spectralFeatures(pcm, sampleRate = 8000) {
  const N = 256;
  if (pcm.length < N) return null;

  // Windowed float
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    x[i] = (pcm[i] / 32768) * w;
  }

  // DFT magnitude for bins 0..N/2
  const half = N / 2;
  const mags = new Float32Array(half + 1);

  for (let k = 0; k <= half; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const ang = (2 * Math.PI * k * n) / N;
      re += x[n] * Math.cos(ang);
      im -= x[n] * Math.sin(ang);
    }
    mags[k] = Math.sqrt(re * re + im * im) + 1e-12;
  }

  // Centroid
  let num = 0;
  let den = 0;
  for (let k = 1; k <= half; k++) {
    const f = (k * sampleRate) / N;
    const m = mags[k];
    num += f * m;
    den += m;
  }
  const centroid = den > 0 ? num / den : null;

  // Flatness (geometric mean / arithmetic mean)
  let logSum = 0;
  let linSum = 0;
  const count = half;
  for (let k = 1; k <= half; k++) {
    const m = mags[k];
    logSum += Math.log(m);
    linSum += m;
  }
  const geo = Math.exp(logSum / Math.max(1, count));
  const ar = linSum / Math.max(1, count);
  const flatness = ar > 0 ? geo / ar : null;

  // Breathiness proxy: high frequency ratio (2k to 4k) over total
  let hi = 0;
  let tot = 0;
  for (let k = 1; k <= half; k++) {
    const f = (k * sampleRate) / N;
    const m = mags[k];
    tot += m;
    if (f >= 2000) hi += m;
  }
  const breath = tot > 0 ? hi / tot : null;

  return { centroid, flatness, breath };
}

// -------------------------
// In-memory call logs fallback
// -------------------------
const inMemoryCallLogsByCallSid = new Map();
const inMemoryCallLogIndex = [];
const IN_MEMORY_MAX_LOGS = 200;

function upsertInMemoryCallLog(callLogObject) {
  if (!callLogObject || !callLogObject.callSid) return;

  const callSid = callLogObject.callSid;
  inMemoryCallLogsByCallSid.set(callSid, callLogObject);

  const existingIdx = inMemoryCallLogIndex.findIndex(x => x.callSid === callSid);
  const row = {
    callSid,
    created_at: callLogObject.created_at,
    phoneNumber: callLogObject.phoneNumber || null
  };

  if (existingIdx >= 0) inMemoryCallLogIndex[existingIdx] = row;
  else inMemoryCallLogIndex.push(row);

  inMemoryCallLogIndex.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  while (inMemoryCallLogIndex.length > IN_MEMORY_MAX_LOGS) {
    const removed = inMemoryCallLogIndex.pop();
    if (removed?.callSid) inMemoryCallLogsByCallSid.delete(removed.callSid);
  }
}

// -------------------------
// Chroma init
// -------------------------
const chroma = new CloudClient({
  apiKey: process.env.CHROMA_API_KEY,
  tenant: process.env.CHROMA_TENANT,
  database: 'second'
});

let transcriptCollection;

async function initChroma() {
  try {
    transcriptCollection = await chroma.getOrCreateCollection({
      name: 'call_transcripts',
      metadata: { 'hnsw:space': 'cosine' }
    });
    console.log('ChromaDB ready (call_transcripts)');
  } catch (err) {
    console.warn('ChromaDB not available, call logs will fall back to in-memory only:', err.message);
    transcriptCollection = null;
  }
}
initChroma();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

const client = twilio(accountSid, authToken);

const { generateFollowUpQuestion, autoScheduleFromTranscript, extractDBColumns } = require('./openai-calls');
const { actualPainFromTimeseries } = require('./pain-correction');

const scheduledCalls = [];
const conversations = new Map();
const mediaSessions = new Map();

function getRandomGreeting() {
  const greetings = ["Hi", "Hello", "Hola", "Bonjour"];
  const randomIndex = Math.floor(Math.random() * greetings.length);
  return greetings[randomIndex];
}

function freshMediaSession(callSid) {
  return {
    callSid,
    wsConnected: false,
    startedAt: Date.now(),
    lastMediaAt: null,
    mediaFrames: 0,
    streamSid: null,

    // 60s rolling window
    windowMs: 5000,
    windowStartedAt: Date.now(),
    windowFrames: 0,
    windowRmsSum: 0,
    windowZcrSum: 0,
    windowSpeechFrames: 0,

    // new: segment tracking inside each 60s window
    seg: {
      inSpeech: false,
      segStartMs: Date.now()
    },
    windowPhrasesSec: [],
    windowPausesSec: [],
    windowF0: [],
    windowCentroidSum: 0,
    windowFlatnessSum: 0,
    windowBreathSum: 0,
    windowSpecCount: 0,
    windowCoughCount: 0,
    coughCooldownUntil: 0,

    // new: per second series for old visuals
    sec: {
      startedAt: Date.now(),
      frames: 0,
      rmsSum: 0,
      voicedFrames: 0
    },
    rmsDbSeries: [],      // [{t, rmsDb}]
    voicedSeries: [],     // [{t, voicedPct}]

    // 60s summaries that match old indicators card
    rolling60Series: [],  // [{t, ...indicators...}]

    // abnormal events
    abnormalLog: [],

    baseline: {
      ready: false,
      windows: 0,
      silenceMean: 0,
      silenceM2: 0,
      phraseMean: 0,
      phraseM2: 0,
      pauseRateMean: 0,
      pauseRateM2: 0
    }
  };
}

function welfordUpdate(mean, m2, n, x) {
  const n1 = n + 1;
  const delta = x - mean;
  const mean1 = mean + delta / n1;
  const delta2 = x - mean1;
  const m21 = m2 + delta * delta2;
  return { mean: mean1, m2: m21, n: n1 };
}

function welfordStd(m2, n) {
  if (n < 2) return 0;
  return Math.sqrt(m2 / (n - 1));
}

// Initial voice endpoint
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;

  if (!conversations.has(callSid)) {
    conversations.set(callSid, []);
    console.log(`New call started: ${callSid}`);
  }

  const initialGreeting = "Hello! Just checking in. How are you feeling today?";
  const mediaUrl = getMediaStreamUrl(callSid);

  if (mediaUrl) {
    twiml.start().stream({ url: mediaUrl });

    if (!mediaSessions.has(callSid)) {
      mediaSessions.set(callSid, freshMediaSession(callSid));
    }

    console.log(`[${callSid}] Media Stream enabled -> ${mediaUrl}`);
  } else {
    console.warn(`[${callSid}] Media Stream NOT enabled (PUBLIC_WSS_URL not set)`);
  }

  twiml.say({ voice: 'alice' }, initialGreeting);

  conversations.get(callSid).push({
    speaker: 'AI',
    message: initialGreeting,
    timestamp: new Date().toISOString()
  });

  twiml.gather({
    input: 'speech',
    action: absUrl('/handle-speech'),
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US'
  });

  twiml.say({ voice: 'alice' }, 'Are you still there?');
  twiml.redirect({ method: 'POST' }, absUrl('/voice'));

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle speech
app.post('/handle-speech', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeechRaw = req.body.SpeechResult;

  if (!userSpeechRaw || !String(userSpeechRaw).trim()) {
    console.log(`[${callSid}] User said: (empty)`);

    twiml.gather({
      input: 'speech',
      action: absUrl('/handle-speech'),
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US'
    });

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const userSpeech = String(userSpeechRaw).trim();
  console.log(`[${callSid}] User said: ${userSpeech}`);

  if (!conversations.has(callSid)) conversations.set(callSid, []);

  conversations.get(callSid).push({
    speaker: 'User',
    message: userSpeech,
    timestamp: new Date().toISOString()
  });

  const transcriptArray = conversations.get(callSid);
  const transcriptString = transcriptArray.map(e => `${e.speaker}: ${e.message}`).join('\n');

  try {
    const aiResponse = await generateFollowUpQuestion(transcriptString);

    conversations.get(callSid).push({
      speaker: 'AI',
      message: aiResponse,
      timestamp: new Date().toISOString()
    });

    twiml.say({ voice: 'alice' }, aiResponse);
  } catch (error) {
    console.error('Error getting AI response:', error);

    const fallbackResponse = getRandomGreeting();
    twiml.say({ voice: 'alice' }, fallbackResponse);

    conversations.get(callSid).push({
      speaker: 'AI',
      message: `${fallbackResponse} (fallback)`,
      timestamp: new Date().toISOString()
    });
  }

  twiml.gather({
    input: 'speech',
    action: absUrl('/handle-speech'),
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US'
  });

  twiml.say({ voice: 'alice' }, 'I am listening. Please continue.');
  twiml.redirect({ method: 'POST' }, absUrl('/handle-speech'));

  res.type('text/xml');
  res.send(twiml.toString());
});

// Pain correction
app.post('/api/actual-pain', (req, res) => {
  try {
    const { timeseries, options } = req.body || {};
    if (!Array.isArray(timeseries) || timeseries.length === 0) {
      return res.status(400).json({ error: 'timeseries array required' });
    }
    const result = actualPainFromTimeseries(timeseries, options || {});
    res.json({ data: result });
  } catch (err) {
    console.error('Actual pain API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Make call
app.post('/make-call', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

  try {
    const call = await client.calls.create({
      url: `${PUBLIC_BASE_URL}/voice`,
      to: phoneNumber,
      from: twilioPhoneNumber,
      statusCallback: `${PUBLIC_BASE_URL}/call-status`,
      statusCallbackEvent: ['completed']
    });

    console.log(`Call initiated: ${call.sid}`);
    res.json({ success: true, callSid: call.sid, message: 'Call initiated' });
  } catch (e) {
    console.error('Error making call:', e);
    res.status(500).json({ error: e.message });
  }
});

// Schedule recurring
function scheduleRecurringCalls(phoneNumber, frequency, time, endDate) {
  phoneNumber = "+15108308921";

  const [hours, minutes] = time.split(':');

  let cronExpression;
  switch (frequency) {
    case 'daily': cronExpression = `${minutes} ${hours} * * *`; break;
    case 'weekly': cronExpression = `${minutes} ${hours} * * 1`; break;
    default: throw new Error('Invalid frequency. Use: daily or weekly');
  }

  const callId = `recurring-${Date.now()}`;

    const task = cron.schedule(cronExpression, async () => {
        console.log(`Making recurring call to ${phoneNumber}`);
        
        // Stop all calls after end date
        if (endDate) {
            const now = new Date();
            const end = new Date(endDate);
            
            if (now > end) {
                console.log(`End date reached for ${phoneNumber}. Stopping calls.`);
                task.stop();
                
                const index = scheduledCalls.findIndex(c => c.id === callId);
                if (index > -1) scheduledCalls.splice(index, 1);
                
                return;
            }
        }
        
        try {
            const result = await makeTwilioCall(phoneNumber);
            console.log(`Recurring call initiated: ${result.callSid}`);
        } catch (error) {
            console.error(`Failed to make recurring call: ${error.message}`);
        }
    });

    const scheduleObj = {
        id: callId,
        phoneNumber,
        frequency,
        time,
        endDate: endDate || null,
        dateScheduled,
        task
    };

    scheduledCalls.push(scheduleObj);

    console.log(`Scheduled ${frequency} calls at ${time} for ${phoneNumber}`);

    console.log(`Scheduled ${frequency} calls at ${time} for ${phoneNumber}`);

    return { success: true, callId };
}

app.post('/schedule-recurring', (req, res) => {
  const { phoneNumber, frequency, time, endDate } = req.body;
  if (!phoneNumber || !frequency) return res.status(400).json({ error: 'Phone number and frequency required' });

  try {
    const result = scheduleRecurringCalls(phoneNumber, frequency, time, endDate);
    res.json({ success: true, callId: result.callId, message: `Recurring ${frequency} calls scheduled` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/scheduled-calls', (req, res) => {
  const calls = scheduledCalls.map(({ id, phoneNumber, frequency, time }) => ({ id, phoneNumber, frequency, time }));
  res.json({ calls });
});

// Call status webhook: persist call log with new biomarker payload
app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const patientPhoneNumber = req.body.To || req.body.From || null;

  console.log(`Call ${callSid} status: ${callStatus}`);

  if (callStatus === 'completed') {
    const transcriptArray = conversations.get(callSid) || [];
    const transcriptString = transcriptArray.map(e => `${e.speaker}: ${e.message}`).join('\n');

    let features = null;
    if (transcriptString.trim()) {
      try { features = await extractDBColumns(transcriptString, patientPhoneNumber).catch(() => null); }
      catch { features = null; }
    }

    const ms = mediaSessions.get(callSid);
    const createdAt = new Date().toISOString();

    const callLogObject = {
      callSid,
      phoneNumber: patientPhoneNumber,
      created_at: createdAt,
      transcript: transcriptArray,
      extracted: features,
      biomarkers: {
        // old visuals need these
        rmsDbSeries: ms?.rmsDbSeries || [],
        voicedSeries: ms?.voicedSeries || [],
        rolling60Series: ms?.rolling60Series || [],

        // keep your existing minimal series too
        series: ms?.rolling60Series || []
      },
      abnormalLog: ms?.abnormalLog || []
    };

    upsertInMemoryCallLog(callLogObject);

    if (transcriptCollection) {
      try {
        await transcriptCollection.add({
          ids: [`calllog_${callSid}`],
          documents: [JSON.stringify(callLogObject)],
          metadatas: [{
            type: 'call_log',
            callSid,
            phoneNumber: patientPhoneNumber,
            created_at: createdAt
          }]
        });
        console.log(`[${callSid}] Saved call log to ChromaDB`);
      } catch (e) {
        console.warn(`[${callSid}] Chroma save failed, still kept in memory:`, e.message);
      }
    }

    if (transcriptString.trim()) {
      autoScheduleFromTranscript(transcriptString, patientPhoneNumber, scheduleRecurringCalls)
        .catch(() => {});
    }

    conversations.delete(callSid);
    mediaSessions.delete(callSid);
  }

  res.sendStatus(200);
});

// Call log APIs
app.get('/api/call-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);

    const mem = inMemoryCallLogIndex.slice(0, limit).map(row => ({
      id: `mem_calllog_${row.callSid}`,
      callSid: row.callSid,
      phoneNumber: row.phoneNumber,
      created_at: row.created_at,
      source: 'memory'
    }));

    if (!transcriptCollection) {
      const logs = mem.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
      return res.json({ logs });
    }

    let chromaLogs = [];
    try {
      const got = await transcriptCollection.get({
        limit: Math.max(limit, 50),
        include: ['metadatas']
      });

      const ids = got?.ids || [];
      const metas = got?.metadatas || [];
      chromaLogs = ids.map((id, i) => {
        const m = metas[i] || {};
        if (m.type !== 'call_log') return null;
        return { id, callSid: m.callSid, phoneNumber: m.phoneNumber, created_at: m.created_at, source: 'chroma' };
      }).filter(Boolean);
    } catch (e) {
      chromaLogs = [];
    }

    const byCallSid = new Map();
    for (const l of mem) byCallSid.set(l.callSid, l);
    for (const l of chromaLogs) byCallSid.set(l.callSid, l);

    const merged = Array.from(byCallSid.values())
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    res.json({ logs: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/call-logs/:callSid', async (req, res) => {
  try {
    const callSid = req.params.callSid;

    const mem = inMemoryCallLogsByCallSid.get(callSid);
    if (mem) return res.json({ log: mem, source: 'memory' });

    if (!transcriptCollection) return res.status(404).json({ error: 'Not found' });

    const got = await transcriptCollection.get({
      ids: [`calllog_${callSid}`],
      include: ['documents']
    });

    const doc = got?.documents?.[0];
    if (!doc) return res.status(404).json({ error: 'Not found' });

    res.json({ log: JSON.parse(doc), source: 'chroma' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WebSocket server for Twilio Media Streams
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

function finalizeWindowAndAppendPoint(session) {
  if (!session) return;
  if (session.windowFrames <= 0) return;

  const frames = Math.max(1, session.windowFrames);
  const meanRms = session.windowRmsSum / frames;
  const meanZcr = session.windowZcrSum / frames;
  const speechRatio = session.windowSpeechFrames / frames;

  const point = {
    t: new Date(session.windowStartedAt).toISOString(),
    meanRms,
    meanZcr,
    speechRatio,
    frames
  };

  session.biomarkerSeries.push(point);

  // reset window
  session.windowStartedAt = Date.now();
  session.windowFrames = 0;
  session.windowRmsSum = 0;
  session.windowZcrSum = 0;
  session.windowSpeechFrames = 0;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let callSid = url.searchParams.get('callSid') || null;

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); }
    catch { return; }

    const event = data.event;

    if (event === 'start') {
      callSid = data?.start?.callSid || callSid;
      const streamSid = data?.start?.streamSid;

      if (callSid) {
        const s = mediaSessions.get(callSid) || freshMediaSession(callSid);
        s.wsConnected = true;
        s.streamSid = streamSid || s.streamSid;
        mediaSessions.set(callSid, s);
        console.log(`[${callSid}] Media Stream started (streamSid=${streamSid || 'n/a'})`);
      }
      return;
    }

    if (event === 'media') {
      if (!callSid) return;

      const payload = data?.media?.payload;
      if (!payload) return;

      const s = mediaSessions.get(callSid) || freshMediaSession(callSid);

      s.mediaFrames += 1;
      s.lastMediaAt = Date.now();

      const pcm = decodeMulawBase64ToInt16(payload);
      const rms = frameRms(pcm);
      const zcr = frameZcr(pcm);
      const db = rmsToDb(rms);

      // Simple voiced gate
      const isSpeech = rms > 0.02;

      // 1 second series for old visuals
      s.sec.frames += 1;
      s.sec.rmsSum += rms;
      if (isSpeech) s.sec.voicedFrames += 1;

      const now = Date.now();
      if (now - s.sec.startedAt >= 1000) {
        const frames = Math.max(1, s.sec.frames);
        const meanRms = s.sec.rmsSum / frames;
        const voicedPct = s.sec.voicedFrames / frames;

        s.rmsDbSeries.push({ t: new Date(s.sec.startedAt).toISOString(), rmsDb: rmsToDb(meanRms) });
        s.voicedSeries.push({ t: new Date(s.sec.startedAt).toISOString(), voicedPct });

        s.sec.startedAt = now;
        s.sec.frames = 0;
        s.sec.rmsSum = 0;
        s.sec.voicedFrames = 0;
      }

      // Segment tracking for phrase and pause lengths inside window
      const seg = s.seg;
      const curInSpeech = seg.inSpeech;

      if (isSpeech !== curInSpeech) {
        const durSec = (now - seg.segStartMs) / 1000;
        if (curInSpeech) s.windowPhrasesSec.push(durSec);
        else s.windowPausesSec.push(durSec);

        seg.inSpeech = isSpeech;
        seg.segStartMs = now;
      }

      // Cough heuristic, no raw audio, just counters
      if (now >= s.coughCooldownUntil) {
        // loud, noisy, brief onset signature
        if (isSpeech && rms > 0.12 && zcr > 0.12) {
          s.windowCoughCount += 1;
          s.coughCooldownUntil = now + 1000;
        }
      }

      // Sample more expensive features sparsely
      if (isSpeech && (s.mediaFrames % 10 === 0)) {
        const f0 = estimateF0Hz(pcm, 8000);
        if (f0 != null && f0 >= 50 && f0 <= 450) s.windowF0.push(f0);

        const spec = spectralFeatures(pcm, 8000);
        if (spec && spec.centroid != null && spec.flatness != null && spec.breath != null) {
          s.windowCentroidSum += spec.centroid;
          s.windowFlatnessSum += spec.flatness;
          s.windowBreathSum += spec.breath;
          s.windowSpecCount += 1;
        }
      }

      // 60 second rolling window summary
      s.windowFrames += 1;
      s.windowRmsSum += rms;
      s.windowZcrSum += zcr;
      if (isSpeech) s.windowSpeechFrames += 1;

      if (now - s.windowStartedAt >= s.windowMs) {
        // close the active segment into this window before computing
        const activeDurSec = (now - s.seg.segStartMs) / 1000;
        if (s.seg.inSpeech) s.windowPhrasesSec.push(activeDurSec);
        else s.windowPausesSec.push(activeDurSec);
        s.seg.segStartMs = now;

        const frames = Math.max(1, s.windowFrames);
        const meanRms = s.windowRmsSum / frames;
        const meanZcr = s.windowZcrSum / frames;
        const speechRatio = s.windowSpeechFrames / frames;

        const silencePct = 1 - speechRatio;
        const voicedPct = speechRatio;

        const medPhrase = median(s.windowPhrasesSec);
        const medPause = median(s.windowPausesSec);

        // Convert segment counts into per minute
        const windowMinutes = s.windowMs / 60000;
        const pausesPerMin = (s.windowPausesSec.length / Math.max(1e-9, windowMinutes));
        const phrasesPerMin = (s.windowPhrasesSec.length / Math.max(1e-9, windowMinutes));

        const medF0 = median(s.windowF0);
        const iqrF0v = iqr(s.windowF0);

        const centroidMean = s.windowSpecCount ? (s.windowCentroidSum / s.windowSpecCount) : null;
        const flatnessMean = s.windowSpecCount ? (s.windowFlatnessSum / s.windowSpecCount) : null;
        const breathMean = s.windowSpecCount ? (s.windowBreathSum / s.windowSpecCount) : null;

        // Baseline z scores using the first 5 windows
        const b = s.baseline;
        const baselineWindowsTarget = 3;

        let baselineZSilence = null;
        let baselineZPhraseLen = null;
        let baselineZPausesPerMin = null;

        if (!b.ready) {
          const u1 = welfordUpdate(b.silenceMean, b.silenceM2, b.windows, silencePct);
          const u2 = welfordUpdate(b.phraseMean, b.phraseM2, b.windows, medPhrase != null ? medPhrase : 0);
          const u3 = welfordUpdate(b.pauseRateMean, b.pauseRateM2, b.windows, pausesPerMin);

          b.silenceMean = u1.mean; b.silenceM2 = u1.m2;
          b.phraseMean = u2.mean; b.phraseM2 = u2.m2;
          b.pauseRateMean = u3.mean; b.pauseRateM2 = u3.m2;
          b.windows = u1.n;

          if (b.windows >= baselineWindowsTarget) b.ready = true;
        } else {
          const sStd = welfordStd(b.silenceM2, b.windows) || 1e-6;
          const pStd = welfordStd(b.phraseM2, b.windows) || 1e-6;
          const rStd = welfordStd(b.pauseRateM2, b.windows) || 1e-6;

          baselineZSilence = (silencePct - b.silenceMean) / sStd;
          baselineZPhraseLen = ((medPhrase != null ? medPhrase : 0) - b.phraseMean) / pStd;
          baselineZPausesPerMin = (pausesPerMin - b.pauseRateMean) / rStd;
        }

        // Flags
        const breathinessFlag = breathMean != null ? (breathMean > 0.38) : false;
        const coughFlag = s.windowCoughCount >= 2;
        const combinedFlag =
          (baselineZSilence != null && Math.abs(baselineZSilence) >= 2.5) ||
          (baselineZPausesPerMin != null && Math.abs(baselineZPausesPerMin) >= 2.5) ||
          breathinessFlag ||
          coughFlag;

        if (combinedFlag) {
          const parts = [];
          if (baselineZSilence != null && Math.abs(baselineZSilence) >= 2.5) parts.push(`Silence pattern shifted (z ${baselineZSilence.toFixed(2)})`);
          if (baselineZPausesPerMin != null && Math.abs(baselineZPausesPerMin) >= 2.5) parts.push(`Pause rate shifted (z ${baselineZPausesPerMin.toFixed(2)})`);
          if (breathinessFlag) parts.push('Breathiness proxy elevated');
          if (coughFlag) parts.push('Possible cough pattern detected');

          s.abnormalLog.push({
            t: new Date(s.windowStartedAt).toISOString(),
            message: parts.join('. ')
          });
        }

        const summary = {
          t: new Date(s.windowStartedAt).toISOString(),

          // old three mini charts equivalents
          meanRms,
          meanZcr,
          speechRatio,

          // indicators card fields
          silencePct,
          voicedPct,
          medianPhraseLenSec: medPhrase,
          medianPauseLenSec: medPause,
          pausesPerMin,
          phrasesPerMin,
          medianF0Hz: medF0,
          iqrF0Hz: iqrF0v,
          spectralCentroidHz: centroidMean,
          spectralFlatness: flatnessMean,
          breathinessProxy: breathMean,
          coughCount: s.windowCoughCount,

          baselineZSilence,
          baselineZPhraseLen,
          baselineZPausesPerMin,
          breathinessFlag,
          coughFlag,
          combinedFlag
        };

        s.rolling60Series.push(summary);

        // reset window accumulators
        s.windowStartedAt = now;
        s.windowFrames = 0;
        s.windowRmsSum = 0;
        s.windowZcrSum = 0;
        s.windowSpeechFrames = 0;

        s.windowPhrasesSec = [];
        s.windowPausesSec = [];
        s.windowF0 = [];
        s.windowCentroidSum = 0;
        s.windowFlatnessSum = 0;
        s.windowBreathSum = 0;
        s.windowSpecCount = 0;
        s.windowCoughCount = 0;

        // reset segment state baseline point start
        s.seg.segStartMs = now;
      }

      mediaSessions.set(callSid, s);

      return;
    }

    if (event === 'stop') {
      if (callSid) {
        const s = mediaSessions.get(callSid);
        finalizeWindowAndAppendPoint(s);
        mediaSessions.set(callSid, s);
        console.log(`[${callSid}] Media Stream stopped`);
      }
      return;
    }
  });

  ws.on('close', () => {
    if (callSid && mediaSessions.has(callSid)) {
      const s = mediaSessions.get(callSid);
      finalizeWindowAndAppendPoint(s);
      s.wsConnected = false;
      mediaSessions.set(callSid, s);
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://127.0.0.1:${port}`);
  console.log(`PUBLIC_BASE_URL = ${PUBLIC_BASE_URL}`);
  console.log(`PUBLIC_WSS_URL  = ${PUBLIC_WSS_URL || '(not set)'}`);
});