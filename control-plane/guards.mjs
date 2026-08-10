// Guards — duration, inactivity, repeated-failure, and observable budget limits.
// No automatic resume of poisooned sessions.

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ----------------------------------------------------------------------------
// Duration guard
// ----------------------------------------------------------------------------

export function checkDuration(startedAt, maxSeconds) {
  if (!maxSeconds) return { exceeded: false, remaining_seconds: Infinity };
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  const remaining = maxSeconds - elapsed;
  return { exceeded: remaining <= 0, remaining_seconds: remaining };
}

// ----------------------------------------------------------------------------
// Inactivity guard - checks if a process has produced any recent output
// ----------------------------------------------------------------------------

export function checkInactivity(lastActivityAt, inactivityTimeoutSeconds) {
  if (!inactivityTimeoutSeconds) return { timed_out: false };
  if (!lastActivityAt) return { timed_out: false };
  const elapsed = (Date.now() - new Date(lastActivityAt).getTime()) / 1000;
  return { timed_out: elapsed > inactivityTimeoutSeconds, elapsed_seconds: elapsed };
}

// ----------------------------------------------------------------------------
// Repeated identical failure detection
// ----------------------------------------------------------------------------

export function checkRepeatedFailure(failureHistory, limit) {
  if (limit <= 0) return { triggered: false, count: failureHistory.length };
  if (failureHistory.length < limit) return { triggered: false, count: failureHistory.length };

  // Count consecutive failures with identical reason_code
  const recent = failureHistory.slice(-limit);
  const allSame = recent.length >= 2 && recent.every((f) => f.reason_code === recent[0].reason_code);
  return { triggered: allSame, count: failureHistory.length, reason_code: recent[0]?.reason_code };
}

// ----------------------------------------------------------------------------
// Token/cost budget guard - enforced only when adapter reports usage
// ----------------------------------------------------------------------------

export function checkBudget(accumulator, limits) {
  if (!accumulator || !accumulator.available) return { exceeded: false, status: "unavailable" };
  if (limits.max_tokens && accumulator.tokens > limits.max_tokens)
    return { exceeded: true, reason: "token_limit", tokens: accumulator.tokens, limit: limits.max_tokens };
  if (limits.max_cost_usd && accumulator.cost_usd > limits.max_cost_usd)
    return { exceeded: true, reason: "cost_limit", cost_usd: accumulator.cost_usd, limit: limits.max_cost_usd };
  return { exceeded: false, status: "ok" };
}
