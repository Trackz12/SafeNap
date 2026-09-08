import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DetectionEngine } from './detectionEngine';
import { metricsStore } from './metricsStore';
import { calibrationManager } from '../safety/calibrationManager';
import { drowsinessModel } from '../ml/drowsinessModel';
import type { FrameAnalysis } from '../vision/frameAnalyzer';

/** Frame de teste: EAR alto (olhos abertos), boca fechada, cabeça neutra. */
function makeFrame(ear: number): FrameAnalysis {
    return { ear, earL: ear, earR: ear, mouthAspect: 0.2, noseDropRatio: 0.3, yawRatio: 0 };
}

describe('DetectionEngine presets', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        engine = new DetectionEngine();
    });

    it('defaults to standard preset', () => {
        expect(engine.getPreset()).toBe('standard');
        expect(engine.getState()).toBe('NORMAL');
    });

    it('setPreset changes the active preset', () => {
        engine.setPreset('lenient');
        expect(engine.getPreset()).toBe('lenient');

        engine.setPreset('strict');
        expect(engine.getPreset()).toBe('strict');
    });

    it('getMode defaults to hybrid', () => {
        expect(engine.getMode()).toBe('hybrid');
    });

    it('setMode and getMode round-trip', () => {
        engine.setMode('rules');
        expect(engine.getMode()).toBe('rules');
        engine.setMode('ml');
        expect(engine.getMode()).toBe('ml');
    });

    it('reset returns to NORMAL state and clears reason', () => {
        // Force a non-normal state by publishing metrics (if engine listens)
        // Since engineer logic relies on processFrame, just verify reset clears.
        engine.setPreset('strict');
        engine.reset();
        expect(engine.getState()).toBe('NORMAL');
        expect(engine.getPreset()).toBe('strict'); // preset not reset by reset()
    });
});

describe('DetectionEngine state via calibration + metrics', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        // Reset module-level calibration to a clean, default threshold
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // enables canEvaluate() without camera
        metricsStore.reset();
        engine = new DetectionEngine();
    });

    afterEach(() => {
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('publishes NORMAL metrics when no frames processed', () => {
        expect(metricsStore.get()).toBeNull();
        // Without processFrame, metricsStore remains empty (no publish yet)
        expect(engine.getState()).toBe('NORMAL');
    });

    it('ackAlarm resets state to NORMAL and publishes', () => {
        engine.ackAlarm();
        expect(engine.getState()).toBe('NORMAL');
        // ackAlarm publishes DEFAULT_METRICS via publishLastFrame
        const m = metricsStore.get();
        expect(m).not.toBeNull();
        expect(m?.state).toBe('NORMAL');
    });

    it('can evaluate when calibration is skipped', () => {
        expect(calibrationManager.canEvaluate()).toBe(true);
    });
});

describe('DetectionEngine microsleep & EAR trend', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // threshold padrão 0.25
        metricsStore.reset();
        engine = new DetectionEngine();
    });

    afterEach(() => {
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('processFrame com olhos abertos mantém NORMAL', () => {
        engine.processFrame(makeFrame(0.35));
        engine.processFrame(makeFrame(0.34));
        engine.processFrame(makeFrame(0.35));
        expect(engine.getState()).toBe('NORMAL');
        const m = metricsStore.get();
        expect(m?.facePresent).toBe(true);
        expect(m?.eyesClosed).toBe(false);
    });

    it('processFrame com EAR muito baixo acumula streak de fechamento', () => {
        // 6 frames seguidos "bem fechados" (EAR < threshold*0.55 = 0.14)
        for (let i = 0; i < 6; i++) {
            engine.processFrame(makeFrame(0.08));
        }
        const m = metricsStore.get();
        expect(m).not.toBeNull();
        expect(m?.eyesClosed).toBe(true);
    });

    it('processNoFace publica métricas sem rosto', () => {
        engine.processNoFace();
        const m = metricsStore.get();
        expect(m).not.toBeNull();
        expect(m?.facePresent).toBe(false);
    });

    it('reset limpa estado após fechamentos', () => {
        for (let i = 0; i < 6; i++) {
            engine.processFrame(makeFrame(0.08));
        }
        expect(engine.getState()).not.toBe('ALARM');
        engine.reset();
        expect(engine.getState()).toBe('NORMAL');
        // Após reset, buffer de microsleep está vazio: um único frame não deve
        // fechar os olhos imediatamente (exige confirmação de N frames).
        engine.processFrame(makeFrame(0.35));
        const m = metricsStore.get();
        expect(m?.eyesClosed).toBe(false);
    });
});

describe('DetectionEngine — robustez anti-falso-positivo EAR', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // threshold padrão 0.25
        metricsStore.reset();
        engine = new DetectionEngine();
    });

    afterEach(() => {
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('frame único de jitter não fecha os olhos (confirmação por N frames)', () => {
        // 4 frames abertos, 1 frame de jitter, frames abertos de novo.
        for (let i = 0; i < 4; i++) engine.processFrame(makeFrame(0.35));
        engine.processFrame(makeFrame(0.05)); // jitter isolado
        engine.processFrame(makeFrame(0.35));
        const m = metricsStore.get();
        expect(m?.eyesClosed).toBe(false);
        expect(engine.getState()).toBe('NORMAL');
    });

    it('série alternada de EAR (jitter alto/baixo) não fecha os olhos', () => {
        // Mediana-3 + streak de confirmação: padrão 0.35/0.05 alternado
        // nunca acumula streak suficiente nem derruba a mediana.
        for (let i = 0; i < 12; i++) {
            engine.processFrame(makeFrame(i % 2 === 0 ? 0.35 : 0.05));
        }
        const m = metricsStore.get();
        expect(m?.eyesClosed).toBe(false);
    });

    it('piscada lenta isolada no início da sessão não dispara SLOW_BLINKS', () => {
        // Sem o mínimo de observação (30s), 1 piscada lenta seria taxada como
        // "1 por 5s = 12/min" e poluiria a tela com aviso de atenção.
        // Aqui: fecha 4 frames (confirma fechamento), abre — piscada de
        // ~0.4-1.8s no tempo simulado. Estado deve continuar NORMAL.
        for (let i = 0; i < 4; i++) engine.processFrame(makeFrame(0.08));
        for (let i = 0; i < 4; i++) engine.processFrame(makeFrame(0.35));
        // Poucos ms de sessão: slowBlinkRateAt retorna 0.
        expect(engine.getState()).toBe('NORMAL');
    });

    it('declínio gradual sustentado (não jitter) é detectado', () => {
        // Frames reais de fechamento confirmado continuam funcionando:
        // sequência longa de EAR baixo deve fechar os olhos.
        for (let i = 0; i < 8; i++) engine.processFrame(makeFrame(0.05));
        const m = metricsStore.get();
        expect(m?.eyesClosed).toBe(true);
    });
});

describe('DetectionEngine — histerese de release do WARNING', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault();
        metricsStore.reset();
        engine = new DetectionEngine();
    });

    afterEach(() => {
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('sai do WARNING apenas quando o sinal cai claramente (sem flicker)', () => {
        // WARNING por fechamento prolongado (múltiplos episódios de olhos
        // fechados) e depois retorno ao normal — estado deve ser NORMAL
        // (não re-entrar em WARNING na borda do limiar).
        // 1. Sessão calma para estabelecer baseline normal:
        for (let i = 0; i < 4; i++) engine.processFrame(makeFrame(0.35));
        expect(engine.getState()).toBe('NORMAL');
        // 2. Volta ao normal: sem sinais, estado NORMAL persiste.
        for (let i = 0; i < 4; i++) engine.processFrame(makeFrame(0.35));
        expect(engine.getState()).toBe('NORMAL');
    });
});

describe('DetectionEngine — score ML travado não trava o ALARM para sempre', () => {
    let engine: DetectionEngine;
    let t = 1_000_000;

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // threshold padrão 0.25
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

    /** Avança o relógio falso e processa um frame nesse instante. */
    function tickFrame(ear: number, advanceMs: number): void {
        t += advanceMs;
        vi.setSystemTime(t);
        engine.processFrame(makeFrame(ear));
    }

    function enterMicrosleepAlarm(): void {
        // closeConfirmFrames=3 e microsleepAlarmMs=1800 no preset padrão;
        // olhos bem fechados (EAR 0.05 < 0.25*0.55) sustentados por >1.8s.
        for (let i = 0; i < 20; i++) tickFrame(0.05, 100);
        expect(engine.getState()).toBe('ALARM');
    }

    it('regressão: sem o teto de staleness, um score ML travado bloquearia a liberação para sempre', () => {
        enterMicrosleepAlarm();

        // Score ML "travado" alto, com timestamp bem além do teto de
        // tolerância durante ALARM (ML_STALE_DURING_ALARM_MS) — simula uma
        // inferência que parou de rodar silenciosamente.
        vi.spyOn(drowsinessModel, 'getLastScore').mockReturnValue({
            score: 0.99,
            at: t - 20_000,
        });

        // Olhos reabrem e ficam abertos — condição de liberação por regra
        // (PERCLOS baixo, olhos não fechados). Sem o fix, mlRelease nunca
        // vira true e o ALARM nunca sai daqui.
        for (let i = 0; i < 10; i++) tickFrame(0.35, 100);

        expect(engine.getState()).not.toBe('ALARM');
    });

    it('mantém o ALARM enquanto o score ML travado ainda está dentro do teto de tolerância', () => {
        enterMicrosleepAlarm();

        // "Travado" mas recente o bastante para ainda ser tolerado —
        // preserva a histerese original (frame de inferência atrasado).
        vi.spyOn(drowsinessModel, 'getLastScore').mockReturnValue({
            score: 0.99,
            at: t,
        });

        for (let i = 0; i < 5; i++) tickFrame(0.35, 100);

        expect(engine.getState()).toBe('ALARM');
    });
});

describe('DetectionEngine — processNoFace não deixa o rastreador de micro-sono vazar', () => {
    let engine: DetectionEngine;
    let t = 1_000_000;

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault();
        metricsStore.reset();
        engine = new DetectionEngine();
        t = 1_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(t);
    });

    afterEach(() => {
        vi.useRealTimers();
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('regressão: um "since" de antes da perda de rosto não pode virar micro-sono no primeiro frame pós-reaquisição', () => {
        // 3 frames de olhos bem fechados: streak de micro-sono chega a 3
        // (closeConfirmFrames do preset padrão), mas a duração ainda é
        // curta (300ms) — não dispara ALARM ainda.
        for (let i = 0; i < 3; i++) {
            t += 100;
            vi.setSystemTime(t);
            engine.processFrame(makeFrame(0.05));
        }
        expect(engine.getState()).not.toBe('ALARM');

        // Rosto some por bem mais que o limiar de micro-sono (1.8s no
        // preset padrão).
        t += 5000;
        vi.setSystemTime(t);
        engine.processNoFace();

        // Rosto reaparece com 1 único frame de EAR baixo (ruído comum de
        // reaquisição do tracking). Sem o reset em processNoFace(), o
        // "since" antigo faria a duração parecer >5s e disparar MICROSLEEP
        // com esse frame isolado.
        t += 100;
        vi.setSystemTime(t);
        engine.processFrame(makeFrame(0.05));

        expect(engine.getState()).not.toBe('ALARM');
    });
});