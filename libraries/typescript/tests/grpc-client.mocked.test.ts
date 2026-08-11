/**
 * grpc-client.mocked.test.ts
 *
 * Mocked unit tests for PatterGrpcClient in src/grpc-client.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PatterGrpcClient } from '../src/grpc-client';

describe('PatterGrpcClient', () => {
  let client: PatterGrpcClient;

  beforeEach(() => {
    client = new PatterGrpcClient('unix:///tmp/mock-engine.sock');
  });

  it('instantiates with target Unix socket or default env var', () => {
    expect(client).toBeDefined();
  });
});
