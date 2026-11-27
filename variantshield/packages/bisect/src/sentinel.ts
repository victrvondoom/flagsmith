/**
 * Regression onset detection with a Bernoulli CUSUM (Page 1954; Reynolds and Stoumbos 1999).
 * Input: time-ordered buckets of (n, failures). The baseline rate p0 comes from the first `baselineBuckets` buckets.
 * The alternative is p1 = max(p0 * shiftRatio, p0 + minShift). The statistic S_t = max(0, S_{t-1} + LLR_t) and an alarm
 * fires when S_t > h. The onset estimate is the bucket after the last time S was zero before the alarm.
 */
export interface Bucket { start: number; n: number; failures: number }
export interface OnsetOptions { baselineBuckets?: number; shiftRatio?: number; minShift?: number; threshold?: number }
export interface Onset { alarmed: boolean; onsetAt: number | null; alarmAt: number | null; baselineRate: number; currentRate: number; statistic: number[] }

export function detectOnset(buckets: Bucket[], o: OnsetOptions = {}): Onset {
  const k = Math.max(1, Math.min(o.baselineBuckets ?? 5, buckets.length));
  const base = buckets.slice(0, k);
  const bn = base.reduce((a, b) => a + b.n, 0), bf = base.reduce((a, b) => a + b.failures, 0);
  const p0 = Math.min(0.5, Math.max(1e-4, (bf + 0.5) / (bn + 1)));
  const p1 = Math.min(0.99, Math.max(p0 * (o.shiftRatio ?? 2), p0 + (o.minShift ?? 0.02)));
  const h = o.threshold ?? 8;
  const lf = Math.log(p1 / p0), ls = Math.log((1 - p1) / (1 - p0));
  let s = 0, lastZero = k - 1;
  const stat: number[] = [];
  const last = buckets[buckets.length - 1];
  const currentRate = last && last.n > 0 ? last.failures / last.n : 0;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    if (i < k) { stat.push(0); continue; }
    s = Math.max(0, s + b.failures * lf + (b.n - b.failures) * ls);
    stat.push(s);
    if (s === 0) lastZero = i;
    if (s > h) {
      const onsetIdx = Math.min(buckets.length - 1, lastZero + 1);
      return { alarmed: true, onsetAt: buckets[onsetIdx]!.start, alarmAt: b.start, baselineRate: p0, currentRate, statistic: stat };
    }
  }
  return { alarmed: false, onsetAt: null, alarmAt: null, baselineRate: p0, currentRate, statistic: stat };
}
