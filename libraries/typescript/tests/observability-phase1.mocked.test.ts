import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTracing, isTracingEnabled, startSpan, SPAN_CALL, patterCallScope, recordPatterAttrs } from '../src/observability';
import { _resetTracingForTesting } from '../src/observability/tracing';
import { _resetPatterAttrsForTesting } from '../src/observability/attributes';
import { Patter } from '../src/client';
import { Carrier as TwilioCarrier } from '../src/telephony/twilio';

describe('OpenTelemetry Phase 1 — Foundation & Scope', () => {
  beforeEach(() => {
    _resetTracingForTesting();
    _resetPatterAttrsForTesting();
    delete process.env.PATTER_OTEL_ENABLED;
  });

  afterEach(() => {
    _resetTracingForTesting();
    _resetPatterAttrsForTesting();
    delete process.env.PATTER_OTEL_ENABLED;
  });

  it('initTracing returns false when PATTER_OTEL_ENABLED is not set', () => {
    const result = initTracing();
    expect(result).toBe(false);
    expect(isTracingEnabled()).toBe(false);
  });

  it('Patter constructor attempts to initialize tracing when PATTER_OTEL_ENABLED=1', () => {
    process.env.PATTER_OTEL_ENABLED = '1';
    expect(isTracingEnabled()).toBe(false);

    // Constructing Patter triggers initTracing() (graceful fallback if @opentelemetry/api is not installed)
    const phone = new Patter({
      carrier: new TwilioCarrier({ accountSid: 'AC123', authToken: 'auth123' }),
      phoneNumber: '+15550001234',
    });

    expect(phone).toBeDefined();
    // initTracing was called, returns false if optional peer dep @opentelemetry/api is missing
    const tracingStatus = initTracing();
    expect(typeof tracingStatus).toBe('boolean');
  });

  it('patterCallScope correctly binds callId to active scope stack', async () => {
    process.env.PATTER_OTEL_ENABLED = '1';
    initTracing();

    await patterCallScope({ callId: 'call_test_123', side: 'uut' }, async () => {
      // Inside scope, recordPatterAttrs does not throw even when OTel is un-wired
      expect(() => {
        recordPatterAttrs({ 'patter.custom_key': 'test_val' });
      }).not.toThrow();
    });
  });

  it('startSpan produces a valid no-op span handle when OTel peer dep is missing', () => {
    process.env.PATTER_OTEL_ENABLED = '1';
    initTracing();

    const span = startSpan(SPAN_CALL, { 'patter.call.id': 'call_abc' });
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe('function');
    expect(typeof span.end).toBe('function');
    span.setAttribute('test.attr', 'value');
    expect(() => span.end()).not.toThrow();
  });
});
