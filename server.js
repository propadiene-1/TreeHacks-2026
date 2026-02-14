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

// Endpoint to make a call
app.post('/make-call', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }
    
    try {
        const call = await client.calls.create({
            url: 'http://demo.twilio.com/docs/voice.xml', // TwiML URL for what to say
            to: phoneNumber,
            from: twilioPhoneNumber
        });
        
        res.json({ 
            success: true, 
            callSid: call.sid,
            message: 'Call initiated successfully'
        });
    } catch (error) {
        console.error('Error making call:', error);
        res.status(500).json({ 
            error: 'Failed to initiate call',
            details: error.message 
        });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});