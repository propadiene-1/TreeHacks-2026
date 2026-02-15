const express = require('express');
const cron = require('node-cron');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const scheduledCalls = [];

// Make a single call
app.post('/make-call', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });
    
    try {
        const call = await client.calls.create({
            url: `${process.env.SERVER_URL}/voice`,
            to: phoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
            statusCallback: `${process.env.SERVER_URL}/call-status`,
            statusCallbackEvent: ['completed']
        });
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Schedule recurring calls
function scheduleRecurringCalls(phoneNumber, frequency, time, endDate) {
    const [hours, minutes] = time.split(':');
    const cronExpression = frequency === 'daily' 
        ? `${minutes} ${hours} * * *` 
        : `${minutes} ${hours} * * 1`;
    
    const callId = `recurring-${Date.now()}`;
    
    const task = cron.schedule(cronExpression, async () => {
        if (endDate && new Date() > new Date(endDate)) {
            task.stop();
            scheduledCalls.splice(scheduledCalls.findIndex(c => c.id === callId), 1);
            return;
        }
        
        try {
            await client.calls.create({
                url: `${process.env.SERVER_URL}/voice`,
                to: phoneNumber,
                from: process.env.TWILIO_PHONE_NUMBER,
                statusCallback: `${process.env.SERVER_URL}/call-status`,
                statusCallbackEvent: ['completed']
            });
        } catch (error) {
            console.error('Call failed:', error.message);
        }
    });
    
    scheduledCalls.push({ id: callId, phoneNumber, frequency, time, endDate, task });
    return { success: true, callId };
}

app.post('/schedule-recurring', (req, res) => {
    const { phoneNumber, frequency, time = '09:00', endDate } = req.body;
    if (!phoneNumber || !frequency) return res.status(400).json({ error: 'Missing required fields' });
    
    try {
        const result = scheduleRecurringCalls(phoneNumber, frequency, time, endDate);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/scheduled-calls', (req, res) => {
    res.json({ calls: scheduledCalls.map(({ id, phoneNumber, frequency, time }) => 
        ({ id, phoneNumber, frequency, time }))
    });
});

module.exports = { app, scheduleRecurringCalls };

if (require.main === module) {
    app.listen(3000, () => console.log('Scheduler running on :3000'));
}