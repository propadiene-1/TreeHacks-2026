const PainTracker = require('./pain-tracker');

class PainAnalyzer {
    /**
     * Analyze pain ratings from transcripts for a user
     * @param {string} userId - User ID
     */
    static async analyzeUserPain(userId) {
        // ============ DATABASE PLACEHOLDER ============
        // Get all transcripts for this user from DB
        const transcripts = await this.getTranscriptsFromDB(userId);
        // Example structure:
        // [
        //   { date: '2026-02-01', transcript: 'AI: How is your pain?\nUser: About a 6' },
        //   { date: '2026-02-08', transcript: 'AI: Rate your pain\nUser: Maybe a 5' }
        // ]
        // ==============================================
        
        // Extract pain ratings from each transcript
        const ratings = [];
        
        transcripts.forEach((record, index) => {
            const painRating = this.extractPainRating(record.transcript);
            
            if (painRating) {
                const dayNumber = index + 1; // Or calculate from dates
                ratings.push({
                    day: dayNumber,
                    date: record.date,
                    rating: painRating
                });
            }
        });
        
        // Analyze the trend
        const analysis = PainTracker.analyzeRatings(ratings);
        
        return {
            userId: userId,
            ratings: ratings,
            analysis: analysis
        };
    }
    
    /**
     * Extract pain rating from transcript text
     */
    static extractPainRating(transcript) {
        // Look for patterns in the transcript
        const patterns = [
            /(?:pain|rating|rate)\s+(?:is|of|about|around|like)?\s*(\d)/i,
            /(?:about|around|maybe)\s+(?:a\s+)?(\d)/i,
            /(\d)\s*(?:out of|\/)\s*(?:7|ten)/i,
            /\b(\d)\b/g  // Any single digit
        ];
        
        for (const pattern of patterns) {
            const match = transcript.match(pattern);
            if (match) {
                const rating = parseInt(match[1]);
                if (rating >= 1 && rating <= 7) {
                    return rating;
                }
            }
        }
        
        return null;
    }
    
    /**
     * Generate insights for doctor
     */
    static async generateDoctorReport(userId) {
        const data = await this.analyzeUserPain(userId);
        
        let recommendation = '';
        let alert = '';
        
        if (data.analysis.probablyAdapting) {
            alert = '⚠️ ADAPTATION DETECTED';
            recommendation = 'Patient ratings declining significantly. Likely scale recalibration rather than actual improvement. Recommend:\n' +
                           '1. Ask patient directly: "Has pain improved or are you getting used to it?"\n' +
                           '2. Assess functional capacity (walking, work, sleep)\n' +
                           '3. Consider objective pain measures';
        } else if (data.ratings.length > 0) {
            alert = '✅ RATINGS STABLE';
            recommendation = 'Pain ratings appear consistent. No significant adaptation detected.';
        }
        
        return {
            patientId: userId,
            totalRatings: data.ratings.length,
            currentRating: data.ratings[data.ratings.length - 1]?.rating || 'N/A',
            firstRating: data.ratings[0]?.rating || 'N/A',
            trendPerDay: data.analysis.dropPerDay?.toFixed(3) || 0,
            alert: alert,
            recommendation: recommendation,
            ratings: data.ratings
        };
    }
    
    // ============ DATABASE PLACEHOLDER ============
    static async getTranscriptsFromDB(userId) {
        // TODO: Replace with actual database query
        // Example query:
        // SELECT date, transcript FROM call_transcripts 
        // WHERE user_id = ? 
        // ORDER BY date ASC
        
        throw new Error('Database query not implemented - replace with your DB call');
    }
    // ==============================================
}

module.exports = PainAnalyzer;


//oTHER RNADOM CLASS

class PainTracker {
    // Check if ratings are declining
    static analyzeRatings(ratings) {
        // How much do ratings drop per day on average?
        const dropPerDay = this.howMuchIsItDropping(ratings);
        
        // If dropping more than 0.05 per day → probably adapting
        const probablyAdapting = dropPerDay < -0.05;
        
        return {
            dropPerDay: dropPerDay,
            probablyAdapting: probablyAdapting,
            message: probablyAdapting 
                ? "⚠️ Ratings dropping - might be adapting to pain"
                : "✅ Ratings stable"
        };
    }
    
    // Calculate average drop per day
    static howMuchIsItDropping(ratings) {
        if (ratings.length < 2) return 0;
        
        const firstRating = ratings[0].rating;
        const lastRating = ratings[ratings.length - 1].rating;
        const daysBetween = ratings[ratings.length - 1].day - ratings[0].day;
        
        return (lastRating - firstRating) / daysBetween;
    }
}