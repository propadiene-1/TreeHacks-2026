/**
 * Pain correction algorithm: estimate "actual" pain from reported pain, mood,
 * and physical condition, using a baseline and perception-bias correction.
 *
 * LITERATURE RATIONALE
 * --------------------
 * 1. Mood and pain perception
 *    - Negative affect (low mood), depression, and anxiety are associated with
 *      higher pain ratings (affective amplification; Bair et al., Psychol Bull;
 *      mood as a moderator of pain perception).
 *    - Effect: low mood → over-reporting of pain. We model bias proportional to (10 - mood).
 *
 * 2. Physical condition and pain perception
 *    - Poor physical function / deconditioning is associated with higher reported
 *      pain and pain catastrophizing (e.g. SF-36 physical function vs pain).
 *    - Effect: worse physical condition → over-reporting. Bias proportional to (10 - physical).
 *
 * 3. Baseline pain
 *    - Chronic pain is often characterized by a personal baseline (habitual level).
 *    - Baseline stabilizes estimates and reduces noise from single inflated reports.
 *    - We use the user's running mean of past (corrected) pain as baseline, or an
 *      externally set baseline.
 *
 * 4. Formula (additive bias correction, then baseline blending)
 *    - perception_bias = k_mood * (10 - mood) + k_physical * (10 - physical)
 *    - corrected_pain = reported_pain - perception_bias   [clamped 0–10]
 *    - actual_estimate = α * corrected_pain + (1 - α) * baseline_pain
 *
 * Default weights (tunable): k_mood ≈ 0.12, k_physical ≈ 0.10 (so bias in 0–2.2 range),
 * α ≈ 0.75 so baseline has a modest pull toward the person’s typical level.
 */

const DEFAULT_WEIGHTS = {
  /** Per-point of mood (0–10): reduction in pain bias. ~0.10–0.15 in literature. */
  kMood: 0.12,
  /** Per-point of physical condition (0–10): reduction in pain bias. ~0.08–0.12. */
  kPhysical: 0.10,
  /** Blend of corrected vs baseline (0–1). Higher = trust corrected more. */
  alphaCorrected: 0.75
};

/**
 * Compute perception bias (over-reporting) from mood and physical condition.
 * Scales 0–10: higher mood / better physical → lower bias.
 *
 * @param {number} mood - 0–10 (higher = better mood)
 * @param {number} physicalCondition - 0–10 (higher = better condition)
 * @param {{ kMood?: number, kPhysical?: number }} [weights]
 * @returns {number} Bias in pain units (≥ 0)
 */
function perceptionBias(mood, physicalCondition, weights = {}) {
  const kMood = weights.kMood ?? DEFAULT_WEIGHTS.kMood;
  const kPhysical = weights.kPhysical ?? DEFAULT_WEIGHTS.kPhysical;
  const moodTerm = Math.max(0, 10 - mood);
  const physicalTerm = Math.max(0, 10 - physicalCondition);
  return kMood * moodTerm + kPhysical * physicalTerm;
}

/**
 * Single-point corrected pain (reported minus bias), clamped to [0, 10].
 *
 * @param {number} reportedPain - 0–10
 * @param {number} mood - 0–10
 * @param {number} physicalCondition - 0–10
 * @param {{ kMood?: number, kPhysical?: number }} [weights]
 * @returns {number}
 */
function correctedPain(reportedPain, mood, physicalCondition, weights = {}) {
  const bias = perceptionBias(mood, physicalCondition, weights);
  return Math.max(0, Math.min(10, reportedPain - bias));
}

/**
 * Compute baseline pain from a timeseries (running mean of corrected pain).
 * Uses all prior points up to (but not including) the current index.
 *
 * @param {Array<{mood: number, physicalCondition: number, painRating: number}>} timeseries
 * @param {number} upToIndex - Use points [0, upToIndex) for baseline
 * @param {{ kMood?: number, kPhysical?: number }} [weights]
 * @returns {number} Baseline pain 0–10, or NaN if no prior data
 */
function baselineFromTimeseries(timeseries, upToIndex, weights = {}) {
  if (upToIndex <= 0) return NaN;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < upToIndex && i < timeseries.length; i++) {
    const row = timeseries[i];
    const c = correctedPain(row.painRating, row.mood, row.physicalCondition, weights);
    sum += c;
    n += 1;
  }
  return n === 0 ? NaN : sum / n;
}

/**
 * Estimate actual pain for each point in a timeseries, using baseline and
 * perception-bias correction.
 *
 * @param {Array<{date?: string, mood: number, physicalCondition: number, painRating: number}>} timeseries
 * @param {{ baseline?: number, kMood?: number, kPhysical?: number, alphaCorrected?: number }} [options]
 *   - baseline: fixed baseline (0–10). If omitted, computed from prior points in timeseries.
 *   - kMood, kPhysical, alphaCorrected: see DEFAULT_WEIGHTS
 * @returns {Array<{ date?: string, reportedPain: number, correctedPain: number, actualPain: number, baseline: number }>}
 */
function actualPainFromTimeseries(timeseries, options = {}) {
  const weights = {
    kMood: options.kMood ?? DEFAULT_WEIGHTS.kMood,
    kPhysical: options.kPhysical ?? DEFAULT_WEIGHTS.kPhysical
  };
  const alpha = options.alphaCorrected ?? DEFAULT_WEIGHTS.alphaCorrected;
  const fixedBaseline = options.baseline;

  const out = [];
  for (let i = 0; i < timeseries.length; i++) {
    const row = timeseries[i];
    const reported = row.painRating;
    const corrected = correctedPain(reported, row.mood, row.physicalCondition, weights);
    const baseline = fixedBaseline !== undefined && !Number.isNaN(fixedBaseline)
      ? fixedBaseline
      : baselineFromTimeseries(timeseries, i, weights);
    const actual = Number.isNaN(baseline)
      ? corrected
      : alpha * corrected + (1 - alpha) * baseline;
    const clampedActual = Math.max(0, Math.min(10, actual));
    out.push({
      date: row.date,
      reportedPain: reported,
      correctedPain: corrected,
      actualPain: clampedActual,
      baseline: Number.isNaN(baseline) ? corrected : baseline
    });
  }
  return out;
}

module.exports = {
  DEFAULT_WEIGHTS,
  perceptionBias,
  correctedPain,
  baselineFromTimeseries,
  actualPainFromTimeseries
};
