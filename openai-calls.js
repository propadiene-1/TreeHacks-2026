// ai-helper.js - OpenAI API integration for generating follow-up questions

const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate follow-up questions based on user's medical query
 * @param {string} userQuery - The initial question or transcript from user
 * @returns {Promise<string>} - AI-generated follow-up question
 */
async function generateFollowUpQuestion(userQuery) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: `A medical patient has stated the following: ${userQuery}. Generate an information-seeking follow-up question without speculating on the patient's condition, with the goal of reporting to a doctor.`
                }
            ],
            max_tokens: 100,
            temperature: 0.7
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('OpenAI API Error:', error);
        throw new Error('Failed to generate follow-up question');
    }
}

/**
 * Auto-schedule follow-up calls from conversation transcript
 * @param {string} transcript - Full conversation transcript
 * @param {string} phoneNumber - Patient's phone number
 * @param {Function} scheduleFunction - scheduleRecurringCalls function from server.js
 */
async function autoScheduleFromTranscript(transcript, phoneNumber, scheduleFunction) {
    try {
        console.log('Auto-scheduling for:', phoneNumber);
        
        // Call OpenAI to determine optimal schedule
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Analyze this medical conversation. Determine the optimal follow-up call schedule based on symptoms severity and patient availability."
                },
                {
                    role: "user",
                    content: `Conversation:\n${transcript}\n\nDetermine follow-up schedule.`
                }
            ],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "schedule_followup_calls",
                        description: "Schedule recurring follow-up calls for patient",
                        parameters: {
                            type: "object",
                            properties: {
                                frequency: {
                                    type: "string",
                                    enum: ["daily", "weekly"],
                                    description: "daily = acute/severe symptoms, weekly = chronic/stable"
                                },
                                time: {
                                    type: "string",
                                    description: "Time in HH:MM (24-hour) based on patient availability, default 09:00"
                                },
                                durationWeeks: {
                                    type: "integer",
                                    minimum: 1,
                                    maximum: 12,
                                    description: "Duration: 1-2 weeks for acute, 4-12 weeks for chronic"
                                },
                                reasoning: {
                                    type: "string",
                                    description: "Brief explanation of schedule choice"
                                }
                            },
                            required: ["frequency", "time", "durationWeeks", "reasoning"]
                        }
                    }
                }
            ],
            tool_choice: { type: "function", function: { name: "schedule_followup_calls" } }
        });

        // Extract schedule from OpenAI
        const toolCall = response.choices[0].message.tool_calls[0];
        const scheduleData = JSON.parse(toolCall.function.arguments);

        console.log('AI determined schedule:', scheduleData);

        // Calculate end date
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + (scheduleData.durationWeeks * 7));
        const endDateString = endDate.toISOString().slice(0, 19);

        // Schedule the calls using the function
        const result = scheduleFunction(
            phoneNumber,
            scheduleData.frequency,
            scheduleData.time,
            endDateString
        );

        console.log('Auto-scheduled successfully:', result.callId);

        return {
            success: true,
            schedule: {
                frequency: scheduleData.frequency,
                time: scheduleData.time,
                endDate: endDateString,
                reasoning: scheduleData.reasoning
            },
            callId: result.callId
        };

    } catch (error) {
        console.error('Auto-scheduling failed:', error);
        throw error;
    }
}

/**
 * Analyze a full conversation transcript
 * @param {string} transcript - Full medical conversation transcript
 * @returns {Promise<object>} - Structured medical summary
 */
async function analyzeTranscript(transcript) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a medical transcription analyst. Extract key information from patient conversations.
                    Return a JSON object with: symptoms, duration, severity, medical_history, medications, next_steps.`
                },
                {
                    role: "user",
                    content: `Analyze this medical conversation:\n\n${transcript}`
                }
            ],
            max_tokens: 500,
            temperature: 0.3
        });

        const analysis = response.choices[0].message.content.trim();
        
        // Try to parse as JSON, fallback to raw text
        try {
            return JSON.parse(analysis);
        } catch {
            return { summary: analysis };
        }
    } catch (error) {
        console.error('OpenAI API Error:', error);
        throw new Error('Failed to analyze transcript');
    }
}

module.exports = {
    generateFollowUpQuestion,
    autoScheduleFromTranscript
    //analyzeTranscript
};