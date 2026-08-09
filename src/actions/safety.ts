/**
 * Safety-metadata presets.
 *
 * Thirty actions fall into four safety shapes. Writing the same paragraphs
 * thirty times would guarantee they drift apart, and drift here is dangerous:
 * this metadata is what tells a caller — human or model — whether repeating an
 * operation is safe.
 *
 * The presets encode the decision rule directly:
 *
 *   READ            no side effects, retry freely
 *   CREATE          produces a NEW object -> never auto-retried
 *   MUTATE          sets a value -> same input, same end state -> retryable
 *   ASSOCIATE       links/unlinks two objects -> naturally idempotent
 *
 * The distinction that matters most is CREATE vs the rest. Everything else can
 * be repeated without consequence; a create cannot.
 */

import type { RiskLevel, SafetyMetadata } from './types.js';

/** A read-only action. */
export function readSafety(): SafetyMetadata {
  return {
    write: false,
    idempotent: true,
    risk: 'low',
    requiresApproval: false,
    duplicateBehavior: 'None. Reads have no side effects, so repeating this action changes nothing.',
    retryBehavior:
      'Safe to retry automatically. The client retries 429 and 5xx up to 3 attempts with backoff, honouring Retry-After.',
    idempotencyBehavior: 'Not applicable — this action never modifies data.',
  };
}

/**
 * An action that creates a NEW object.
 *
 * The dangerous category: Asana has no server-side deduplication, so a retry
 * produces a second object with a different gid.
 */
export function createSafety(objectName: string, risk: RiskLevel = 'medium'): SafetyMetadata {
  return {
    write: true,
    idempotent: false,
    risk,
    requiresApproval: true,
    duplicateBehavior: `Asana has no server-side deduplication: calling this twice creates two separate ${objectName}s with different gids.`,
    retryBehavior:
      'NEVER retried automatically. A failed create may already have succeeded (particularly on timeout), so the connector reports retryStrategy=manual_with_idempotency_key and leaves the decision to the caller.',
    idempotencyBehavior:
      'Supply idempotencyKey to make deliberate retries safe: a repeated key replays the original result instead of creating a second object. Process-local, 15-minute TTL — it does not survive a restart.',
  };
}

/**
 * An action that sets a field on an existing object.
 *
 * Applying the same value twice leaves the same end state, so retrying is safe.
 */
export function mutateSafety(what: string, risk: RiskLevel = 'medium'): SafetyMetadata {
  return {
    write: true,
    idempotent: true,
    risk,
    requiresApproval: true,
    duplicateBehavior: `Applying the same change twice is harmless: ${what} ends in the same state, and no new object is created.`,
    retryBehavior:
      'Safe to retry, because the operation is idempotent. The client retries 429 and 5xx up to 2 further attempts, honouring Retry-After.',
    idempotencyBehavior:
      'Naturally idempotent, so an idempotency key is optional. The end state depends only on the values supplied, not on how many times the request was sent.',
  };
}

/**
 * An action that links or unlinks two existing objects.
 *
 * Adding something already present, or removing something already absent, is a
 * no-op in Asana — so these are idempotent even though they are POSTs.
 */
export function associateSafety(description: string): SafetyMetadata {
  return {
    write: true,
    idempotent: true,
    risk: 'low',
    requiresApproval: true,
    duplicateBehavior: `No duplicate is possible: ${description} Repeating the call is a no-op.`,
    retryBehavior:
      'Safe to retry despite being a POST, because the operation only asserts an association rather than creating an object. The client retries 429 and 5xx up to 2 further attempts.',
    idempotencyBehavior:
      'Naturally idempotent. An idempotency key is unnecessary — the association either exists or it does not.',
  };
}
