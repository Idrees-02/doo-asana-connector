/**
 * The action contract.
 *
 * An action declares *what* it does and *how risky* it is, then implements a
 * single `run`. Everything else — validation, authentication, approval gating,
 * idempotency, logging, error normalization, timing — is supplied by the
 * shared pipeline in `runtime/execute.ts`.
 *
 * That division is the point. Five actions implemented independently would
 * mean five chances to forget to validate input or to mis-handle a 429. Here,
 * an action physically cannot skip those steps, because it never sees the
 * request until they have already run.
 */

import type { z } from 'zod';
import type { AsanaClient } from '../client.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../runtime/logger.js';

/** Risk level, surfaced in the manifest, the console and MCP tool annotations. */
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ActionContext {
  readonly client: AsanaClient;
  readonly config: AppConfig;
  readonly requestId: string;
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
  /** Records an upstream HTTP call, so response meta reflects real work done. */
  readonly recordUpstream: (calls: number, attempts: number) => void;
}

export interface ActionExample {
  readonly title: string;
  readonly description?: string;
  readonly input: unknown;
}

/**
 * Write-safety metadata.
 *
 * Published in the manifest and the Schema Inspector so that a caller — human
 * or agent — can reason about consequences *before* invoking the action rather
 * than discovering them afterwards.
 */
export interface SafetyMetadata {
  /** Does this action change data in Asana? */
  readonly write: boolean;
  /**
   * Is repeating the identical request safe?
   *
   * Governs whether the transport layer may retry. False means no automatic
   * retry can ever occur, under any status code.
   */
  readonly idempotent: boolean;
  readonly risk: RiskLevel;
  /** Must the caller pass `approved: true`? */
  readonly requiresApproval: boolean;
  /** What happens if this action runs twice. Written for humans. */
  readonly duplicateBehavior: string;
  /** What a caller should do when the outcome is unknown. */
  readonly retryBehavior: string;
  /** How, and how far, duplicate suppression works. */
  readonly idempotencyBehavior: string;
}

export interface ConnectorAction<TInput = unknown, TOutput = unknown> {
  /** Assignment-fixed id, e.g. `asana.list_projects`. Never renamed. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: 'projects' | 'tasks' | 'comments' | 'sections' | 'users' | 'tags';
  readonly safety: SafetyMetadata;
  readonly supportsPagination: boolean;
  /** Minimum OAuth scopes this action needs. */
  readonly scopes: readonly string[];
  /** Asana endpoints touched, shown in the docs and Schema Inspector. */
  readonly endpoints: readonly string[];
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly examples: readonly ActionExample[];
  run(input: TInput, context: ActionContext): Promise<TOutput>;
}

/**
 * Registry-friendly erased type.
 *
 * `unknown` rather than `any`: the pipeline validates against the action's own
 * schema before calling `run`, so the value is genuinely unknown at this level
 * and the compiler should keep saying so.
 */
export type AnyConnectorAction = ConnectorAction<never, unknown>;

/** Erase an action's input/output types for storage in the registry. */
export function asAnyAction<TInput, TOutput>(
  action: ConnectorAction<TInput, TOutput>,
): AnyConnectorAction {
  return action as unknown as AnyConnectorAction;
}
