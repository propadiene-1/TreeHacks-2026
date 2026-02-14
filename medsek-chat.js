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

/**
 * Extract health/symptom keywords from a conversation transcript
 * @param {string} transcript - Full conversation transcript
 * @returns {Promise<string[]>} - Array of keyword strings
 */
async function extractKeywordsFromTranscript(transcript) {
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
}

module.exports = {
    generateFollowUpQuestion,
    extractKeywordsFromTranscript
    //analyzeTranscript
};