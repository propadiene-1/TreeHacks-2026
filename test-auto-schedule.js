const { autoScheduleFromTranscript } = require('./openai-calls');

// Fake transcript
const fakeTranscript = `AI: Hello! I'm here to chat with you. What would you like to talk about?
User: I've been having severe chest pain and shortness of breath for the past 3 days.
AI: Can you describe the pain? Is it sharp, dull, or crushing?
User: It's a crushing pain, and I feel dizzy too. I'm available mornings around 9 AM.
AI: Have you experienced this before?
User: No, this is the first time. It's really worrying me.`;

// Fake scheduling function (just prints, doesn't actually schedule)
function fakeScheduleFunction(phoneNumber, frequency, time, endDate) {
    console.log('\n🗓️  WOULD SCHEDULE:');
    console.log('   Phone:', phoneNumber);
    console.log('   Frequency:', frequency);
    console.log('   Time:', time);
    console.log('   End Date:', endDate);
    
    return { success: true, callId: `fake-${Date.now()}` };
}

// Run the test
async function test() {
    console.log('🧪 Testing auto-schedule from transcript...\n');
    console.log('Transcript:');
    console.log(fakeTranscript);
    console.log('\n---\n');
    
    try {
        const result = await autoScheduleFromTranscript(
            fakeTranscript,
            '+15551234567',
            fakeScheduleFunction
        );
        
        console.log('\n✅ SUCCESS!');
        console.log('Result:', JSON.stringify(result, null, 2));
        
    } catch (error) {
        console.error('\n❌ FAILED:', error.message);
        console.error(error);
    }
}

test();