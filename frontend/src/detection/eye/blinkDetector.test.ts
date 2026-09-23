import { describe, it, expect, beforeEach } from 'vitest';
import { BlinkDetector } from './blinkDetector';
import { FakeClock } from '../temporal/clock';
import type { ClosedSegment } from './eyeStateDetector';

const CONFIG = {
    minBlinkMs: 50,
    maxBlinkMs: 400,
    slowBlinkMinMs: 550,
    slowBlinkMaxMs: 1800,
    slowBlinkRateThreshold: 4,
    slowBlinkMinObservationMs: 30000,
};

function seg(start: number, durationMs: number): ClosedSegment {
    return { start, end: start + durationMs, durationMs };
}

describe('BlinkDetector', () => {
    let clock: FakeClock;
    let detector: BlinkDetector;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        detector = new BlinkDetector(clock, CONFIG);
        detector.markStarted();
    });

    it('classifica duração dentro de [minBlinkMs, maxBlinkMs] como normal', () => {
        const e = detector.onClosedSegment(seg(clock.now(), 150));
        expect(e.kind).toBe('normal');
    });

    it('classifica duração dentro de [slowBlinkMinMs, slowBlinkMaxMs) como slow', () => {
        const e = detector.onClosedSegment(seg(clock.now(), 600));
        expect(e.kind).toBe('slow');
    });

    it('zona-morta (maxBlinkMs, slowBlinkMinMs) não conta como nada', () => {
        const e = detector.onClosedSegment(seg(clock.now(), 450));
        expect(e.kind).toBeNull();
    });

    it('taxa de piscadas lentas exige slowBlinkMinObservationMs antes de valer', () => {
        detector.onClosedSegment(seg(clock.now(), 600));
        clock.advance(1000);
        expect(detector.isSlowBlinksActive(clock.now())).toBe(false);
    });

    it('4 piscadas lentas/min após a janela de observação ativa isSlowBlinksActive', () => {
        clock.advance(58000);
        for (let i = 0; i < 4; i++) {
            detector.onClosedSegment(seg(clock.now(), 600));
            clock.advance(100);
        }
        expect(detector.isSlowBlinksActive(clock.now())).toBe(true);
    });

    it('getLastBlinkAt reflete só piscadas normais (não lentas)', () => {
        detector.onClosedSegment(seg(1000, 600)); // slow
        expect(detector.getLastBlinkAt()).toBeNull();
        detector.onClosedSegment(seg(2000, 150)); // normal
        expect(detector.getLastBlinkAt()).toBe(2150);
    });
});
