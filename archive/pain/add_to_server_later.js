const PainAnalyzer = require('./pain-analyzer');

// Analyze pain for a specific user
app.get('/analyze-pain/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const report = await PainAnalyzer.generateDoctorReport(userId);
        
        res.json({
            success: true,
            report: report
        });
    } catch (error) {
        console.error('Error analyzing pain:', error);
        res.status(500).json({ 
            error: 'Failed to analyze pain data',
            details: error.message 
        });
    }
});

// Batch analyze all users
app.get('/analyze-all-patients', async (req, res) => {
    try {
        // ============ DATABASE PLACEHOLDER ============
        // Get all user IDs from database
        const userIds = await getAllUserIdsFromDB();
        // Example: ['user1', 'user2', 'user3']
        // ==============================================
        
        const reports = [];
        
        for (const userId of userIds) {
            try {
                const report = await PainAnalyzer.generateDoctorReport(userId);
                reports.push(report);
            } catch (error) {
                console.error(`Error analyzing user ${userId}:`, error);
            }
        }
        
        // Sort by alert status (warnings first)
        reports.sort((a, b) => {
            if (a.alert.includes('⚠️') && !b.alert.includes('⚠️')) return -1;
            if (!a.alert.includes('⚠️') && b.alert.includes('⚠️')) return 1;
            return 0;
        });
        
        res.json({
            success: true,
            totalPatients: reports.length,
            patientsWithAdaptation: reports.filter(r => r.alert.includes('⚠️')).length,
            reports: reports
        });
    } catch (error) {
        console.error('Error analyzing all patients:', error);
        res.status(500).json({ 
            error: 'Failed to analyze patient data',
            details: error.message 
        });
    }
});

// ============ DATABASE PLACEHOLDER ============
async function getAllUserIdsFromDB() {
    // TODO: Replace with actual database query
    // Example query:
    // SELECT DISTINCT user_id FROM call_transcripts
    
    throw new Error('Database query not implemented - replace with your DB call');
}
// ==============================================