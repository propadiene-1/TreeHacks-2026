const { ChromaClient } = require('chromadb');
const client = new ChromaClient({
    apiKey: process.env.CHROMA_API_KEY,
    tenant: process.env.CHROMA_TENANT,
    database: 'second'
});

/**
 * Store extracted medical features in ChromaDB
 * @param {string} callSid - Unique call identifier
 * @param {string} transcript - Full conversation transcript (as string)
 * @param {Object} extractedFeatures - Output from extractDBColumns()
 */
async function storeMedicalSession(callSid, transcript, extractedFeatures) {
    try {
        const collectionName = 'call_transcripts';
        
        const collection = await client.getOrCreateCollection({
            name: collectionName
        });
        
        // ChromaDB metadata (arrays must be stringified)
        const metadata = {
            // Basic info
            phoneNumber: extractedFeatures.phoneNumber,
            timestamp: extractedFeatures.timestamp,
            
            // Pain data
            pain_rating: extractedFeatures.pain_rating,  // number or null
            pain_phrases: JSON.stringify(extractedFeatures.pain_phrases || []),
            
            // Body parts
            body_parts: JSON.stringify(extractedFeatures.body_parts || []),
            body_part_phrases: JSON.stringify(extractedFeatures.body_part_phrases || []),
            
            // Mood
            daily_mood: extractedFeatures.daily_mood || '',
            
            // Health metrics (stringify the whole object since structure may vary)
            estimated_health_metrics: JSON.stringify(extractedFeatures.estimated_health_metrics || {})
        };
        
        // Store in ChromaDB
        await collection.add({
            ids: [callSid],
            documents: [transcript],
            metadatas: [metadata]
        });
        
        console.log(`Stored medical session ${callSid} to ChromaDB`);
        
        return { success: true, callSid, collection: collectionName };
        
    } catch (error) {
        console.error('Failed to store to ChromaDB:', error);
        throw error;
    }
}

module.exports = { storeMedicalSession };