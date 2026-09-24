import { describe, it, expect, beforeEach } from 'vitest';
import { PerclosTracker } from './perclosTracker';

const CONFIG = { windowMs: 60000, ignoreMs: 400, minObservationMs: 20000 };

describe('PerclosTracker', () => {
    let tracker: PerclosTracker;

    beforeEach(() => {
        tracker = new PerclosTracker(CONFIG);
        // A observação começa em t=0 na maioria dos cenários abaixo, de modo
        // que em t=60000 a janela de 60s está inteiramente preenchida. Sem
        // isso o tracker (corretamente) considera que nada foi observado —
        // ver os dois testes de "início de sessão" no fim deste arquivo.
        tracker.markObservationStart(0);
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

describe('PerclosTracker — início de sessão (MUDANÇA DE COMPORTAMENTO, achado nº 3)', () => {
    it('ANTES o denominador era a janela inteira desde o 1º frame; AGORA cresce com a sessão', () => {
        const tracker = new PerclosTracker(CONFIG);
        tracker.markObservationStart(0);
        // 5s de sessão, 4s com os olhos fechados.
        tracker.recordClosedSegment({ start: 500, end: 4500 });
        const r = tracker.compute(5000, null, null);

        // ANTES: 4000 / 60000 = 6,7% — um PERCLOS baixo com cara de medida
        // válida, quando na verdade 80% do tempo observado foi com olho
        // fechado. Falso negativo silencioso.
        // DEPOIS: 4000 / 5000 = 80%.
        expect(r.validObservedMs).toBe(5000);
        expect(r.perclos).toBeCloseTo(0.80, 5);
    });

    it('observação abaixo de minObservationMs marca sufficient=false (a fusão então ignora o PERCLOS)', () => {
        const tracker = new PerclosTracker(CONFIG);
        tracker.markObservationStart(0);
        tracker.recordClosedSegment({ start: 500, end: 4500 });

        const early = tracker.compute(5000, null, null);
        expect(early.perclos).toBeCloseTo(0.80, 5); // calculado, útil pra gráfico
        expect(early.sufficient).toBe(false);       // mas não decide nada

        const later = tracker.compute(25000, null, null);
        expect(later.validObservedMs).toBe(25000);
        expect(later.sufficient).toBe(true);
    });

    it('sem markObservationStart explícito, o primeiro compute() define o início', () => {
        const tracker = new PerclosTracker(CONFIG);
        const r = tracker.compute(1_000_000, null, null);
        expect(r.validObservedMs).toBe(0);
        expect(r.perclos).toBe(0);
        expect(r.sufficient).toBe(false);
    });
});
