import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetricsStore } from './metricsStore';
import type { DetectionMetrics } from './detectionEngine';

function m(overrides: Partial<DetectionMetrics> = {}): DetectionMetrics {
    return {
        state: 'NORMAL',
        ear: 0.32,
        perclos: 0.1,
        facePresent: true,
        faceLostForMs: 0,
        eyesClosed: false,
        closedForMs: 0,
        blinkRate: 15,
        mouthAspect: 0.3,
        yawnActive: false,
        noseDropRatio: 0.4,
        headDropped: false,
        mlScore: null,
        reason: null,
        threshold: 0.2,
        preset: 'standard',
        ...overrides,
    };
}

describe('MetricsStore', () => {
    let store: MetricsStore;

    beforeEach(() => {
        store = new MetricsStore();
    });

    it('starts with null latest', () => {
        expect(store.get()).toBeNull();
    });

    it('publishes metrics and stores latest', () => {
        const metrics = m();
        store.publish(metrics);
        expect(store.get()).toEqual(metrics);
    });

    it('notifies subscribers on publish', () => {
        const cb = vi.fn();
        store.subscribe(cb);

        const metrics = m({ state: 'WARNING', reason: 'YAWN' });
        store.publish(metrics);
        expect(cb).toHaveBeenCalledWith(metrics);
    });

    it('delivers current value on subscribe', () => {
        const metrics = m({ state: 'ALARM', reason: 'EYES_CLOSED_DURATION', mlScore: 0.9 });
        store.publish(metrics);

        const cb = vi.fn();
        store.subscribe(cb);
        expect(cb).toHaveBeenCalledWith(metrics);
    });

    it('unsubscribe stops notifications', () => {
        const cb = vi.fn();
        const unsub = store.subscribe(cb);

        store.publish(m());
        expect(cb).toHaveBeenCalledTimes(1);

        unsub();
        store.publish(m({ state: 'WARNING', reason: 'YAWN' }));
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('handles listener errors gracefully', () => {
        const errorCb = vi.fn(() => { throw new Error('listener error'); });
        const goodCb = vi.fn();

        store.subscribe(errorCb);
        store.subscribe(goodCb);

        store.publish(m());
        expect(goodCb).toHaveBeenCalled();
    });
});
