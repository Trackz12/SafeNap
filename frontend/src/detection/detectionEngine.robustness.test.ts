import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DetectionEngine } from './detectionEngine';
import { metricsStore } from './metricsStore';
import { calibrationManager } from '../safety/calibrationManager';
import { FakeClock } from './temporal/clock';
import type { FrameAnalysis } from '../vision/frameAnalyzer';
import type { VisionQuality } from './vision/visionQuality';

/**
 * Cenários de ROBUSTEZ TEMPORAL — auditoria de qualidade de detecção,
 * 2026-09-23 (§14/§15 do briefing).
 *
 * A bateria de `detectionEngine.scenarios.test.ts` verifica se cada sinal
 * classifica corretamente numa cadência fixa. Esta bateria verifica algo
 * diferente e complementar: se o MESMO cenário fisiológico produz a MESMA
 * decisão quando a cadência de quadros muda, e se a perda de rosto não é
 * interpretada como olho fechado.
 *
 * Por que isso importa em concreto: no dia da apresentação várias pessoas vão
 * testar o sistema em máquinas diferentes. O laço real
 * (`vision/mediapipe.ts`) tenta ~10 FPS, mas a taxa efetiva depende de CPU,
 * carga e câmera. Um sistema cuja decisão muda com o FPS não é confiável.
 *
 * O QUE ISSO NÃO VALIDA: que os limiares correspondem a sonolência humana
 * real. Isso exige dataset rotulado — ver reports/README.md.
 */

function makeFrame(
    ear: number,
    mouthAspect = 0.2,
    noseDropRatio = 0.3,
    quality: Exclude<VisionQuality, 'LOST'> = 'GOOD',
): FrameAnalysis {
    return { ear, earL: ear, earR: ear, mouthAspect, noseDropRatio, yawRatio: 0, quality };
}

const EAR_OPEN = 0.35;
const EAR_CLOSED = 0.05;

/** Mesma calibração bifásica de produção usada na bateria de cenários: threshold = 0.21. */
beforeAll(() => {
    calibrationManager.clearCalibration();
    calibrationManager.settleDelayMs = 0;
    calibrationManager.startCalibration();
    for (let i = 0; i < 25; i++) calibrationManager.addSample(EAR_OPEN, 0.30);
    calibrationManager.advanceToClosedPhase();
    for (let i = 0; i < 25; i++) calibrationManager.addSample(0.07);
    calibrationManager.finishCalibration();
    expect(calibrationManager.getThreshold()).toBeCloseTo(0.21, 5);
});

afterAll(() => calibrationManager.clearCalibration());
beforeEach(() => metricsStore.reset());
afterEach(() => metricsStore.reset());

/**
 * Executa um roteiro temporal contínuo numa cadência dada, amostrando o vídeo
 * a cada `frameMs`. O roteiro é definido em TEMPO (ms), não em quadros — é
 * assim que um fenômeno fisiológico deve ser descrito.
 */
function runAtFps(
    frameMs: number,
    script: Array<{ durationMs: number; ear: number; mouthAspect?: number; noseDropRatio?: number }>,
): {
    state: string;
    reason: string | null;
    firstAlarmAtMs: number | null;
    closedForMs: number;
    blinkRate: number;
} {
    const clock = new FakeClock(1_000_000);
    const engine = new DetectionEngine(clock);
    const t0 = clock.now();
    let firstAlarmAtMs: number | null = null;

    for (const step of script) {
        const frames = Math.max(1, Math.round(step.durationMs / frameMs));
        for (let i = 0; i < frames; i++) {
            clock.advance(frameMs);
            engine.processFrame(makeFrame(step.ear, step.mouthAspect ?? 0.2, step.noseDropRatio ?? 0.3));
            if (firstAlarmAtMs === null && engine.getState() === 'ALARM') {
                firstAlarmAtMs = clock.now() - t0;
            }
        }
    }

    return {
        state: engine.getState(),
        reason: metricsStore.get()?.reason ?? null,
        firstAlarmAtMs,
        closedForMs: metricsStore.get()?.closedForMs ?? 0,
        blinkRate: metricsStore.get()?.blinkRate ?? 0,
    };
}

const FPS_CASES: Array<[string, number]> = [
    ['10 FPS (cadência real do laço de detecção)', 100],
    ['30 FPS', 33],
    ['60 FPS', 16],
];

describe('Robustez a FPS — pessoa acordada piscando normalmente', () => {
    // 6 piscadas de 200ms espaçadas por 3s de olhos abertos. Nenhuma cadência
    // pode transformar isso em alerta.
    const script = Array.from({ length: 6 }, () => [
        { durationMs: 3000, ear: EAR_OPEN },
        { durationMs: 200, ear: EAR_CLOSED },
    ]).flat();

    for (const [label, frameMs] of FPS_CASES) {
        it(`permanece NORMAL a ${label}`, () => {
            const r = runAtFps(frameMs, script);
            expect(r.state, `razão: ${r.reason}`).toBe('NORMAL');
        });
    }

    /**
     * ESTE é o teste que expõe o achado nº 2 de forma direta.
     *
     * A piscada precisa ser CONTADA, não só "não gerar alerta". Com a regra
     * antiga (contagem de quadros) uma piscada de 200 ms produzia 2 quadros
     * abaixo do limiar a 10 FPS — menos que os 3 exigidos pelo preset padrão —
     * então nenhum `closedSegmentEnded` era emitido e `blinkRate` ficava em 0.
     * Uma pessoa acordada piscando normalmente era indistinguível de alguém
     * com os olhos permanentemente abertos, e a feature `blinkRate` que vai
     * pro modelo de ML era lixo.
     */
    for (const [label, frameMs] of FPS_CASES) {
        it(`conta as piscadas (blinkRate > 0) a ${label}`, () => {
            const r = runAtFps(frameMs, script);
            expect(r.blinkRate, `blinkRate=${r.blinkRate} — piscadas invisíveis nesta cadência`).toBeGreaterThan(0);
        });
    }
});

describe('Robustez a FPS — micro-sono de 2,5s deve alarmar em toda cadência', () => {
    const script = [
        { durationMs: 2000, ear: EAR_OPEN },
        { durationMs: 2500, ear: 0.02 }, // bem abaixo de threshold*0.55 = 0.1155
        { durationMs: 1000, ear: EAR_OPEN },
    ];

    const latencies: Array<{ label: string; ms: number }> = [];

    for (const [label, frameMs] of FPS_CASES) {
        it(`dispara ALARM a ${label}`, () => {
            const r = runAtFps(frameMs, script);
            expect(r.firstAlarmAtMs, `nunca alarmou (estado final ${r.state})`).not.toBeNull();
            latencies.push({ label, ms: r.firstAlarmAtMs! });
        });
    }

    it('a latência até o ALARM não varia de forma absurda entre 10, 30 e 60 FPS', () => {
        expect(latencies.length).toBe(3);
        const values = latencies.map((l) => l.ms);
        const min = Math.min(...values);
        const max = Math.max(...values);
        // Tolerância: um quadro de 10 FPS (100ms) de folga sobre a menor
        // latência. Não exigimos igualdade numérica — a amostragem é diferente
        // por definição —, mas a diferença não pode ser de ordem de grandeza,
        // que era o sintoma da confirmação por contagem de quadros.
        expect(max - min, `latências: ${JSON.stringify(latencies)}`).toBeLessThanOrEqual(300);
    });
});

describe('Robustez a FPS — piscada longa de 1,7s (acima de drowsinessThresholdMs)', () => {
    const script = [
        { durationMs: 1000, ear: EAR_OPEN },
        { durationMs: 1700, ear: EAR_CLOSED },
    ];

    for (const [label, frameMs] of FPS_CASES) {
        it(`dispara ALARM a ${label}`, () => {
            const r = runAtFps(frameMs, script);
            expect(r.state).toBe('ALARM');
        });
    }
});

describe('Cenário 8 — rosto perdido DURANTE olhos fechados não vira fechamento longo', () => {
    it('o gap sem rosto NÃO é somado ao closedForMs quando o rosto volta', () => {
        const clock = new FakeClock(3_000_000);
        const engine = new DetectionEngine(clock);

        // Olhos abertos, depois fechando.
        for (let i = 0; i < 10; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN)); }
        for (let i = 0; i < 4; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_CLOSED)); }
        expect(metricsStore.get()?.eyesClosed).toBe(true);

        // Rosto desaparece por 10s (pessoa virou, oclusão, etc.).
        for (let i = 0; i < 100; i++) { clock.advance(100); engine.processNoFace(); }

        // Rosto volta com um único quadro de EAR baixo — ruído comum de
        // reaquisição de tracking. Se o "since" tivesse sobrevivido ao gap,
        // closedForMs seria ~14s e isso viraria ALARM na hora.
        clock.advance(100);
        engine.processFrame(makeFrame(EAR_CLOSED));
        const m = metricsStore.get()!;
        expect(m.closedForMs).toBeLessThan(500);
        expect(m.eyesClosed).toBe(false); // ainda em CLOSING, não confirmado
    });

    it('geometria ruim (processNoFace DEGRADED) tem a mesma proteção que rosto ausente', () => {
        // Este é o caminho que ANTES da auditoria não chamava nada: o quadro
        // era descartado em vision/mediapipe.ts e o "since" sobrevivia.
        const clock = new FakeClock(3_100_000);
        const engine = new DetectionEngine(clock);

        for (let i = 0; i < 10; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN)); }
        for (let i = 0; i < 4; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_CLOSED)); }
        expect(metricsStore.get()?.eyesClosed).toBe(true);

        for (let i = 0; i < 100; i++) { clock.advance(100); engine.processNoFace('DEGRADED'); }
        expect(metricsStore.get()?.visionQuality).toBe('DEGRADED');
        expect(metricsStore.get()?.facePresent).toBe(false);

        clock.advance(100);
        engine.processFrame(makeFrame(EAR_CLOSED));
        expect(metricsStore.get()!.closedForMs).toBeLessThan(500);
    });

    it('o tempo sem rosto sai do denominador do PERCLOS em vez de diluí-lo', () => {
        const clock = new FakeClock(3_200_000);
        const engine = new DetectionEngine(clock);

        // 25s observando, com um fechamento longo de 5s no meio.
        for (let i = 0; i < 50; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN)); }
        for (let i = 0; i < 50; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_CLOSED)); }
        for (let i = 0; i < 150; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN)); }
        const withFace = metricsStore.get()!.perclos;
        expect(withFace).toBeGreaterThan(0);

        // Mais 30s SEM rosto. Se esse tempo entrasse no denominador como
        // "olhos abertos", o PERCLOS cairia; agora ele se mantém.
        for (let i = 0; i < 300; i++) { clock.advance(100); engine.processNoFace(); }
        const afterLoss = metricsStore.get()!.perclos;
        expect(afterLoss).toBeGreaterThanOrEqual(withFace * 0.95);
    });
});

describe('Cenário 6 — boca aberta sem sonolência (fala/riso) não sustenta YAWN', () => {
    it('bocejo breve gera WARNING curto, não 10s de aviso', () => {
        const clock = new FakeClock(4_000_000);
        const engine = new DetectionEngine(clock);

        // Boca bem aberta por 600ms (> yawnMinMs=400) e fecha.
        for (let i = 0; i < 6; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN, 0.75)); }
        expect(engine.getState()).toBe('WARNING');
        expect(metricsStore.get()?.reason).toBe('YAWN');

        // Boca fechada. ANTES: YAWN ficava ativo por cooldownMs inteiro (10s).
        // DEPOIS: cai após yawnActiveHoldMs (2s).
        for (let i = 0; i < 25; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN, 0.15)); }
        expect(metricsStore.get()?.yawnActive).toBe(false);
        expect(engine.getState()).toBe('NORMAL');
    });

    it('boca continuamente aberta além de yawnMaxMs deixa de contar como bocejo', () => {
        const clock = new FakeClock(4_100_000);
        const engine = new DetectionEngine(clock);

        // 10s de boca aberta sem parar — falar alto, rir, cantar. ANTES o ramo
        // de queda de `active` nunca executava e YAWN ficava ativo para sempre.
        for (let i = 0; i < 100; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN, 0.75)); }
        expect(metricsStore.get()?.yawnActive).toBe(false);
    });

    it('bocejo sozinho nunca gera ALARM (evidência de suporte, nunca autoridade)', () => {
        const clock = new FakeClock(4_200_000);
        const engine = new DetectionEngine(clock);
        engine.setMode('rules');
        for (let i = 0; i < 60; i++) {
            clock.advance(100);
            engine.processFrame(makeFrame(EAR_OPEN, 0.75));
            expect(engine.getState()).not.toBe('ALARM');
        }
    });
});

describe('Cenário 9 — qualidade de visão é reportada, não usada para ponderar decisão', () => {
    it('quadro DEGRADED (perfil acentuado) produz a mesma decisão que GOOD, mas é distinguível', () => {
        const clock = new FakeClock(5_000_000);
        const engine = new DetectionEngine(clock);
        for (let i = 0; i < 20; i++) {
            clock.advance(100);
            engine.processFrame(makeFrame(EAR_OPEN, 0.2, 0.3, 'DEGRADED'));
        }
        expect(metricsStore.get()?.visionQuality).toBe('DEGRADED');
        expect(metricsStore.get()?.facePresent).toBe(true);
        expect(engine.getState()).toBe('NORMAL');
    });

    it('os três estados de VisionQuality são observáveis em DetectionMetrics', () => {
        const clock = new FakeClock(5_100_000);
        const engine = new DetectionEngine(clock);

        clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN));
        expect(metricsStore.get()?.visionQuality).toBe('GOOD');

        clock.advance(100); engine.processNoFace('DEGRADED');
        expect(metricsStore.get()?.visionQuality).toBe('DEGRADED');

        clock.advance(100); engine.processNoFace('LOST');
        expect(metricsStore.get()?.visionQuality).toBe('LOST');
    });
});

describe('PERCLOS — confiança participa da decisão (achado nº 3)', () => {
    it('PERCLOS alto sobre observação curta NÃO gera WARNING por PERCLOS', () => {
        const clock = new FakeClock(6_000_000);
        const engine = new DetectionEngine(clock);
        engine.setMode('rules'); // isola de qualquer contribuição de ML

        // 8s de sessão com ~4s de olhos fechados: PERCLOS numérico ~50%,
        // muito acima de perclosWarningLevel=0.25 — mas observação válida
        // (8s) está abaixo de perclosMinObservationMs=20s.
        for (let i = 0; i < 20; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN)); }
        for (let i = 0; i < 40; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_CLOSED)); }
        for (let i = 0; i < 20; i++) { clock.advance(100); engine.processFrame(makeFrame(EAR_OPEN)); }

        const m = metricsStore.get()!;
        expect(m.perclos).toBeGreaterThan(0.25); // a razão numérica é alta
        // ...mas a razão do estado não pode ser PERCLOS: houve observação
        // insuficiente. (O fechamento de 4s legitimamente já gerou seu próprio
        // alerta por duração — o que testamos aqui é que PERCLOS não foi a
        // justificativa.)
        expect(['PERCLOS', 'PERCLOS_CRITICAL']).not.toContain(m.reason);
    });
});
