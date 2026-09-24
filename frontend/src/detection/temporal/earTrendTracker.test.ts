import { describe, it, expect, beforeEach } from 'vitest';
import { EarTrendTracker } from './earTrendTracker';
import { FakeClock } from './clock';

// Janelas em TEMPO desde 2026-09-24 (ver docstring de EarTrendConfig).
// minSamples caiu de 20 para 8 porque deixou de ser o relógio: agora é só piso
// de ruído, e quem exige "~2s de dados" é minObservationMs.
const CONFIG = { windowMs: 60000, minObservationMs: 2000, recentWindowMs: 1000, minSamples: 8 };

describe('EarTrendTracker', () => {
    let clock: FakeClock;
    let tracker: EarTrendTracker;

    beforeEach(() => {
        clock = new FakeClock(1_000_000);
        tracker = new EarTrendTracker(clock, CONFIG);
    });

    it('menos que minSamples (piso de ruído): retorna null', () => {
        for (let i = 0; i < 4; i++) { clock.advance(600); tracker.addOpenEyeSample(0.35); }
        // 4 amostras cobrem 1800ms — mas são menos que minSamples=8.
        expect(tracker.computeFraction(0.35)).toBeNull();
    });

    // MUDANÇA DE COMPORTAMENTO: antes bastavam 20 amostras, o que a 30 FPS
    // seriam 0,67s. Agora o critério é tempo coberto, independente da cadência.
    it('amostras suficientes mas pouco TEMPO coberto: retorna null (independente de FPS)', () => {
        // 20 amostras a 30 FPS = 633ms de span: passaria no critério antigo.
        for (let i = 0; i < 20; i++) { clock.advance(33); tracker.addOpenEyeSample(0.20); }
        expect(tracker.computeFraction(0.35)).toBeNull();
    });

    it('mesmo declínio, mesma resposta a 10 e a 30 FPS (span de 3s nos dois casos)', () => {
        const run = (frameMs: number) => {
            const c = new FakeClock(2_000_000);
            const t = new EarTrendTracker(c, CONFIG);
            const frames = Math.round(3000 / frameMs);
            for (let i = 0; i < frames; i++) { c.advance(frameMs); t.addOpenEyeSample(0.25); }
            return t.computeFraction(0.35);
        };
        const slow = run(100);
        const fast = run(33);
        expect(slow).not.toBeNull();
        expect(fast).not.toBeNull();
        expect(fast!).toBeCloseTo(slow!, 5);
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
        // A janela "recente" agora é TEMPORAL (recentWindowMs=1000), não "as
        // últimas N amostras". Para a média recente ser exatamente 0.25, o
        // declínio precisa cobrir mais de 1000ms — senão amostras antigas de
        // 0.35 ainda caem dentro da janela e diluem a média (que é o
        // comportamento correto de uma média por tempo).
        for (let i = 0; i < 15; i++) { clock.advance(100); tracker.addOpenEyeSample(0.35); }
        for (let i = 0; i < 15; i++) { clock.advance(100); tracker.addOpenEyeSample(0.25); }
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
