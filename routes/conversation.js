const express = require('express');
const twilio = require('twilio');
const { CloudClient } = require('chromadb');
const { generateFollowUpQuestion, autoScheduleFromTranscript, extractKeywordsFromTranscript } = require('./../openai-calls');
const { scheduleRecurringCalls } = require('./schedule');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const chroma = new CloudClient({
    apiKey: process.env.CHROMA_API_KEY,
    tenant: process.env.CHROMA_TENANT,
    database: 'second'
});

let transcriptCollection;
const conversations = new Map();

(async () => {
    try {
        transcriptCollection = await chroma.getOrCreateCollection({
            name: 'call_transcripts',
            metadata: { 'hnsw:space': 'cosine' }
        });
        console.log('ChromaDB ready');
    } catch (err) {
        console.warn('ChromaDB unavailable:', err.message);
    }
})();

// Start conversation
app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    const greeting = "Hello! I'm here to chat with you. What would you like to talk about?";
    conversations.set(callSid, [{ speaker: 'AI', message: greeting, timestamp: new Date().toISOString() }]);
    
    twiml.say({ voice: 'alice' }, greeting);
    twiml.gather({
        input: 'speech',
        action: '/handle-speech',
        speechTimeout: 'auto',
        language: 'en-US'
    });
    twiml.say({ voice: 'alice' }, 'Are you still there?');
    twiml.redirect('/voice');
    
    res.type('text/xml').send(twiml.toString());
});

// Handle conversation
app.post('/handle-speech', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { SpeechResult: userSpeech, CallSid: callSid } = req.body;
    
    if (!conversations.has(callSid)) conversations.set(callSid, []);
    
    conversations.get(callSid).push({ speaker: 'User', message: userSpeech, timestamp: new Date().toISOString() });
    
    const transcript = conversations.get(callSid).map(e => `${e.speaker}: ${e.message}`).join('\n');
    
    try {
        const aiResponse = await generateFollowUpQuestion(transcript);
        conversations.get(callSid).push({ speaker: 'AI', message: aiResponse, timestamp: new Date().toISOString() });
        twiml.say({ voice: 'alice' }, aiResponse);
    } catch (error) {
        const fallback = ["Hi", "Hello", "Hola"][Math.floor(Math.random() * 3)];
        twiml.say({ voice: 'alice' }, fallback);
    }
    
    twiml.gather({
        input: 'speech',
        action: '/handle-speech',
        speechTimeout: 'auto',
        language: 'en-US'
    });
    twiml.say({ voice: 'alice' }, 'I am listening.');
    twiml.redirect('/handle-speech');
    
    res.type('text/xml').send(twiml.toString());
});

// Call completed - save and schedule
app.post('/call-status', async (req, res) => {
    const { CallSid: callSid, CallStatus: status, From: phoneNumber } = req.body;
    
    if (status === 'completed' && conversations.has(callSid)) {
        const conversationData = conversations.get(callSid);
        const transcript = conversationData.map(e => `${e.speaker}: ${e.message}`).join('\n');
        
        // Save to ChromaDB
        if (transcriptCollection) {
            try {
                const keywords = await extractKeywordsFromTranscript(transcript);
                await transcriptCollection.add({
                    ids: [`transcript_${callSid}_${Date.now()}`],
                    documents: [JSON.stringify(conversationData)],
                    metadatas: [{
                        callSid,
                        created_at: new Date().toISOString(),
                        keywords: keywords.join(', ')
                    }]
                });
                console.log(`Saved ${callSid} to ChromaDB`);
            } catch (err) {
                console.warn('ChromaDB save failed:', err.message);
            }
        }
        
        // Auto-schedule follow-up
        autoScheduleFromTranscript(transcript, phoneNumber, scheduleRecurringCalls)
            .then(r => console.log('Auto-scheduled:', r))
            .catch(e => console.error('Scheduling failed:', e.message));
        
        conversations.delete(callSid);
    }
    
    res.sendStatus(200);
});

// View transcripts
app.get('/transcript/:callSid', (req, res) => {
    const transcript = conversations.get(req.params.callSid);
    if (!transcript) return res.status(404).json({ error: 'Not found' });
    
    const html = `<h1>Call ${req.params.callSid}</h1>` + 
        transcript.map(e => `<p><strong>${e.speaker}:</strong> ${e.message}</p>`).join('');
    res.send(html);
});

app.get('/transcripts', (req, res) => {
    res.json(Object.fromEntries(conversations));
});

module.exports = app;

if (require.main === module) {
    app.listen(3001, () => console.log('Conversation handler running on :3001'));
}