import { describe, it, expect } from 'vitest';
import { PatterTemporalService } from '../src/services/temporal';

describe('PatterTemporalService Unit Tests', () => {
  it('1. Temporal service defaults to disabled when TEMPORAL_TARGET_HOST is unset', () => {
    delete process.env['TEMPORAL_TARGET_HOST'];
    const service = new PatterTemporalService();
    expect(service.enabled).toBe(false);
  });

  it('2. Temporal service enables when targetHost is provided', async () => {
    const service = new PatterTemporalService({
      targetHost: 'patter-prod.a1b2c.tmprl.cloud:7233',
      namespace: 'patter-prod',
    });
    expect(service.enabled).toBe(true);

    const ok = await service.connect();
    expect(ok).toBe(true);

    const workflowId = await service.startCallWorkflow({
      callSessionId: 'test-session-123',
      phoneNumber: '+15551234567',
      carrier: 'telnyx',
    });
    expect(workflowId).toBe('workflow-test-session-123');

    await service.signalTurn(workflowId, {
      speaker: 'user',
      text: 'Hello voice agent',
      timestampMs: Date.now(),
    });

    await service.completeWorkflow(workflowId);
  });
});
