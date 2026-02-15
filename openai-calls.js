// ai-helper.js - OpenAI API integration for generating follow-up questions

const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Generate follow-up question with symptom context
 */
async function generateFollowUpQuestion(transcript, symptomContext = "") {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{
                role: 'system',
                content: `You are a compassionate healthcare assistant.

${symptomContext}

- Prioritize OVERDUE symptoms
- Reference previous symptom history
- Ask about progression (better/worse/same)
- Keep responses brief (1-2 sentences)
- Be empathetic and natural`
            }, {
                role: 'user',
                content: transcript
            }],
            temperature: 0.7,
            max_tokens: 150
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('OpenAI error:', error);
        throw error;
    }
}


async function extractDBColumns(transcript, phoneNumber) {
    try {
        transcript = transcript.join(" ")
        
    } catch (error) {
        console.error('Auto-scheduling failed:', error);
        throw error;
    }
}

/**
 * Extract structured medical data from transcript
 * @param {Array|string} transcript - Full conversation transcript
 * @param {string} phoneNumber - Patient's phone number
 * @returns {Object} - Structured medical features
 */
async function extractDBColumns(transcript, phoneNumber) {
    try {
        // Convert array to string if needed
        const transcriptText = Array.isArray(transcript) 
            ? transcript.join("\n") 
            : transcript;
        
        console.log('Extracting medical features from transcript...');
        
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a medical data extraction assistant. Extract specific features from patient conversation transcripts. Be precise and only extract explicitly mentioned information.`
                },
                {
                    role: "user",
                    content: `Extract the following from this medical conversation transcript:\n\n${transcriptText}`
                }
            ],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "extract_medical_features",
                        description: "Extract structured medical data from patient transcript",
                        parameters: {
                            type: "object",
                            properties: {
                                pain_rating: {
                                    type: "number",
                                    description: "Pain rating from 1-7. If not mentioned, record your best estimate based on what the patient has described. It must be a number from 1 to 7. If range given, return the average.",
                                    nullable: true,
                                    minimum: 1,
                                    maximum: 7
                                },
                                pain_phrases: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "List of exact phrases related to pain (e.g., 'sharp pain in chest', 'dull ache', 'throbbing headache')"
                                },
                                body_parts: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Body parts mentioned (e.g., 'head', 'upper right thigh', 'left foot', 'stomach', 'chest', 'throat')"
                                },
                                body_part_phrases: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Full phrases where body parts are mentioned (e.g., 'pain in my chest', 'my left foot is swollen', 'pressure on upper right thigh')"
                                },
                                daily_mood: {
                                    type: "string",
                                    description: "Overall sentiment/mood in 2-5 words (e.g., 'worried and stressed', 'calm but tired', 'anxious about symptoms')"
                                },
                                estimated_health_metrics: {
                                    type: "object",
                                    description: "Physical health measurements mentioned or estimated (e.g. body temperature--(e.g. 98.6°F, fever, normal), blood pressure-- (e.g. 00, 120/80, high, normal), heart rate -- (e.g. 72 bpm, racing, normal)), any other physical measurements mentioned",
                                }
                            },
                            required: ["pain_rating", "pain_phrases", "body_parts", "body_part_phrases", "daily_mood", "estimated_health_metrics"]
                        }
                    }
                }
            ],
        });

        // Extract the function call result
        const toolCall = response.choices[0].message.tool_calls[0];
        const extractedData = JSON.parse(toolCall.function.arguments);
        
        // Add metadata
        const result = {
            phoneNumber: phoneNumber,
            timestamp: new Date().toISOString(),
            ...extractedData
        };
        
        console.log('Medical features extracted:', result);
        
        return result;
        
    } catch (error) {
        console.error('Feature extraction failed:', error);
        throw error;
    }
}

/**
 * Auto-schedule follow-up calls from conversation transcript
 * @param {list} transcript - Full conversation transcript
 * @param {string} phoneNumber - Patient's phone number
 * @param {Function} scheduleFunction - scheduleRecurringCalls function from server.js
 */
async function autoScheduleFromTranscript(transcript, phoneNumber, scheduleFunction) {
    try {
        try {
            transcript = transcript.join(" ")
        }
        catch (error) {
            transcript = transcript
        }
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

module.exports = {
    generateFollowUpQuestion,
    autoScheduleFromTranscript,
    //extractKeywordsFromTranscript,
    extractDBColumns
};

/**
 * Extract health/symptom keywords from a conversation transcript
 * @param {string} transcript - Full conversation transcript
 * @returns {Promise<string[]>} - Array of keyword strings
 */
/*async function extractKeywordsFromTranscript(transcript) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Extract health/symptom keywords from the conversation (e.g. pain, fatigue, headache, sleep, anxiety). Reply with only a JSON array of strings, e.g. [\"pain\",\"fatigue\"]."
                },
                {
                    role: "user",
                    content: transcript
                }
            ],
            max_tokens: 150,
            temperature: 0.2
        });

        const content = response.choices[0].message.content.trim();
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length) {
            return parsed.filter(Boolean).map(String);
        }
        return [];
    } catch (error) {
        console.error('OpenAI keyword extraction error:', error);
        return [];
    }
}*/