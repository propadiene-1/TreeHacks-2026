/**
 * Combined Pain Correction Algorithm
 * Habituation-dominant model (chronic adaptation > acute mood effects)
 */

const CORRECTION_PARAMS = {
  // Mood/physical bias (over-reporting) - REDUCED for acute effect
  kMood: 0.08,
  kPhysical: 0.08,
  
  // Habituation correction (under-reporting) - INCREASED for chronic effect
  peakMonths: 15,
  maxHabituationFraction: 0.45,  // Up to 45% of baseline pain
  minChronicBaseline: 4,
  driftThreshold: 1.5,
  correctionWeight: 0.8          // More aggressive correction
};

function moodPhysicalBias(mood, physicalCondition) {
  const { kMood, kPhysical } = CORRECTION_PARAMS;
  const moodTerm = Math.max(0, 10 - mood);
  const physicalTerm = Math.max(0, 10 - physicalCondition);
  return kMood * moodTerm + kPhysical * physicalTerm;
}

function habituationCurve(timeMonths) {
  const { peakMonths } = CORRECTION_PARAMS;
  const k = 0.3;
  const midpoint = peakMonths * 0.6;
  return 1 / (1 + Math.exp(-k * (timeMonths - midpoint)));
}

function expectedPainTrajectory(baseline, timeMonths, hasActiveTreatment = false) {
  if (!hasActiveTreatment) {
    return baseline + Math.min(timeMonths * 0.05, 0.5);
  } else {
    const maxImprovement = baseline * 0.2;
    const improvementCurve = 1 - Math.exp(-timeMonths / 6);
    return baseline - (maxImprovement * improvementCurve);
  }
}

function correctPainCombined(reportedPain, params) {
  const {
    mood = 5,
    physicalCondition = 5,
    baselinePain,
    timeMonths = 0,
    hasActiveTreatment = false
  } = params;
  
  // Effect 1: Mood/physical over-reporting (subtract) - SMALLER effect
  const moodBias = moodPhysicalBias(mood, physicalCondition);
  const afterMoodCorrection = Math.max(0, Math.min(10, reportedPain - moodBias));
  
  // Effect 2: Habituation under-reporting (add) - LARGER effect
  let habituationCorrection = 0;
  
  if (baselinePain >= CORRECTION_PARAMS.minChronicBaseline && 
      timeMonths >= 2 && 
      afterMoodCorrection < baselinePain) {
    
    const expected = expectedPainTrajectory(baselinePain, timeMonths, hasActiveTreatment);
    const drift = Math.max(0, expected - afterMoodCorrection);
    
    if (drift >= CORRECTION_PARAMS.driftThreshold) {
      const timeEffect = habituationCurve(timeMonths);
      const maxHabituation = baselinePain * CORRECTION_PARAMS.maxHabituationFraction;
      const rawHabituation = Math.min(drift * timeEffect, maxHabituation);
      habituationCorrection = rawHabituation * CORRECTION_PARAMS.correctionWeight;
    }
  }
  
  const actualPain = Math.max(0, Math.min(10, afterMoodCorrection + habituationCorrection));
  
  return {
    reportedPain,
    moodBias,
    afterMoodCorrection,
    habituationCorrection,
    actualPain,
    baseline: baselinePain
  };
}

function correctTimeseriesCombined(timeseries, options = {}) {
  const {
    baselinePain,
    hasActiveTreatment = false,
    baselinePeriodDays = 30
  } = options;
  
  if (!timeseries || timeseries.length === 0) return [];
  
  let baseline = baselinePain;
  if (baseline === undefined) {
    const baselinePoints = timeseries.filter(p => 
      p.daysSinceOnset <= baselinePeriodDays
    );
    if (baselinePoints.length > 0) {
      baseline = baselinePoints.reduce((sum, p) => sum + p.painRating, 0) / baselinePoints.length;
    } else {
      baseline = timeseries[0].painRating;
    }
  }
  
  return timeseries.map(point => {
    const timeMonths = point.daysSinceOnset / 30.44;
    
    const corrected = correctPainCombined(point.painRating, {
      mood: point.mood || 5,
      physicalCondition: point.physicalCondition || 5,
      baselinePain: baseline,
      timeMonths,
      hasActiveTreatment
    });
    
    return {
      date: point.date,
      reportedPain: corrected.reportedPain,
      moodBias: corrected.moodBias,
      afterMoodCorrection: corrected.afterMoodCorrection,
      habituationCorrection: corrected.habituationCorrection,
      actualPain: corrected.actualPain,
      baseline: baseline
    };
  });
}

function actualPainFromTimeseries(timeseries, options = {}) {
  return correctTimeseriesCombined(timeseries, options);
}

module.exports = {
  CORRECTION_PARAMS,
  moodPhysicalBias,
  habituationCurve,
  expectedPainTrajectory,
  correctPainCombined,
  correctTimeseriesCombined,
  actualPainFromTimeseries
};