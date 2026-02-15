# Pain correction algorithm

## Goal

Estimate **actual pain** from a timeseries of **reported pain**, **mood**, and **physical condition**, accounting for:

- **Perception bias**: mood and physical state can inflate or deflate reported pain.
- **Baseline**: the user’s typical pain level stabilizes estimates.

All scales are 0–10 (higher = worse pain, better mood, better physical condition).

---

## Literature rationale

### 1. Mood and pain perception

- Negative affect, depression, and anxiety are associated with **higher** pain ratings (affective amplification).
- References: Bair et al., *Psychological Bulletin* (depression and pain); mood as moderator of pain perception in chronic pain samples.
- **Implication**: when mood is low, reported pain tends to be **over**-reported relative to a “neutral” perception. We correct by subtracting a bias that increases as mood decreases.

### 2. Physical condition and pain perception

- Poor physical function and deconditioning are associated with higher reported pain and pain catastrophizing (e.g. SF-36 physical function vs pain).
- **Implication**: worse physical condition → over-reporting. We subtract a bias that increases as physical condition decreases.

### 3. Baseline pain

- Chronic pain is often characterized by a personal baseline (habitual level).
- Using a running baseline (or clinician-set baseline) stabilizes estimates and reduces noise from single inflated reports.
- **Implication**: we blend the bias-corrected pain with the user’s baseline so that “actual” pain is pulled toward their typical level.

---

## Formula

### Step 1: Perception bias (over-reporting)

- Low mood and poor physical condition → positive bias (we subtract it from reported pain).

\[
\text{bias} = k_{\text{mood}} \cdot (10 - \text{mood}) + k_{\text{physical}} \cdot (10 - \text{physical})
\]

- Default: \(k_{\text{mood}} \approx 0.12\), \(k_{\text{physical}} \approx 0.10\) (tunable; bias typically in 0–2.2 range).

### Step 2: Corrected pain (single time point)

\[
\text{corrected} = \text{clamp}_{[0,10]}(\text{reported} - \text{bias})
\]

### Step 3: Baseline

- **Running baseline**: mean of corrected pain over all **prior** time points (no future data).
- **Fixed baseline**: optional user/clinician-set value (e.g. from first week or assessment).

### Step 4: Actual pain estimate

\[
\text{actual} = \alpha \cdot \text{corrected} + (1 - \alpha) \cdot \text{baseline}
\]

- Default \(\alpha \approx 0.75\) (more weight on corrected; baseline has a modest pull).
- Result is clamped to \([0, 10]\).

---

## Usage

- **Server**: `pain-correction.js` exports `actualPainFromTimeseries(timeseries, options)`.
- **API**: `POST /api/actual-pain` with body `{ timeseries, options? }` returns `{ data: [{ date, reportedPain, correctedPain, actualPain, baseline }, ...] }`.
- **Dashboard**: `createPainLineGraph('painChart', timeseries)` fetches actual pain from the API and plots reported, expected (from mood & physical), and actual (corrected + baseline).

---

## Tunable parameters

| Option            | Default | Description                                                |
|-------------------|--------|------------------------------------------------------------|
| `kMood`           | 0.12   | Weight for mood in perception bias (per point 0–10).     |
| `kPhysical`       | 0.10   | Weight for physical condition in perception bias.         |
| `alphaCorrected`   | 0.75   | Blend: actual = α * corrected + (1−α) * baseline.        |
| `baseline`        | —      | If set, use this as fixed baseline instead of running.   |

Adjust these (e.g. from population data or clinician input) to match your use case.
