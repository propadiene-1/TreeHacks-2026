const { CloudClient } = require('chromadb');
require('dotenv').config();

// Connect to ChromaDB (same as your server.js)
const client = new CloudClient({
    apiKey: process.env.CHROMA_API_KEY,
    tenant: process.env.CHROMA_TENANT,
    database: 'second'
});

async function viewAllData() {
    try {
        // Step 1: Get the collection (this is your "table")
        const collection = await client.getCollection({
            name: 'call_transcripts'  // ← Your table name
        });
        
        console.log('Connected to collection: call_transcripts\n');
        
        // Step 2: Get ALL rows from the collection
        const allData = await collection.get();
        
        console.log(`Total rows: ${allData.ids.length}\n`);
        console.log('='.repeat(80));
        
        // Step 3: Iterate through each row
        for (let i = 0; i < allData.ids.length; i++) {
            const id = allData.ids[i];                // Row ID
            const document = allData.documents[i];    // Document content (transcript)
            const metadata = allData.metadatas[i];    // Metadata (columns)
            
            console.log(`\nROW ${i + 1}/${allData.ids.length}`);
            console.log('─'.repeat(80));
            console.log('ID:', id);
            console.log('Metadata:', JSON.stringify(metadata, null, 2));
            console.log('Document (first 200 chars):', document.substring(0, 200) + '...');
            console.log('─'.repeat(80));
        }
        
        console.log('\nDone!');
        
    } catch (error) {
        console.error('Error:', error.message);
        console.error(error);
    }
}

viewAllData();