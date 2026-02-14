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
const scheduledCalls = [];

// Endpoint to make a call
app.post('/make-call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    } else{
        makeTwilioCall(phoneNumber);
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

// Schedule one-time call
app.post('/schedule-call', (req, res) => {
    const { phoneNumber, scheduledTime } = req.body;
    const scheduledDate = new Date(scheduledTime);
    
    const cronTime = `${scheduledDate.getMinutes()} ${scheduledDate.getHours()} ${scheduledDate.getDate()} ${scheduledDate.getMonth() + 1} *`;
    
    const task = cron.schedule(cronTime, async () => {
        await makeTwilioCall(phoneNumber);
        task.stop();
    });
    
    res.json({ success: true, message: 'Call scheduled' });
});

// Schedule recurring calls
app.post('/schedule-recurring', (req, res) => {
    const { phoneNumber, frequency, time } = req.body;
    
    if (!phoneNumber || !frequency) {
        return res.status(400).json({ error: 'Phone number and frequency required' });
    }
    
    try {
        //const callId = scheduleRecurringCall(phoneNumber, frequency, time);

        const [hours, minutes] = time.split(':');

        let cronExpression;
    
        //basically if-else
        switch(frequency) {
            case 'hourly':
                cronExpression = '0 * * * *';
                break;
            case 'daily':
                cronExpression = `${minutes} ${hours} * * *`;
                break;
            case 'weekly':
                cronExpression = `${minutes} ${hours} * * 1`;  // Every Monday
                break;
            default:
                return res.status(400).json({ error: 'Invalid frequency. Use: hourly, daily, or weekly' });
        }

        const task = cron.schedule(cronExpression, async () => {
            console.log(`Making recurring call to ${phoneNumber}`);
            
            try {
                const result = await makeTwilioCall(phoneNumber);
                console.log(`Recurring call initiated: ${result.callSid}`);
            } catch (error) {
                console.error(`Failed to make recurring call: ${error.message}`);
            }
        });

        //recurring const containing info
        const callId = `recurring-${Date.now()}`;
            scheduledCalls.push({
            id: callId,
            phoneNumber,
            frequency,
            time,
            task
        });

        res.json({
            success: true,
            callId,
            message: `Recurring ${frequency} calls scheduled`
        });

    } catch (error) {
        res.status(500).json({
            error: 'Failed to schedule recurring call',
            details: error.message
        });
    }
});

// Get all scheduled calls
app.get('/scheduled-calls', (req, res) => {
    const calls = getScheduledCalls();
    res.json({ calls });
});

async function makeTwilioCall(phoneNumber){
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
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});