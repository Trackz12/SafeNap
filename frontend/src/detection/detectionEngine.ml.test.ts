import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DetectionEngine } from './detectionEngine';
import { metricsStore } from './metricsStore';
import { calibrationManager } from '../safety/calibrationManager';
import { drowsinessModel } from '../ml/drowsinessModel';
import { ML_STALE_MS } from '../ml/thresholds';
import type { FrameAnalysis } from '../vision/frameAnalyzer';

/**
 * Integração ML × regras no DetectionEngine real, com relógio controlado e o
 * score do ML injetado (o ONNX não roda aqui; ver drowsinessModel.test.ts).
 * Estes testes verificam a POLÍTICA de decisão, não a qualidade do modelo.
 */
function frame(ear: number, mouthAspect = 0.2): FrameAnalysis {
    return { ear, earL: ear, earR: ear, mouthAspect, noseDropRatio: 0.3, yawRatio: 0, quality: 'GOOD' };
}

describe('DetectionEngine — política ML × regras', () => {
    let engine: DetectionEngine;
    let t: number;

    const tick = (f: FrameAnalysis, ms = 100): void => {
        t += ms;
        vi.setSystemTime(t);
        engine.processFrame(f);
    };
    const mockMl = (score: number | null, ageMs = 0): void => {
        vi.spyOn(drowsinessModel, 'getLastScore').mockReturnValue(
            score === null ? { score: null, at: null } : { score, at: t - ageMs },
        );
    };

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // limiar padrão 0,25
        metricsStore.reset();
        engine = new DetectionEngine();
        t = 1_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(t);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('ML altíssimo com olhos abertos e nenhum sinal de regra → no máximo WARNING (nunca ALARM)', () => {
        for (let i = 0; i < 30; i++) { mockMl(0.99); tick(frame(0.35)); }
        expect(engine.getState()).toBe('WARNING');
        expect(metricsStore.get()?.reason).toBe('ML_WARNING');
    });

    it('ML altíssimo + regra de aviso (bocejo) → ML escala para ALARM', () => {
        for (let i = 0; i < 10; i++) { mockMl(0.99); tick(frame(0.35, 0.75)); } // 1 s de boca aberta
        expect(engine.getState()).toBe('ALARM');
        expect(metricsStore.get()?.reason).toBe('ML_ALARM');
    });

    it('bocejo sozinho (ML baixo) só gera WARNING', () => {
        for (let i = 0; i < 10; i++) { mockMl(0.1); tick(frame(0.35, 0.75)); }
        expect(engine.getState()).toBe('WARNING');
        expect(metricsStore.get()?.reason).toBe('YAWN');
    });

    it('ML indisponível (null): regras continuam gerando ALARM sozinhas', () => {
        for (let i = 0; i < 20; i++) { mockMl(null); tick(frame(0.05)); } // olhos bem fechados
        expect(engine.getState()).toBe('ALARM');
    });

    it('score ML velho (> ML_STALE_MS) é ignorado: sem WARNING vindo do ML', () => {
        for (let i = 0; i < 20; i++) { mockMl(0.99, ML_STALE_MS + 500); tick(frame(0.35)); }
        expect(engine.getState()).toBe('NORMAL');
        expect(metricsStore.get()?.mlScore).toBeNull();
    });

    it('modo rules ignora o ML por completo', () => {
        engine.setMode('rules');
        for (let i = 0; i < 20; i++) { mockMl(0.99); tick(frame(0.35, 0.75)); }
        expect(metricsStore.get()?.reason).toBe('YAWN');
        expect(engine.getState()).toBe('WARNING');
    });

    it('rosto perdido zera o ML (não fica score congelado do rosto anterior)', () => {
        const spy = vi.spyOn(drowsinessModel, 'reset');
        for (let i = 0; i < 5; i++) { mockMl(0.99); tick(frame(0.35)); }
        t += 100; vi.setSystemTime(t);
        engine.processNoFace();
        expect(spy).toHaveBeenCalled();
    });

    it('invariante: sob ML altíssimo, todo ALARM com razão ML_ALARM tem uma regra de aviso ativa (microsleep parcial incluso)', () => {
        for (let i = 0; i < 12; i++) {
            mockMl(0.99);
            tick(frame(0.05)); // olhos bem fechados: microsleep parcial + fechamento
            const m = metricsStore.get()!;
            if (m.state === 'ALARM' && m.reason === 'ML_ALARM') {
                expect(m.eyesClosed || m.perclos > 0 || m.yawnActive || m.headDropped).toBe(true);
            }
        }
    });

    // Caracterização (não é aprovação de design): a doc diz que o MICROSLEEP
    // respeita cooldown, mas o comportamento atual é falha-segura — após o
    // ack, olhos ainda fechados alarmam de novo sem esperar o cooldown.
    it('caracterização: após ackAlarm com olhos ainda fechados, o alarme volta (cooldown de micro-sono não bloqueia)', () => {
        for (let i = 0; i < 20; i++) tick(frame(0.05));
        expect(engine.getState()).toBe('ALARM');
        engine.ackAlarm();
        expect(engine.getState()).toBe('NORMAL');
        for (let i = 0; i < 25; i++) tick(frame(0.05));
        expect(engine.getState()).toBe('ALARM');
    });

    // Regressão: ackAlarm() não zerava belowThresholdStreak/closedCandidateSince,
    // dois contadores que já estavam "prontos" de antes do clique (a pessoa
    // estava em ALARM há segundos, com os olhos fechados). Resultado: o 1º
    // frame pós-clique já marcava eyesClosed=true de novo com um closedSince
    // efetivamente herdado do estado antigo — o alarme podia voltar bem abaixo
    // de qualquer limiar real (visto ao vivo: ~442ms, contra os 1500-1800ms
    // que o preset padrão exige). Corrigido; este teste trava o reset limpo:
    // logo após o ack, mesmo com os olhos ainda fechados, tem que passar por
    // uma janela de reavaliação inteira (não instantânea) antes de re-alarmar.
    it('após ackAlarm, o alarme NÃO volta em 1-2 frames mesmo com olhos ainda fechados (reset precisa ser limpo)', () => {
        for (let i = 0; i < 20; i++) tick(frame(0.05));
        expect(engine.getState()).toBe('ALARM');
        engine.ackAlarm();
        expect(engine.getState()).toBe('NORMAL');

        tick(frame(0.05)); // 1 frame pós-ack (100ms): não pode já estar em ALARM
        expect(engine.getState()).toBe('NORMAL');
        tick(frame(0.05)); // 2 frames pós-ack (200ms): idem
        expect(engine.getState()).toBe('NORMAL');
    });
});
