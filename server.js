const http = require('http');
const WebSocket = require('ws');

const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');  //node-cron for scheduling
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
        console.warn('ChromaDB not available, transcripts will not be persisted:', err.message);
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
const { generateFollowUpQuestion, autoScheduleFromTranscript, extractKeywordsFromTranscript } = require('./openai-calls');
const { actualPainFromTimeseries } = require('./pain-correction');
const scheduledCalls = [];
const callList = []; //all calls, ever

const conversations = new Map();
const mediaSessions = new Map();

// Function to get random greeting (keeping this as fallback)
function getRandomGreeting() {
    const greetings = ["Hi", "Hello", "Hola", "Bonjour"];
    const randomIndex = Math.floor(Math.random() * greetings.length);
    return greetings[randomIndex];
}

// Initial voice endpoint - starts the conversation
app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    // Initialize conversation for this call
    if (!conversations.has(callSid)) {
        conversations.set(callSid, []);
        console.log(`New call started: ${callSid}`);
    }
    
    // Say initial greeting
    const initialGreeting = "Hello! Just checking in. How are you feeling today?";
    const mediaUrl = getMediaStreamUrl(callSid);
    if (mediaUrl) {
      twiml.start().stream({ url: mediaUrl });

      if (!mediaSessions.has(callSid)) {
        mediaSessions.set(callSid, {
          callSid,
          wsConnected: false,
          startedAt: Date.now(),
          lastMediaAt: null,
          mediaFrames: 0,
          streamSid: null
        });
      }

      console.log(`[${callSid}] Media Stream enabled -> ${mediaUrl}`);
    } else {
      console.warn(`[${callSid}] Media Stream NOT enabled (PUBLIC_WSS_URL not set)`);
    }
    twiml.say({ voice: 'alice' }, initialGreeting);
    
    // Add to transcript
    conversations.get(callSid).push({
        speaker: 'AI',
        message: initialGreeting,
        timestamp: new Date().toISOString()
    });
    
    // Gather user's speech response
    const gather = twiml.gather({
        input: 'speech',
        action: absUrl('/handle-speech'),
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US'
    });
    
    // If user doesn't say anything, prompt them
    twiml.say({ voice: 'alice' }, 'Are you still there?');
    
    // Redirect back to keep the conversation going
    twiml.redirect({ method: 'POST' }, absUrl('/voice'));
    
    res.type('text/xml');
    res.send(twiml.toString());
});


// Handle user's speech and respond with AI
app.post('/handle-speech', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const userSpeech = req.body.SpeechResult;
    const callSid = req.body.CallSid;
    
    console.log(`[${callSid}] User said: ${userSpeech}`);
    
    // Initialize conversation if it doesn't exist (shouldn't happen, but safety check)
    if (!conversations.has(callSid)) {
        conversations.set(callSid, []);
    }

    console.log('conversations', conversations)
    
    // Add user's speech to transcript
    conversations.get(callSid).push({
        speaker: 'User',
        message: userSpeech,
        timestamp: new Date().toISOString()
    });
    
    // // Get the full conversation transcript
    const transcriptArray = conversations.get(callSid);
    
    const transcriptString = transcriptArray
    .map(entry => `${entry.speaker}: ${entry.message}`)
    .join('\n');
    
    // console.log(`\n--- Full Transcript for ${callSid} ---`);
    // console.log(transcriptArray);
    // console.log('--- End Transcript ---\n');

    try {
        // Get AI response based on full conversation
        const aiResponse = await generateFollowUpQuestion(transcriptString);
        
        // console.log(`[${callSid}] AI responds: ${aiResponse}`);
        
        // Add AI response to transcript
        conversations.get(callSid).push({
            speaker: 'AI',
            message: aiResponse,
            timestamp: new Date().toISOString()
        });
        
        // Say the AI response
        twiml.say({ voice: 'alice' }, aiResponse);
        
    } catch (error) {
        console.error('Error getting AI response:', error);
        
        // Fallback to random greeting if AI fails
        const fallbackResponse = getRandomGreeting();
        twiml.say({ voice: 'alice' }, fallbackResponse);
        
        conversations.get(callSid).push({
            speaker: 'AI',
            message: fallbackResponse + ' (fallback)',
            timestamp: new Date().toISOString()
        });
    }
    
    // Gather user's next response
    const gather = twiml.gather({
        input: 'speech',
        action: '/handle-speech',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US'
    });
    
    // If user doesn't respond, prompt them
    twiml.say({ voice: 'alice' }, 'I am listening. Please continue.');
    
    // Keep looping
    twiml.redirect('/handle-speech');
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Optional: Endpoint to view conversation transcript
app.get('/transcript/:callSid', (req, res) => {
    const callSid = req.params.callSid;
    
    if (conversations.has(callSid)) {
        const transcript = conversations.get(callSid);
        
        // Format as HTML for easy viewing
        let html = `<h1>Transcript for Call: ${callSid}</h1>`;
        html += '<div style="font-family: monospace; white-space: pre-wrap;">';
        
        transcript.forEach(entry => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            html += `<p><strong>[${time}] ${entry.speaker}:</strong> ${entry.message}</p>`;
        });
        
        html += '</div>';
        
        res.send(html);
    } else {
        res.status(404).json({ error: 'Transcript not found' });
    }
});

// Optional: Endpoint to view all active conversations
app.get('/transcripts', (req, res) => {
    const allTranscripts = {};
    
    conversations.forEach((transcript, callSid) => {
        allTranscripts[callSid] = transcript;
    });
    
    res.json(allTranscripts);
});

// Endpoint to make a call
app.post('/make-call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    } else {
        try {
            const result = await makeTwilioCall(phoneNumber);
            res.json(result);
        } catch (error) {
            res.status(500).json({ 
                error: 'Failed to initiate call',
                details: error.message 
            });
        }
    }
});

// CALL SCHEDULING FUNCTION (can be called from endpoint OR auto-scheduler)
function scheduleRecurringCalls(phoneNumber, frequency, time, endDate) {
    phoneNumber = "+15108308921";
    const [hours, minutes] = time.split(':');

    let cronExpression;
    
    switch(frequency) {
        case 'daily':
            cronExpression = `${minutes} ${hours} * * *`;
            break;
        case 'weekly':
            cronExpression = `${minutes} ${hours} * * 1`;
            break;
        default:
            throw new Error('Invalid frequency. Use: daily or weekly');
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
        task
    };

    scheduledCalls.push(scheduleObj);

    console.log(`Scheduled ${frequency} calls at ${time} for ${phoneNumber}`);
    console.log(`calculate all future calls: `)
    callList.append(getFutureCalls(scheduleObj,30)); //add next 30 to callList

    return { success: true, callId };
}

// scheduling endpoint (can be used from web app)
// Request format-- phoneNumber: '[number]', frequency: 'daily' or 'weekly', time: 'HH:MM', endDate: 'YYYY-MM-DDTHH:MM:SS'
app.post('/schedule-recurring', (req, res) => {
    const { phoneNumber, frequency, time = '09:00', endDate } = req.body;
    
    if (!phoneNumber || !frequency) {
        return res.status(400).json({ error: 'Phone number and frequency required' });
    }
    
    try {
        const result = scheduleRecurringCalls(phoneNumber, frequency, time, endDate);
        
        res.json({
            success: true,
            callId: result.callId,
            message: `Recurring ${frequency} calls scheduled`
        });

    } catch (error) {
        res.status(500).json({
            error: 'Failed to schedule recurring call',
            details: error.message
        });
    }
});

// Get all scheduled calls
app.get('/scheduled-calls', (req, res) => {
    const calls = scheduledCalls.map(({ id, phoneNumber, scheduledTime, frequency, time }) => ({
        id,
        phoneNumber,
        frequency,
        time,
    }));
    res.json({ calls });
});

// Pain correction: compute actual pain from timeseries (mood, physical condition, reported pain, baseline)
// POST body: { timeseries: [{ date?, mood, physicalCondition, painRating }], options?: { baseline?, kMood?, kPhysical?, alphaCorrected? } }
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

async function makeTwilioCall(phoneNumber) {
    try {
        const serverUrl = PUBLIC_BASE_URL;
        
        const call = await client.calls.create({
            url: `${serverUrl}/voice`,
            to: phoneNumber,
            from: twilioPhoneNumber,
            statusCallback: `${serverUrl}/call-status`,  // ← Add this
            statusCallbackEvent: ['completed']           // ← Add this
        });
        
        console.log(`Call initiated: ${call.sid}`);
        
        return { 
            success: true, 
            callSid: call.sid,
            message: 'Call initiated - AI conversation started!'
        };
    } catch (error) {
        console.error('Error making call:', error);
        throw error;
    }
}

// TWILIO WEBHOOK: Auto-schedule when call ends
app.post('/call-status', async (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const phoneNumber = req.body.From; // Patient's phone number
    
    console.log(`Call ${callSid} status: ${callStatus}`);
    
    if (callStatus === 'completed') {
        const conversationData = conversations.get(callSid);

        if (conversationData && conversationData.length > 0) {
            const transcriptString = conversationData.map(entry =>
                `${entry.speaker}: ${entry.message}`
            ).join('\n');

            // Save to DB only when call has ended: one doc = JSON array of [bot question, user response] tuples
            // const pairs = conversationToQAPairs(conversationData);
            if (transcriptCollection && conversationData.length > 0) {
                (async () => {
                    try {
                        //const keywords = await extractKeywordsFromTranscript(transcriptString);
                        await transcriptCollection.add({
                            ids: [`transcript_${callSid}_${Date.now()}`],
                            documents: [JSON.stringify(conversationData)],
                            metadatas: [{
                                callSid,
                                created_at: new Date().toISOString(),
                                //created_at_ts: Date.now(),
                                //pair_count: conversationData.length,
                                //keywords: keywords.join(', ')
                                pain_rating,
                                pain_phrases,
                                body_parts,
                                body_part_phrases,
                                daily_mood,
                                estimated_health_metrics
                            }]
                        });
                        console.log(`[${callSid}] Saved to ChromaDB on call end (${conversationData.length} Q&A pairs)`);
                    } catch (err) {
                        console.warn('ChromaDB save failed:', err.message);
                    }
                })();
            }

            console.log('Call completed. Auto-scheduling follow-up...');
            autoScheduleFromTranscript(transcriptString, phoneNumber, scheduleRecurringCalls)
                .then(result => {
                    console.log('Auto-scheduled:', result);
                })
                .catch(error => {
                    console.error('Auto-scheduling failed:', error.message);
                });

            conversations.delete(callSid);
        }
    }

    res.sendStatus(200);
});

//get future calls based on current rules
app.get('/all-future-calls', (req, res) => {
    // Flatten the list of lists into one array
    const allCalls = callList.flat();
    res.json({ 
        calls: allCalls.sort((a, b) => 
            new Date(a.scheduledTime) - new Date(b.scheduledTime)
        )
    });
});

//Schedule the next 30 calls based on cron rule
function getFutureCalls(schedule, limit = 30) {
    const calls = [];
    const [hours, minutes] = schedule.time.split(':');
    const now = new Date();
    const endDate = schedule.endDate ? new Date(schedule.endDate) : null;
    
    let currentDate = new Date();
    currentDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    // If today's call time has passed, start from tomorrow
    if (currentDate <= now) {
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    while (calls.length < limit) {
        // Check if we've passed the end date
        if (endDate && currentDate > endDate) break;
        
        // For weekly, only include Mondays
        if (schedule.frequency === 'weekly' && currentDate.getDay() !== 1) {
            currentDate.setDate(currentDate.getDate() + 1);
            continue;
        }
        
        calls.push({
            phoneNumber: schedule.phoneNumber,
            scheduledTime: new Date(currentDate),
            frequency: schedule.frequency,
            scheduleId: schedule.id
        });
        
        // Move to next occurrence
        if (schedule.frequency === 'daily') {
            currentDate.setDate(currentDate.getDate() + 1);
        } else if (schedule.frequency === 'weekly') {
            currentDate.setDate(currentDate.getDate() + 7);
        }
    }
    
    return calls;
}

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let callSid = url.searchParams.get('callSid') || null;

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    const event = data.event;

    if (event === 'start') {
      callSid = data?.start?.callSid || callSid;
      const streamSid = data?.start?.streamSid;

      if (callSid) {
        const s = mediaSessions.get(callSid) || {
          callSid,
          wsConnected: true,
          startedAt: Date.now(),
          lastMediaAt: null,
          mediaFrames: 0,
          streamSid: null
        };

        s.wsConnected = true;
        s.streamSid = streamSid || s.streamSid;
        mediaSessions.set(callSid, s);

        console.log(`[${callSid}] Media Stream started (streamSid=${streamSid || 'n/a'})`);
      }
      return;
    }

    if (event === 'media') {
      if (!callSid) return;

      const s = mediaSessions.get(callSid) || {
        callSid,
        wsConnected: true,
        startedAt: Date.now(),
        lastMediaAt: null,
        mediaFrames: 0,
        streamSid: null
      };

      s.mediaFrames += 1;
      s.lastMediaAt = Date.now();
      mediaSessions.set(callSid, s);

      if (s.mediaFrames % 100 === 0) {
        console.log(`[${callSid}] Received ${s.mediaFrames} audio frames`);
      }
      return;
    }

    if (event === 'stop') {
      if (callSid) console.log(`[${callSid}] Media Stream stopped`);
      return;
    }
  });

  ws.on('close', () => {
    if (callSid && mediaSessions.has(callSid)) {
      const s = mediaSessions.get(callSid);
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

// Get AI follow-up question (keeping this for web interface)
/*app.post('/get-followup', async (req, res) => {
    const { query } = req.body;
    
    if (!query) {
        return res.status(400).json({ error: 'Query is required' });
    }
    
    try {
        const followUpQuestion = await generateFollowUpQuestion(query);
        
        res.json({
            success: true,
            followUpQuestion: followUpQuestion
        });
    } catch (error) {
        console.error('Error generating follow-up:', error);
        res.status(500).json({ 
            error: 'Failed to generate follow-up question',
            details: error.message 
        });
    }
});*/

// Schedule one-time call
// Request format-- phoneNumber: '[number]', scheduledTime: '[YYYY-MM-DDTHH:MM:SS]' (ISO format)
/*app.post('/schedule-call', (req, res) => {
    const { phoneNumber, scheduledTime } = req.body;
    const scheduledDate = new Date(scheduledTime);
    const cronTime = `${scheduledDate.getMinutes()} ${scheduledDate.getHours()} ${scheduledDate.getDate()} ${scheduledDate.getMonth() + 1} *`;
    
    const task = cron.schedule(cronTime, async () => {
        await makeTwilioCall(phoneNumber);
        task.stop();
    });

    const callId = `one-time-${Date.now()}`;
    
    scheduledCalls.push({
        id: callId,
        phoneNumber,
        scheduledTime: scheduledTime,
        task
    });

    res.json({ success: true, message: 'Call scheduled' });
});*/