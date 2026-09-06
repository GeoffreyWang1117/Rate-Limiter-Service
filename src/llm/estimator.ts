import { AdmissionPolicy } from './types';

/**
 * Decides how many tokens to hold for a request whose output length is not yet
 * known.
 *
 * The tension: hold too little and the request overruns, which is charged after
 * the fact and so lets a tenant briefly exceed its budget. Hold too much and
 * the held-but-unused remainder is unavailable to anyone until the request
 * commits, which at realistic concurrency strands a large fraction of a
 * tenant's quota against output that never gets generated.
 *
 * Callers overwhelmingly set max_tokens as a safety ceiling rather than an
 * expectation -- 4096 requested against a few hundred actually produced is
 * ordinary. Reserving the ceiling therefore wastes most of the budget it holds.
 */
export interface ReservationEstimate {
  reserveTokens: number;
  /** What worst-case reservation would have held, for measuring the difference. */
  worstCaseTokens: number;
  basis: 'worst_case' | 'observed' | 'cold_start';
}

export function estimateReservation(
  policy: AdmissionPolicy,
  promptTokens: number,
  maxOutputTokens: number,
  observedOutputEwma: number
): ReservationEstimate {
  const worstCaseTokens = promptTokens + maxOutputTokens;

  if (policy.reservationMode === 'worst_case') {
    return { reserveTokens: worstCaseTokens, worstCaseTokens, basis: 'worst_case' };
  }

  // Nothing observed for this model yet. Hold the ceiling rather than guess;
  // the estimator calibrates itself from the first few commits.
  if (observedOutputEwma <= 0) {
    return { reserveTokens: worstCaseTokens, worstCaseTokens, basis: 'cold_start' };
  }

  const projected = Math.ceil(observedOutputEwma * policy.reservationSafetyFactor);
  // Never above the caller's declared ceiling -- it cannot legitimately exceed
  // it -- and never below it when the ceiling is already small, where holding
  // the exact amount costs nothing.
  const output = Math.min(maxOutputTokens, Math.max(projected, 1));

  return {
    reserveTokens: promptTokens + output,
    worstCaseTokens,
    basis: 'observed',
  };
}
