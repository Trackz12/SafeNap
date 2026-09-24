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

    // MUDANÇA (achado nº 6): a zona-morta continua não contando em NENHUMA
    // taxa — o que muda é que ela deixou de ser silenciosa. Antes o `kind`
    // vinha `null`, indistinguível de "não classifiquei"; agora cada faixa de
    // duração tem nome, então uma lacuna aparece em log/teste.
    it('zona-morta (maxBlinkMs, slowBlinkMinMs) é classificada como indeterminate e não conta em taxa', () => {
        const e = detector.onClosedSegment(seg(clock.now(), 450));
        expect(e.kind).toBe('indeterminate');
        clock.advance(58000);
        expect(detector.getSlowBlinkRate(clock.now())).toBe(0);
        expect(detector.getBlinkRate(clock.now())).toBe(0);
    });

    it('classifica todas as faixas de duração sem lacuna silenciosa', () => {
        expect(detector.onClosedSegment(seg(1000, 20)).kind).toBe('artifact');      // < minBlinkMs
        expect(detector.onClosedSegment(seg(2000, 150)).kind).toBe('normal');       // faixa normal
        expect(detector.onClosedSegment(seg(3000, 450)).kind).toBe('indeterminate'); // zona-morta
        expect(detector.onClosedSegment(seg(4000, 600)).kind).toBe('slow');        // piscada lenta
        expect(detector.onClosedSegment(seg(5000, 2500)).kind).toBe('prolonged');   // >= slowBlinkMaxMs
    });

    it('validObservedMs encolhe o denominador da taxa (rosto ausente não é observação)', () => {
        // 4 piscadas normais. Com 60s de observação: 4/min. Com só 30s de
        // observação válida (o resto sem rosto): 8/min. ANTES o denominador
        // era sempre o tempo de parede, subestimando a taxa.
        for (let i = 0; i < 4; i++) detector.onClosedSegment(seg(clock.now() + i * 100, 150));
        clock.advance(59000);
        expect(detector.getBlinkRate(clock.now())).toBe(4);
        expect(detector.getBlinkRate(clock.now(), 30000)).toBe(8);
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
