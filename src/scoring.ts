import type { Issue, Review } from './schema';

const CRITICAL_PATH_PATTERNS = [
  /auth/i,
  /login/i,
  /session/i,
  /token/i,
  /password/i,
  /payment/i,
  /billing/i,
  /checkout/i,
  /stripe/i,
  /webhook/i,
  /crypto/i,
  /security/i,
];

export interface PrStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  touchedPaths: string[];
  hasTestChanges: boolean;
}

export function filterByConfidence(issues: Issue[], min: number): Issue[] {
  return issues.filter((i) => i.confidence >= min).slice(0, 7);
}

export function computeRisk(issues: Issue[], stats: PrStats): number {
  let score = 1;
  const touchesCritical = stats.touchedPaths.some((p) =>
    CRITICAL_PATH_PATTERNS.some((rx) => rx.test(p))
  );
  if (touchesCritical) score += 3;
  if (stats.linesAdded + stats.linesRemoved > 200) score += 2;
  if (!stats.hasTestChanges) score += 2;
  score += issues.filter((i) => i.severity === 'CRITICAL').length;
  return Math.min(10, Math.max(1, score));
}

export function computeQuality(issues: Issue[]): number {
  let score = 100;
  for (const i of issues) {
    if (i.severity === 'CRITICAL') score -= 10;
    else if (i.severity === 'WARNING') score -= 5;
    else score -= 2;
  }
  return Math.min(100, Math.max(0, score));
}

export function finalize(
  review: Review,
  stats: PrStats,
  minConfidence: number
): { review: Review; risk: number; quality: number } {
  const issues = filterByConfidence(review.issues, minConfidence);
  return {
    review: { ...review, issues },
    risk: computeRisk(issues, stats),
    quality: computeQuality(issues),
  };
}
