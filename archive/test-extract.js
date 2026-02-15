const { extractDBColumns } = require('./openai-calls');

// More ambiguous, realistic transcripts
const testCases = [
    {
        name: "Vague pain description",
        transcript: [
            "AI: Hello! How are you feeling?",
            "User: Not great, something's been off for a while",
            "AI: Can you describe what you're experiencing?",
            "User: I don't know, like my whole left side just feels... wrong? Like heavy and achy",
            "AI: Where exactly on your left side?",
            "User: Kind of my chest area? Or maybe my shoulder? It's hard to tell. Sometimes it moves around",
            "AI: How bad would you say it is?",
            "User: I mean, it's annoying but I can still function, you know?"
        ]
    },
    {
        name: "Mixed signals",
        transcript: [
            "AI: What brings you here today?",
            "User: My stomach has been weird and I keep getting these headaches",
            "AI: Tell me more about the headaches",
            "User: They come and go. Sometimes behind my eyes, sometimes the back of my head",
            "AI: On a scale of 1 to 7, how intense?",
            "User: Oh, uh... depends on the day? Like today it's maybe 4 or 5? But yesterday was worse, probably 6 or 7",
            "AI: And the stomach issues?",
            "User: Just feels uncomfortable after eating. Not really painful, more like bloated or tight"
        ]
    },
    {
        name: "Never asked for rating",
        transcript: [
            "AI: How are you doing?",
            "User: I'm stressed out and my neck has been killing me",
            "AI: How long has your neck been bothering you?",
            "User: Like a week? Maybe longer? I don't even remember when it started",
            "AI: Any other concerns?",
            "User: Well my back hurts too, and I've been sleeping terribly. I just feel run down"
        ]
    },
    {
        name: "Contradictory information",
        transcript: [
            "AI: What symptoms are you experiencing?",
            "User: My knee hurts when I walk",
            "AI: Which knee?",
            "User: The right one. Or wait, maybe it's the left? I think it's both actually",
            "AI: Rate the pain from 1 to 7",
            "User: Hmm, it's not that bad, maybe a 2? But when I bend it, it's more like a 5 or 6",
            "AI: Any swelling?",
            "User: I can't really tell. My ankle looks a bit puffy though"
        ]
    },
    {
        name: "Emotional vs physical",
        transcript: [
            "AI: How can I help you today?",
            "User: Everything just hurts, I don't know where to start",
            "AI: Let's start with what's bothering you most",
            "User: I guess... my head? Or my chest? I've been really anxious and I think that's making everything worse",
            "AI: Describe the chest feeling",
            "User: It's like tight? Or heavy? I don't know if it's real pain or just stress",
            "AI: And your head?",
            "User: Pressure. Like a constant pressure all around my head and temples"
        ]
    }
];

async function runTests() {
    for (const test of testCases) {
        console.log('\n' + '='.repeat(60));
        console.log(`TEST: ${test.name}`);
        console.log('='.repeat(60) + '\n');
        
        try {
            const result = await extractDBColumns(test.transcript, '+15551234567');
            console.log(JSON.stringify(result, null, 2));
        } catch (error) {
            console.error('❌ Error:', error.message);
        }
    }
}

runTests();