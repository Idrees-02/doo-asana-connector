import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/manifest.js';
import { REQUIRED_ACTION_IDS } from '../../src/actions/index.js';

const manifest = buildManifest();

describe('connector manifest', () => {
  it('identifies the connector and its builder', () => {
    expect(manifest.provider).toBe('asana');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.builder).toBe('Idrees Khaled');
    expect(manifest.category).toBe('Project Management');
  });

  it('declares exactly the five required actions', () => {
    expect(manifest.actions.map((a) => a.id)).toEqual([...REQUIRED_ACTION_IDS]);
  });

  it('separates read and write actions correctly', () => {
    expect(manifest.readActions).toEqual(['asana.list_projects', 'asana.list_project_tasks']);
    expect(manifest.writeActions).toEqual([
      'asana.create_task',
      'asana.update_task',
      'asana.add_comment',
    ]);
  });

  it('publishes safety metadata for every action', () => {
    for (const action of manifest.actions) {
      expect(action.safety.duplicateBehavior.length).toBeGreaterThan(20);
      expect(action.safety.retryBehavior.length).toBeGreaterThan(20);
      expect(action.safety.idempotencyBehavior.length).toBeGreaterThan(20);
    }
  });

  it('states that non-idempotent writes are never retried automatically', () => {
    const nonIdempotentWrites = manifest.actions.filter((a) => a.type === 'write' && !a.idempotent);

    expect(nonIdempotentWrites.map((a) => a.id)).toEqual([
      'asana.create_task',
      'asana.add_comment',
    ]);
    for (const action of nonIdempotentWrites) {
      expect(action.safety.retryBehavior).toMatch(/never retried automatically/i);
    }
  });
});

describe('manifest scopes — least privilege', () => {
  it('requests every scope the connector actually needs, and no more', () => {
    // users:read is required by testConnection (GET /users/me) even though no
    // action declares it; omitting it would let OAuth succeed and then fail
    // the connection test.
    expect([...manifest.authentication.scopes]).toEqual([
      'projects:read',
      'stories:write',
      'tasks:read',
      'tasks:write',
      'users:read',
      'workspaces:read',
    ]);
  });

  it('never requests permission to delete anything', () => {
    // Delete is not an assigned action, so the connector must not hold the
    // capability at all.
    expect(manifest.authentication.scopes.some((s) => s.includes('delete'))).toBe(false);
  });

  it('covers every scope declared by an action', () => {
    const declared = new Set(manifest.actions.flatMap((a) => a.scopes));
    for (const scope of declared) {
      expect(manifest.authentication.scopes).toContain(scope);
    }
  });
});

describe('manifest rate limits — matches Asana documentation', () => {
  it('records the documented tier limits', () => {
    expect(manifest.rateLimits.freeTierRpm).toBe(150);
    expect(manifest.rateLimits.paidTierRpm).toBe(1500);
    expect(manifest.rateLimits.concurrentReads).toBe(50);
    expect(manifest.rateLimits.concurrentWrites).toBe(15);
    expect(manifest.rateLimits.costBased).toBe(true);
  });

  it('declares no webhook support, which this connector does not implement', () => {
    expect(manifest.capabilities.webhooks).toBe(false);
  });
});
