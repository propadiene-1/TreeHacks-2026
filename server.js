const express = require('express');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files

// Twilio credentials (store these in .env file)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

const client = twilio(accountSid, authToken);
const { generateFollowUpQuestion } = require('./medsek-chat');

app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    
    twiml.say({ voice: 'alice' }, 'Hello world!');
    
    res.type('text/xml');
    res.send(twiml.toString());
});


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

// Get AI follow-up question (call the module)
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

async function makeTwilioCall(phoneNumber){
    try {
        // You need to get your server's public URL
        // For local testing with ngrok: http://YOUR_NGROK_URL/voice
        // For production: https://your-domain.com/voice
        const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
        
        const call = await client.calls.create({
            url: `${serverUrl}/voice`,  // This tells Twilio what to say
            to: phoneNumber,             // Who to call
            from: twilioPhoneNumber      // Your Twilio number
        });
        
        console.log(`Call initiated: ${call.sid}`);
        
        return { 
            success: true, 
            callSid: call.sid,
            message: 'Call initiated successfully - recipient will hear "Hello world!"'
        };
    } catch (error) {
        console.error('Error making call:', error);
        throw error;
    }

}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});