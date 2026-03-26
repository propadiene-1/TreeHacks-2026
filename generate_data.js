// scripts/populate-chroma.js - Standalone script to populate ChromaDB with fake medical call transcripts
const { CloudClient } = require('chromadb');
require('dotenv').config();

async function generateFakeTranscript(turns = 5) {
    const greetings = ["Hello! How are you feeling today?", "Hi there, what's on your mind?", "Hey! Ready to chat?"];
    const userResponses = [
        "I'm feeling a bit anxious about work",
        "My stomach has been hurting lately", 
        "I have a headache that won't go away",
        "I've been really tired all the time",
        "My chest feels tight sometimes",
        "I can't sleep well at night",
        "My joints have been aching"
    ];
    const aiFollowups = [
        "Can you tell me more about when the anxiety started?",
        "How long has your stomach been hurting?",
        "On a scale of 1-10, how bad is the headache?",
        "Have you noticed any patterns with the tiredness?",
        "Does the chest tightness come with shortness of breath?",
        "What time do you usually go to bed?",
        "Which joints are most affected?"
    ];

    let transcript = [];
    transcript.push({ speaker: 'AI', message: greetings[Math.floor(Math.random() * greetings.length)] });
    
    for (let i = 0; i < turns; i++) {
        transcript.push({ speaker: 'User', message: userResponses[Math.floor(Math.random() * userResponses.length)] });
        transcript.push({ speaker: 'AI', message: aiFollowups[Math.floor(Math.random() * aiFollowups.length)] });
    }
    
    return transcript.map(entry => `${entry.speaker}: ${entry.message}`).join('\n');
}

async function generateKeywords(transcript) {
    const keywordMap = {
        'anxious': ['anxiety', 'stress'],
        'stomach': ['stomach pain', 'digestive'],
        'headache': ['headache', 'migraine'],
        'tired': ['fatigue', 'exhaustion'],
        'chest': ['chest pain', 'cardiac'],
        'sleep': ['insomnia', 'sleep disorder'],
        'joints': ['arthritis', 'joint pain']
    };
    
    const words = transcript.toLowerCase().split(/\W+/);
    const foundKeywords = new Set();
    
    for (const word of words) {
        for (const [key, tags] of Object.entries(keywordMap)) {
            if (word.includes(key) && foundKeywords.size < 4) {
                tags.forEach(tag => foundKeywords.add(tag));
            }
        }
    }
    
    return Array.from(foundKeywords);
}

async function populateChroma() {
    console.log('🧬 Connecting to ChromaDB...');
    
    // Matches your server.js config (local port 8000)
    const chroma = new CloudClient({
        apiKey: process.env.CHROMA_API_KEY,
        tenant: process.env.CHROMA_TENANT,
        database: 'second'
        });
    const collection = await chroma.getOrCreateCollection({
        name: 'call_transcripts',
        metadata: { 'hnsw:space': 'cosine' }
    });

    const initialCount = await collection.count();
    console.log(`📊 Current collection size: ${initialCount}`);

    // Generate 25 fake transcripts
    const fakeData = [];
    for (let i = 0; i < 25; i++) {
        const turns = Math.floor(Math.random() * 4) + 3; // 3-6 turns
        const transcriptString = await generateFakeTranscript(turns);
        const keywords = await generateKeywords(transcriptString);
        const callSid = `fake_call_${Date.now() - Math.floor(Math.random() * 1000000)}`;
        
        fakeData.push({
            id: `fake_transcript_${i}_${Date.now()}`,
            document: transcriptString,
            metadata: {
                callSid,
                created_at: new Date().toISOString(),
                created_at_ts: Date.now(),
                turn_count: turns * 2 + 1, // AI greeting + user/AI pairs
                keywords: keywords.join(', ')
            }
        });
        
        console.log(`📝 Generated ${i+1}/25: CallSid=${callSid.slice(-8)}, Keywords=${keywords.join(', ')}`);
    }

    // Batch insert
    console.log('\n💾 Adding to ChromaDB...');
    await collection.add({
        ids: fakeData.map(d => d.id),
        documents: fakeData.map(d => d.document),
        metadatas: fakeData.map(d => d.metadata)
    });

    const finalCount = await collection.count();
    console.log(`✅ Populated! Total transcripts: ${finalCount} (+${finalCount - initialCount})`);

    // Test query
    console.log('\n🔍 Testing query: "anxiety"');
    const results = await collection.query({
        nResults: 3,
        queryTexts: ["can you access all records referring to mental illness"],
        include: ['metadatas', 'documents']
    });
    
    results.metadatas[0].forEach((meta, i) => {
        console.log(`  ${i+1}. ${meta.keywords} (${meta.turn_count} turns)`);
    });
}

populateChroma().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
