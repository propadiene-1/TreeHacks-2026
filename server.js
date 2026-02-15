const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');  //node-cron for scheduling
const { ChromaClient } = require('chromadb');
require('dotenv').config();

const app = express();
const port = 3000;

// ChromaDB for persisting transcripts
const chroma = new ChromaClient({ port: 8000 });
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
const { generateFollowUpQuestion, extractKeywordsFromTranscript } = require('./medsek-chat');
const scheduledCalls = [];

// Store conversation transcripts by CallSid
const conversations = new Map();

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
    const initialGreeting = "Hello! I'm here to chat with you. What would you like to talk about?";
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
        action: '/handle-speech',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US'
    });
    
    // If user doesn't say anything, prompt them
    twiml.say({ voice: 'alice' }, 'Are you still there?');
    
    // Redirect back to keep the conversation going
    twiml.redirect('/voice');
    
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
    
    // Add user's speech to transcript
    conversations.get(callSid).push({
        speaker: 'User',
        message: userSpeech,
        timestamp: new Date().toISOString()
    });
    
    // Get the full conversation transcript
    const transcript = conversations.get(callSid);
    
    // Format transcript as a string for the AI
    const transcriptString = transcript.map(entry => 
        `${entry.speaker}: ${entry.message}`
    ).join('\n');
    
    console.log(`\n--- Full Transcript for ${callSid} ---`);
    console.log(transcriptString);
    console.log('--- End Transcript ---\n');

    // Save transcript to ChromaDB in background (async, does not block follow-up question)
    if (transcriptCollection && transcriptString) {
        const transcriptLen = transcript.length;
        (async () => {
            try {
                const keywords = await extractKeywordsFromTranscript(transcriptString);
                const id = `transcript_${callSid}_${Date.now()}`;
                const created_at = new Date().toISOString();
                await transcriptCollection.add({
                    ids: [id],
                    documents: [transcriptString],
                    metadatas: [{
                        callSid,
                        created_at,
                        created_at_ts: Date.now(),
                        turn_count: transcriptLen,
                        keywords: keywords.join(', ')
                    }]
                });
                console.log(`[${callSid}] Saved transcript to ChromaDB (${transcriptLen} turns, keywords: ${keywords.join(', ') || 'none'})`);
            } catch (err) {
                console.warn('ChromaDB save failed:', err.message);
            }
        })();
    }

    try {
        // Get AI response based on full conversation
        const aiResponse = await generateFollowUpQuestion(transcriptString);
        
        console.log(`[${callSid}] AI responds: ${aiResponse}`);
        
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

// Get AI follow-up question (keeping this for web interface)
app.post('/get-followup', async (req, res) => {
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
});

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

// Schedule recurring calls
// Request format-- phoneNumber: '[number]', frequency: 'daily' or 'weekly', time: 'HH:MM', endDate: 'YYYY-MM-DDTHH:MM:SS'
app.post('/schedule-recurring', (req, res) => {
    const { phoneNumber, frequency, time='09:00' , endDate='2028-05-10T10:00:00'} = req.body; //default time + endDate
    
    if (!phoneNumber || !frequency) {
        return res.status(400).json({ error: 'Phone number and frequency required' });
    }
    
    try {
        const [hours, minutes] = time.split(':');

        let cronExpression; //hold cron string
    
        switch(frequency) { //basically if-else
            case 'daily':
                cronExpression = `${minutes} ${hours} * * *`;
                break;
            case 'weekly':
                cronExpression = `${minutes} ${hours} * * 1`;  //default to every monday
                break;
            default:
                return res.status(400).json({ error: 'Invalid frequency. Use: daily or weekly' });
        }

        //recurring const containing info
        const callId = `recurring-${Date.now()}`;

        const task = cron.schedule(cronExpression, async () => {
            console.log(`Making recurring call to ${phoneNumber}`);

            //stop all calls after end date
            if (endDate) {
                const now = new Date();
                const end = new Date(endDate);
                
                if (now > end) {
                    console.log(`End date reached for ${phoneNumber}. Stopping calls.`);
                    task.stop();
                    
                    // Remove from scheduledCalls array
                    const index = scheduledCalls.findIndex(c => c.id === callId);
                    if (index > -1) scheduledCalls.splice(index, 1);
                    
                    return;  // Don't make the call
                }
            }
            
            try {
                const result = await makeTwilioCall(phoneNumber);   //make calls on schedule
                console.log(`Recurring call initiated: ${result.callSid}`);
            } catch (error) {
                console.error(`Failed to make recurring call: ${error.message}`);
            }
        });

        scheduledCalls.push({
            id: callId,
            phoneNumber,
            frequency,
            time,
            endDate: endDate || null,
            task
        });

        res.json({
            success: true,
            callId,
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

async function makeTwilioCall(phoneNumber) {
    try {
        const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
        
        const call = await client.calls.create({
            url: `${serverUrl}/voice`,
            to: phoneNumber,
            from: twilioPhoneNumber
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

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});