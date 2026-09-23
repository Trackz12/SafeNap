import { describe, it, expect, beforeEach } from 'vitest';
import { MicrosleepDetector } from './microsleepDetector';
import { FakeClock } from '../temporal/clock';

const CONFIG = { thresholdFactor: 0.55, alarmMs: 1800, cooldownMs: 10000, confirmFrames: 3 };
const THRESHOLD = 0.25;

describe('MicrosleepDetector', () => {
    let clock: FakeClock;
    let detector: MicrosleepDetector;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        detector = new MicrosleepDetector(clock, CONFIG);
    });

    it('ear acima do fator não acumula candidato', () => {
        const r = detector.update(0.35, THRESHOLD);
        expect(r.candidateMs).toBe(0);
        expect(r.meetsThreshold).toBe(false);
    });

    it('ear bem abaixo (< threshold*0.55) sustentado por >= alarmMs atinge meetsThreshold', () => {
        let last;
        for (let i = 0; i < 20; i++) { clock.advance(100); last = detector.update(0.05, THRESHOLD); }
        expect(last!.candidateMs).toBeGreaterThanOrEqual(1800);
        expect(last!.meetsThreshold).toBe(true);
    });

    it('cooldown bloqueia novo trigger logo após markTriggered()', () => {
        for (let i = 0; i < 20; i++) { clock.advance(100); detector.update(0.05, THRESHOLD); }
        detector.markTriggered();
        // ainda dentro do candidato, mas em cooldown
        clock.advance(100);
        const r = detector.update(0.05, THRESHOLD);
        expect(r.meetsThreshold).toBe(false);
    });

    it('markUnknown() zera o candidato mas preserva o cooldown (lastTriggeredAt)', () => {
        for (let i = 0; i < 20; i++) { clock.advance(100); detector.update(0.05, THRESHOLD); }
        detector.markTriggered();
        detector.markUnknown();
        clock.advance(100);
        const r = detector.update(0.05, THRESHOLD);
        expect(r.candidateMs).toBe(0); // zerado pelo markUnknown
        expect(r.meetsThreshold).toBe(false); // ainda em cooldown
    });
});
