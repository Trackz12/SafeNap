import { describe, it, expect, beforeEach } from 'vitest';
import { PerclosTracker } from './perclosTracker';

const CONFIG = { windowMs: 60000, ignoreMs: 400 };

describe('PerclosTracker', () => {
    let tracker: PerclosTracker;

    beforeEach(() => {
        tracker = new PerclosTracker(CONFIG);
    });

    it('sem nenhum fechamento nem perda de rosto: perclos=0, confidence=1', () => {
        const r = tracker.compute(60000, null, null);
        expect(r.perclos).toBe(0);
        expect(r.confidence).toBe(1);
        expect(r.validObservedMs).toBe(60000);
    });

    it('segmentos curtos (< ignoreMs) não contam — filtra piscada normal', () => {
        tracker.recordClosedSegment({ start: 1000, end: 1200 }); // 200ms < ignoreMs
        const r = tracker.compute(60000, null, null);
        expect(r.closedMs).toBe(0);
    });

    it('sem perda de rosto: comportamento igual à fórmula antiga (closedMs / windowMs fixo)', () => {
        // 6000ms fechados de 60000ms observados = 10%, com toda a janela válida.
        tracker.recordClosedSegment({ start: 0, end: 6000 });
        const r = tracker.compute(60000, null, null);
        expect(r.perclos).toBeCloseTo(0.10, 5);
        expect(r.validObservedMs).toBe(60000);
        expect(r.confidence).toBe(1);
    });

    it('MUDANÇA DE COMPORTAMENTO: perda de rosto reduz o denominador em vez de diluir o PERCLOS', () => {
        // ANTES: 6000ms fechados / 60000ms fixo = 10%, mesmo com metade da
        // janela sem rosto observável.
        // DEPOIS: 6000ms fechados / 30000ms observados (30s de rosto ausente
        // excluídos do denominador) = 20%.
        tracker.recordClosedSegment({ start: 0, end: 6000 });
        tracker.recordLostInterval({ start: 6000, end: 36000 }); // 30s sem rosto
        const r = tracker.compute(60000, null, null);
        expect(r.validObservedMs).toBe(30000);
        expect(r.perclos).toBeCloseTo(0.20, 5);
        expect(r.confidence).toBeCloseTo(0.5, 5);
    });

    it('fechamento AO VIVO (ainda não terminou) soma via liveClosedSince', () => {
        const r = tracker.compute(65000, 60000, null); // fechado há 5s, ainda fechado
        expect(r.closedMs).toBe(5000);
    });

    it('perda de rosto AO VIVO (ainda não terminou) soma via liveLostSince', () => {
        const r = tracker.compute(65000, null, 60000); // sem rosto há 5s
        expect(r.validObservedMs).toBe(55000);
    });

    it('janela inteira sem rosto: validObservedMs=0, perclos=0 (não divide por zero)', () => {
        tracker.recordLostInterval({ start: 0, end: 60000 });
        const r = tracker.compute(60000, null, null);
        expect(r.validObservedMs).toBe(0);
        expect(r.perclos).toBe(0);
        expect(r.confidence).toBe(0);
    });

    it('segmentos/intervalos antigos saem da janela deslizante', () => {
        tracker.recordClosedSegment({ start: -70000, end: -65000 }); // fora da janela de 60s
        const r = tracker.compute(0, null, null);
        expect(r.closedMs).toBe(0);
    });
});
