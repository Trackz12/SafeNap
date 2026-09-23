import { describe, it, expect, beforeEach } from 'vitest';
import { EarTrendTracker } from './earTrendTracker';
import { FakeClock } from './clock';

const CONFIG = { windowMs: 60000, minSamples: 20, recentSampleCount: 10 };

describe('EarTrendTracker', () => {
    let clock: FakeClock;
    let tracker: EarTrendTracker;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        tracker = new EarTrendTracker(clock, CONFIG);
    });

    it('menos que minSamples: retorna null', () => {
        for (let i = 0; i < 10; i++) { clock.advance(100); tracker.addOpenEyeSample(0.35); }
        expect(tracker.computeFraction(0.35)).toBeNull();
    });

    it('sem baseline: retorna null mesmo com amostras suficientes', () => {
        for (let i = 0; i < 25; i++) { clock.advance(100); tracker.addOpenEyeSample(0.35); }
        expect(tracker.computeFraction(null)).toBeNull();
    });

    it('EAR estável em torno do baseline: fração próxima de 0', () => {
        for (let i = 0; i < 25; i++) { clock.advance(100); tracker.addOpenEyeSample(0.35); }
        expect(tracker.computeFraction(0.35)).toBeCloseTo(0, 2);
    });

    it('declínio real do EAR recente vs. baseline retorna fração positiva', () => {
        for (let i = 0; i < 15; i++) { clock.advance(100); tracker.addOpenEyeSample(0.35); }
        for (let i = 0; i < 10; i++) { clock.advance(100); tracker.addOpenEyeSample(0.25); } // 10 mais recentes caem
        const frac = tracker.computeFraction(0.35);
        expect(frac).not.toBeNull();
        expect(frac!).toBeCloseTo((0.35 - 0.25) / 0.35, 2);
    });

    it('amostras saem da janela deslizante', () => {
        for (let i = 0; i < 25; i++) { clock.advance(100); tracker.addOpenEyeSample(0.35); }
        clock.advance(70000); // além de windowMs=60000
        tracker.addOpenEyeSample(0.35);
        // só 1 amostra sobrevive -> abaixo de minSamples
        expect(tracker.computeFraction(0.35)).toBeNull();
    });
});
