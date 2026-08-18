import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SafetyEngine } from './safetyEngine';
import { metricsStore } from '../detection/metricsStore';
import type { DetectionMetrics } from '../detection/detectionEngine';

function makeMetrics(overrides: Partial<DetectionMetrics>): DetectionMetrics {
    return {
        state: 'NORMAL',
        reason: null,
        facePresent: true,
        faceLostForMs: 0,
        eyesClosed: false,
        closedForMs: 0,
        ear: 0.32,
        perclos: 0.1,
        blinkRate: 15,
        mouthAspect: 0.3,
        yawnActive: false,
        noseDropRatio: 0.4,
        headDropped: false,
        threshold: 0.2,
        preset: 'standard',
        mlScore: null,
        ...overrides,
    };
}

describe('SafetyEngine', () => {
    let engine: SafetyEngine;

    beforeEach(() => {
        metricsStore.reset();
        engine = new SafetyEngine();
    });

    it('starts in NORMAL state', () => {
        expect(engine.getState()).toBe('NORMAL');
        expect(engine.getSnapshot().state).toBe('NORMAL');
        expect(engine.getSnapshot().reason).toBeNull();
    });

    it('transitions to WARNING when metrics say so', () => {
        metricsStore.publish(makeMetrics({
            state: 'WARNING',
            reason: 'YAWN',
        }));
        expect(engine.getState()).toBe('WARNING');
        expect(engine.getSnapshot().reason).toBe('YAWN');
    });

    it('transitions to ALARM', () => {
        metricsStore.publish(makeMetrics({
            state: 'ALARM',
            reason: 'EYES_CLOSED_DURATION',
        }));
        expect(engine.getState()).toBe('ALARM');
    });

    it('notifies listeners on state change', () => {
        const cb = vi.fn();
        engine.onStateChange(cb);

        metricsStore.publish(makeMetrics({
            state: 'WARNING',
            reason: 'HEAD_DROP',
        }));

        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb).toHaveBeenCalledWith({
            state: 'WARNING',
            reason: 'HEAD_DROP',
        });
    });

    it('does not notify when state is the same', () => {
        const cb = vi.fn();
        engine.onStateChange(cb);

        metricsStore.publish(makeMetrics({
            state: 'NORMAL',
            reason: null,
        }));

        expect(cb).not.toHaveBeenCalled();
    });

    it('unsubscribe works', () => {
        const cb = vi.fn();
        const unsub = engine.onStateChange(cb);

        metricsStore.publish(makeMetrics({ state: 'WARNING', reason: 'YAWN' }));
        expect(cb).toHaveBeenCalledTimes(1);

        unsub();
        metricsStore.publish(makeMetrics({ state: 'ALARM', reason: 'EYES_CLOSED_DURATION' }));
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('returns to NORMAL from WARNING', () => {
        metricsStore.publish(makeMetrics({ state: 'WARNING', reason: 'YAWN' }));
        expect(engine.getState()).toBe('WARNING');

        metricsStore.publish(makeMetrics({ state: 'NORMAL', reason: null }));
        expect(engine.getState()).toBe('NORMAL');
    });
});
