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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chroma = new CloudClient({
    apiKey: process.env.CHROMA_API_KEY,
    tenant: process.env.CHROMA_TENANT,
    database: 'second'
});

let transcriptCollection;
const conversations = new Map();
const symptomQueue = new Map();
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

async function callOpenAI(systemPrompt, userPrompt) {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3
    });
    return JSON.parse(response.choices[0].message.content);
}

async function consolidateSymptoms(symptoms) {
    if (symptoms.length === 0) return [];
    const existing = Array.from(symptomQueue.keys());
    
    try {
        const result = await callOpenAI(
            'Consolidate duplicate/similar symptoms. Examples: "headache", "head pain" → "headache". Return JSON: {"consolidated": [{"original": "x", "canonical": "y"}]}',
            `New: ${symptoms.join(', ')}\nExisting: ${existing.join(', ')}`
        );
        
        const mapping = new Map();
        result.consolidated?.forEach(({ original, canonical }) => 
            mapping.set(original.toLowerCase(), canonical.toLowerCase())
        );
        
        return symptoms.map(s => mapping.get(s.toLowerCase()) || s.toLowerCase());
    } catch (error) {
        console.error('Consolidation failed:', error.message);
        return symptoms.map(s => s.toLowerCase());
    }
}

async function extractSymptomsFromTranscript(transcript) {
    try {
        const result = await callOpenAI(
            'Extract medical symptoms only. Return JSON: {"symptoms": ["symptom1", "symptom2"]}',
            `Extract symptoms from:\n${transcript}`
        );
        return await consolidateSymptoms(result.symptoms || []);
    } catch (error) {
        console.error('Symptom extraction failed:', error.message);
        return [];
    }
}

async function updateSymptomFrequencies(symptoms, transcript) {
    if (symptoms.length === 0) return;

    const existingSymptoms = Array.from(symptomQueue.entries()).map(([symptom, data]) => ({
        symptom, ...data
    }));

    try {
        const result = await callOpenAI(
            `Determine check-in frequencies: Severe 1-3 days, Moderate 7 days, Mild 14 days, Resolved 21-30 days. Return JSON: {"symptoms": [{"name": "x", "frequency": 7, "summary": "y"}]}`,
            `Conversation:\n${transcript}\n\nSymptoms: ${symptoms.join(', ')}\n\nExisting:\n${JSON.stringify(existingSymptoms, null, 2)}`
        );

        const now = new Date().toISOString();
        result.symptoms?.forEach(({ name, frequency, summary }) => {
            const canonical = name.toLowerCase();
            const existing = symptomQueue.get(canonical);
            const historyEntry = `[${new Date().toLocaleDateString()}] ${summary || 'Mentioned'}`;
            
            symptomQueue.set(canonical, {
                frequency: frequency || 7,
                lastChecked: now,
                history: existing ? `${existing.history}\n${historyEntry}` : historyEntry
            });
        });

        rebuildDailySchedule();
    } catch (error) {
        console.error('Frequency update failed:', error.message);
    }
}

function rebuildDailySchedule() {
    dailySchedule = Array.from({ length: 32 }, () => []);
    const now = new Date();
    
    symptomQueue.forEach((data, symptom) => {
        const lastChecked = new Date(data.lastChecked);
        const nextCheck = new Date(lastChecked.getTime() + data.frequency * 30 * 1000);
        const secondsUntil = (nextCheck - now) / 1000;
        const daysUntil = Math.floor(secondsUntil / 30);
        const dayIndex = Math.max(0, Math.min(31, daysUntil));
        
        dailySchedule[dayIndex].push({
            symptom,
            frequency: data.frequency,
            lastChecked: data.lastChecked,
            daysUntil,
            history: data.history
        });
    });
    
    printSymptomQueue();
}

function printSymptomQueue() {
    console.log('\n========== SYMPTOM PRIORITY QUEUE ==========');
    Array.from(symptomQueue.entries())
        .sort((a, b) => a[1].frequency - b[1].frequency)
        .forEach(([symptom, data]) => {
            console.log(`📋 ${symptom.toUpperCase()}`);
            console.log(`   Frequency: Every ${data.frequency} day(s)`);
            console.log(`   Last Checked: ${new Date(data.lastChecked).toLocaleString()}`);
            console.log(`   History: ${data.history.split('\n').pop()}\n`);
        });
    
    console.log('========== DAILY SCHEDULE (0-31 DAYS) ==========');
    dailySchedule.forEach((items, dayIndex) => {
        if (items.length > 0) {
            const label = dayIndex === 0 ? 'TODAY/OVERDUE' : dayIndex === 1 ? 'TOMORROW' : `DAY ${dayIndex}`;
            console.log(`\n📅 ${label}:`);
            items.forEach(item => {
                console.log(`   • ${item.symptom} (every ${item.frequency} days)`);
                if (item.daysUntil < 0) console.log(`     ⚠️  OVERDUE by ${Math.abs(item.daysUntil)} days`);
            });
        }
    });
    console.log('\n==============================================\n');
}

function buildSymptomContext() {
    if (symptomQueue.size === 0) return "No previous symptoms tracked.";
    
    let context = "PATIENT SYMPTOM HISTORY:\n\n";
    const dueToday = dailySchedule[0] || [];
    
    if (dueToday.length > 0) {
        context += "⚠️ SYMPTOMS TO CHECK TODAY:\n";
        dueToday.forEach(item => {
            context += `- ${item.symptom.toUpperCase()}: ${item.history.split('\n').pop()}\n`;
        });
        context += "\n";
    }
    
    context += "ALL TRACKED SYMPTOMS:\n";
    Array.from(symptomQueue.entries()).forEach(([symptom, data]) => {
        context += `\n• ${symptom.toUpperCase()}: Every ${data.frequency} days\n`;
        context += `  Recent: ${data.history.split('\n').slice(-2).join('\n  ')}\n`;
    });
    
    return context;
}

app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const greeting = "Hello! I'm here to chat with you. What would you like to talk about?";
    
    conversations.set(req.body.CallSid, [{ speaker: 'AI', message: greeting, timestamp: new Date().toISOString() }]);
    
    twiml.say({ voice: 'alice' }, greeting);
    twiml.gather({ input: 'speech', action: '/handle-speech', speechTimeout: 'auto', language: 'en-US' });
    twiml.say({ voice: 'alice' }, 'Are you still there?');
    twiml.redirect('/voice');
    
    res.type('text/xml').send(twiml.toString());
});

app.post('/handle-speech', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const { SpeechResult: userSpeech, CallSid: callSid } = req.body;
    
    if (!conversations.has(callSid)) conversations.set(callSid, []);
    
    conversations.get(callSid).push({ speaker: 'User', message: userSpeech, timestamp: new Date().toISOString() });
    
    const transcript = conversations.get(callSid).map(e => `${e.speaker}: ${e.message}`).join('\n');
    const symptomContext = buildSymptomContext();

    try {
        const aiResponse = await generateFollowUpQuestion(transcript, symptomContext);
        conversations.get(callSid).push({ speaker: 'AI', message: aiResponse, timestamp: new Date().toISOString() });
        twiml.say({ voice: 'alice' }, aiResponse);
    } catch (error) {
        console.error('AI error:', error);
        twiml.say({ voice: 'alice' }, 'Hello');
    }
    
    twiml.gather({ input: 'speech', action: '/handle-speech', speechTimeout: 'auto', language: 'en-US' });
    twiml.say({ voice: 'alice' }, 'I am listening.');
    twiml.redirect('/handle-speech');
    
    res.type('text/xml').send(twiml.toString());
});

app.post('/call-status', async (req, res) => {
    const { CallSid: callSid, CallStatus: status, From: phoneNumber } = req.body;
    
    if (status === 'completed' && conversations.has(callSid)) {
        const conversationData = conversations.get(callSid);
        const transcript = conversationData.map(e => `${e.speaker}: ${e.message}`).join('\n');
        
        const symptoms = await extractSymptomsFromTranscript(transcript);
        console.log(`Extracted symptoms from ${callSid}:`, symptoms);
        
        await updateSymptomFrequencies(symptoms, transcript);
        
        if (transcriptCollection) {
            try {
                await transcriptCollection.add({
                    ids: [`transcript_${callSid}_${Date.now()}`],
                    documents: [JSON.stringify(conversationData)],
                    metadatas: [{ callSid, created_at: new Date().toISOString(), symptoms: symptoms.join(', ') }]
                });
                console.log(`Saved ${callSid} to ChromaDB`);
            } catch (err) {
                console.warn('ChromaDB save failed:', err.message);
            }
        }
        
        autoScheduleFromTranscript(transcript, phoneNumber, scheduleRecurringCalls)
            .then(r => console.log('Auto-scheduled:', r))
            .catch(e => console.error('Scheduling failed:', e.message));
        
        conversations.delete(callSid);
    }
    
    res.sendStatus(200);
});

app.get('/symptoms', (req, res) => {
    res.json({ symptoms: Array.from(symptomQueue.entries()).map(([s, d]) => ({ symptom: s, ...d })) });
});

app.get('/schedule', (req, res) => {
    res.json({ schedule: dailySchedule.map((items, day) => ({ day, items })).filter(d => d.items.length > 0) });
});

module.exports = app;

if (require.main === module) {
    app.listen(3001, () => console.log('Conversation handler running on :3001'));
}