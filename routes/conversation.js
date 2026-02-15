const express = require('express');
const twilio = require('twilio');
const { CloudClient } = require('chromadb');
const OpenAI = require('openai');
const { generateFollowUpQuestion, autoScheduleFromTranscript } = require('../openai-calls');
const { scheduleRecurringCalls } = require('./schedule');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const chroma = new CloudClient({
    apiKey: process.env.CHROMA_API_KEY,
    tenant: process.env.CHROMA_TENANT,
    database: 'second'
});

let transcriptCollection;
const conversations = new Map();

// SYMPTOM PRIORITY QUEUE
// Structure: { symptom: { frequency: number (days), lastChecked: ISO timestamp, history: string } }
const symptomQueue = new Map();

// DAILY SCHEDULE (0-31 days out)
let dailySchedule = Array.from({ length: 32 }, () => []);

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

// Consolidate duplicate/similar symptoms
async function consolidateSymptoms(symptoms) {
    if (symptoms.length === 0) return [];

    const existingSymptoms = Array.from(symptomQueue.keys());
    
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a medical assistant. Consolidate duplicate or similar symptoms into canonical forms.

Examples:
- "headache", "head pain", "migraine" → "headache"
- "nausea", "feeling sick", "queasy" → "nausea"
- "back pain", "lower back pain" → "back pain"

Return JSON format:
{
  "consolidated": [
    { "original": "original symptom", "canonical": "canonical name" }
  ]
}`
            }, {
                role: 'user',
                content: `New symptoms: $${symptoms.join(', ')}\n\nExisting tracked symptoms: $${existingSymptoms.join(', ')}\n\nConsolidate all symptoms into canonical forms.`
            }],
            response_format: { type: 'json_object' },
            temperature: 0.2
        });

        const result = JSON.parse(response.choices[0].message.content);
        
        // Map original to canonical
        const mapping = new Map();
        if (result.consolidated && Array.isArray(result.consolidated)) {
            result.consolidated.forEach(({ original, canonical }) => {
                mapping.set(original.toLowerCase(), canonical.toLowerCase());
            });
        }

        return symptoms.map(s => mapping.get(s.toLowerCase()) || s.toLowerCase());
    } catch (error) {
        console.error('Consolidation failed:', error.message);
        return symptoms.map(s => s.toLowerCase());
    }
}

// Extract symptoms from transcript using OpenAI
async function extractSymptomsFromTranscript(transcript) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a medical assistant. Extract ONLY medical symptoms mentioned in the conversation as a JSON object as follows:
                {
                "symptoms": ["back pain", "wooziness when standing", "lack of balance", "headache", "shortness of breath"]
                }`
            }, {
                role: 'user',
                content: `Extract all symptoms from this conversation:\n\n${transcript}`
            }],
            response_format: { type: 'json_object' },
            temperature: 0.3
        });

        const result = JSON.parse(response.choices[0].message.content);
        const rawSymptoms = result.symptoms || [];
        
        // Consolidate before returning
        return await consolidateSymptoms(rawSymptoms);
    } catch (error) {
        console.error('Symptom extraction failed:', error.message);
        return [];
    }
}

// Update symptom frequencies based on conversation context
async function updateSymptomFrequencies(symptoms, transcript) {
    if (symptoms.length === 0) return;

    // Build context of existing symptoms with history
    const existingSymptoms = Array.from(symptomQueue.entries()).map(([symptom, data]) => ({
        symptom,
        currentFrequency: data.frequency,
        lastChecked: data.lastChecked,
        history: data.history || 'No previous mentions'
    }));

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a medical assistant determining check-in frequencies for symptoms.
                
Based on the conversation, assign a frequency as a number from 1 to 31 for how often each symptom should be checked that could be something like days. 

Return JSON format:
{
  "symptoms": [
    { "name": "symptom name", "frequency": number_of_days }
  ]
}`
            }, {
                role: 'user',
                content: `Current conversation:\n$${transcript}\n\nSymptoms mentioned: $${symptoms.join(', ')}\n\nExisting symptom tracking:\n${JSON.stringify(existingSymptoms, null, 2)}\n\nDetermine appropriate check-in frequencies and summarize current status.`
            }],
            response_format: { type: 'json_object' },
            temperature: 0.3
        });

        const result = JSON.parse(response.choices[0].message.content);
        const now = new Date().toISOString();

        // Update symptom queue
        if (result.symptoms && Array.isArray(result.symptoms)) {
            result.symptoms.forEach(({ name, frequency, summary }) => {
                const canonicalName = name.toLowerCase();
                const existingData = symptomQueue.get(canonicalName);
                
                // Append to history
                const historyEntry = `[$${new Date().toLocaleDateString()}] $${summary}`;
                const updatedHistory = existingData 
                    ? `$${existingData.history}\n$${historyEntry}`
                    : historyEntry;
                
                symptomQueue.set(canonicalName, {
                    frequency: frequency,
                    lastChecked: now,
                    history: updatedHistory
                });
            });
        }

        // Rebuild daily schedule
        rebuildDailySchedule();

    } catch (error) {
        console.error('Frequency update failed:', error.message);
    }
}

// Rebuild the daily schedule based on symptom queue
function rebuildDailySchedule() {
    // Clear existing schedule
    dailySchedule = Array.from({ length: 32 }, () => []);
    
    const now = new Date();
    
    symptomQueue.forEach((data, symptom) => {
        const lastChecked = new Date(data.lastChecked);
        const nextCheckDate = new Date(lastChecked);
        nextCheckDate.setDate(nextCheckDate.getDate() + data.frequency);
        
        // Calculate days until next check
        const daysUntil = Math.floor((nextCheckDate - now) / (1000 * 60 * 60 * 24));
        
        // Place in appropriate day (0 if overdue, cap at 31)
        const dayIndex = Math.max(0, Math.min(31, daysUntil));
        
        dailySchedule[dayIndex].push({
            symptom,
            frequency: data.frequency,
            lastChecked: data.lastChecked,
            nextCheck: nextCheckDate.toISOString(),
            daysUntil: daysUntil,
            history: data.history
        });
    });
    
    printSymptomQueue();
}

// Print symptom queue and daily schedule
function printSymptomQueue() {
    console.log('\n========== SYMPTOM PRIORITY QUEUE ==========');
    const sortedSymptoms = Array.from(symptomQueue.entries())
        .sort((a, b) => a[1].frequency - b[1].frequency);
    
    sortedSymptoms.forEach(([symptom, data]) => {
        console.log(`📋 ${symptom.toUpperCase()}`);
        console.log(`   Frequency: Every ${data.frequency} day(s)`);
        console.log(`   Last Checked: ${new Date(data.lastChecked).toLocaleString()}`);
        console.log(`   History: ${data.history.split('\n').pop()}`);
        console.log('');
    });
    console.log('============================================\n');
    
    console.log('\n========== DAILY SCHEDULE (0-31 DAYS) ==========');
    dailySchedule.forEach((items, dayIndex) => {
        if (items.length > 0) {
            const dayLabel = dayIndex === 0 
                ? 'TODAY/OVERDUE' 
                : dayIndex === 1 
                ? 'TOMORROW' 
                : `DAY ${dayIndex}`;
            
            console.log(`\n📅 ${dayLabel}:`);
            items.forEach(item => {
                console.log(`   • $${item.symptom} (check every $${item.frequency} days)`);
                if (item.daysUntil < 0) {
                    console.log(`     ⚠️  OVERDUE by ${Math.abs(item.daysUntil)} days`);
                }
            });
        }
    });
    console.log('\n==============================================\n');
}

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
    
    const transcript = conversations.get(callSid).map(e => `$${e.speaker}: $${e.message}`).join('\n');
    
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

// Call completed - save, extract symptoms, update frequencies, and schedule
app.post('/call-status', async (req, res) => {
    const { CallSid: callSid, CallStatus: status, From: phoneNumber } = req.body;
    
    if (status === 'completed' && conversations.has(callSid)) {
        const conversationData = conversations.get(callSid);
        const transcript = conversationData.map(e => `$${e.speaker}: $${e.message}`).join('\n');
        
        // Extract symptoms (with consolidation)
        const symptoms = await extractSymptomsFromTranscript(transcript);
        console.log(`Extracted & consolidated symptoms from call ${callSid}:`, symptoms);
        
        // Update symptom frequencies (rebuilds daily schedule automatically)
        await updateSymptomFrequencies(symptoms, transcript);
        
        // Save to ChromaDB
        if (transcriptCollection) {
            try {
                await transcriptCollection.add({
                    ids: [`transcript_$${callSid}_$${Date.now()}`],
                    documents: [JSON.stringify(conversationData)],
                    metadatas: [{
                        callSid,
                        created_at: new Date().toISOString(),
                        symptoms: symptoms.join(', ')
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
        transcript.map(e => `<p><strong>$${e.speaker}:</strong> $${e.message}</p>`).join('');
    res.send(html);
});

app.get('/transcripts', (req, res) => {
    res.json(Object.fromEntries(conversations));
});

// View symptom queue
app.get('/symptoms', (req, res) => {
    const sortedSymptoms = Array.from(symptomQueue.entries())
        .sort((a, b) => a[1].frequency - b[1].frequency)
        .map(([symptom, data]) => ({
            symptom,
            frequency: data.frequency,
            lastChecked: data.lastChecked,
            history: data.history
        }));
    
    res.json({ symptoms: sortedSymptoms });
});

// View daily schedule
app.get('/schedule', (req, res) => {
    const schedule = dailySchedule.map((items, dayIndex) => ({
        day: dayIndex,
        label: dayIndex === 0 ? 'Today/Overdue' : dayIndex === 1 ? 'Tomorrow' : `Day ${dayIndex}`,
        symptoms: items
    })).filter(day => day.symptoms.length > 0);
    
    res.json({ schedule });
});

module.exports = app;

if (require.main === module) {
    app.listen(3001, () => console.log('Conversation handler running on :3001'));
}