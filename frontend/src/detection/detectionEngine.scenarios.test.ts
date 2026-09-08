import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DetectionEngine, type DetectionState } from './detectionEngine';
import { metricsStore } from './metricsStore';
import { calibrationManager } from '../safety/calibrationManager';
import type { FrameAnalysis } from '../vision/frameAnalyzer';

/**
 * Bateria de cenários sintéticos da engine de detecção (visão computacional).
 *
 * O QUE ISSO VALIDA: que o código faz o que a especificação diz que faz —
 * cada cenário representa uma faixa de duração/intensidade fisiologicamente
 * plausível (piscada normal, fechamento prolongado, bocejo, queda de
 * cabeça, tendência de sonolência) e verificamos se a máquina de estados
 * classifica corretamente (verdade-fundamental atribuída por nós, com base
 * nos próprios limiares documentados em docs/DETECTION.md).
 *
 * O QUE ISSO **NÃO** VALIDA: que esses limiares (700ms, 0,25 de PERCLOS,
 * fator 0,55 etc.) correspondem à sonolência real de uma pessoa de verdade.
 * Isso é verificação de engenharia (o código bate com a especificação),
 * não validação empírica (a especificação bate com fisiologia humana real
 * em condições reais de condução) — essa segunda parte exige testes com
 * condutores reais ou datasets rotulados por humanos, que ficam como
 * trabalho futuro (ver reports/README.md).
 *
 * Roda como parte da suíte normal (`npx vitest run`) e também escreve um
 * relatório reprodutível em reports/detection_scenarios/.
 */

function makeFrame(ear: number, mouthAspect = 0.2, noseDropRatio = 0.3): FrameAnalysis {
    return { ear, earL: ear, earR: ear, mouthAspect, noseDropRatio, yawRatio: 0 };
}

/** Controla o relógio falso manualmente (vi.setSystemTime), sem depender de timers reais. */
function makeClock(startAt: number) {
    let t = startAt;
    vi.setSystemTime(t);
    return {
        advance(ms: number): void {
            t += ms;
            vi.setSystemTime(t);
        },
        now: () => t,
    };
}

interface ScenarioResult {
    name: string;
    description: string;
    groundTruth: DetectionState;
    predicted: DetectionState;
    predictedReason: string | null;
    correct: boolean;
}

const results: ScenarioResult[] = [];

function record(
    name: string,
    description: string,
    groundTruth: DetectionState,
    engine: DetectionEngine,
): void {
    const predicted = engine.getState();
    const predictedReason = metricsStore.get()?.reason ?? null;
    const r: ScenarioResult = {
        name,
        description,
        groundTruth,
        predicted,
        predictedReason,
        correct: predicted === groundTruth,
    };
    results.push(r);
    expect(predicted, `${name}: esperado ${groundTruth}, obtido ${predicted} (razão: ${predictedReason})`).toBe(groundTruth);
}

// Calibração compartilhada por todos os cenários — mesmo procedimento
// bifásico usado em produção (docs/DETECTION.md), não um atalho:
// fase 1 (olhos abertos, EAR~0.35, nose-drop~0.30) + fase 2 (olhos
// fechados, EAR~0.07). threshold = clamp((0.35+0.07)/2, 0.12, 0.45) = 0.21.
beforeAll(() => {
    calibrationManager.clearCalibration();
    calibrationManager.settleDelayMs = 0;
    calibrationManager.startCalibration();
    for (let i = 0; i < 25; i++) calibrationManager.addSample(0.35, 0.30);
    calibrationManager.advanceToClosedPhase();
    for (let i = 0; i < 25; i++) calibrationManager.addSample(0.07);
    calibrationManager.finishCalibration();
    expect(calibrationManager.isCalibrated()).toBe(true);
    expect(calibrationManager.getThreshold()).toBeCloseTo(0.21, 5);
});

afterEach(() => {
    vi.useRealTimers();
    metricsStore.reset();
});

afterAll(() => {
    calibrationManager.clearCalibration();

    const outDir = path.resolve(__dirname, '../../../reports/detection_scenarios');
    fs.mkdirSync(outDir, { recursive: true });

    const total = results.length;
    const correct = results.filter((r) => r.correct).length;

    // Matriz de confusão binária: "alerta" (WARNING ou ALARM) vs "sem alerta" (NORMAL).
    const isAlert = (s: DetectionState) => s !== 'NORMAL';
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of results) {
        const gt = isAlert(r.groundTruth);
        const pred = isAlert(r.predicted);
        if (gt && pred) tp++;
        else if (!gt && pred) fp++;
        else if (!gt && !pred) tn++;
        else fn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    const jsonReport = {
        methodology:
            'Cenários sintéticos executados contra o DetectionEngine real (não uma reimplementação), ' +
            'com relógio controlado (vi.setSystemTime) para atingir durações exatas. Verdade-fundamental ' +
            'atribuída pelos autores com base nos limiares documentados em docs/DETECTION.md — isto é ' +
            'verificação de especificação, não validação com dados humanos reais.',
        totalScenarios: total,
        correct,
        accuracy: total > 0 ? correct / total : 0,
        confusionMatrixBinary: { tp, fp, tn, fn, precision, recall, f1 },
        scenarios: results,
    };
    fs.writeFileSync(path.join(outDir, 'scenarios.json'), JSON.stringify(jsonReport, null, 2), 'utf-8');

    const md: string[] = [
        '# Bateria de cenários sintéticos — Detection Engine',
        '',
        jsonReport.methodology,
        '',
        `**${correct}/${total}** cenários classificados conforme a verdade-fundamental atribuída.`,
        '',
        '## Matriz de confusão (binária: alerta = WARNING ou ALARM vs. sem alerta = NORMAL)',
        '',
        '| | Previsto: alerta | Previsto: sem alerta |',
        '|---|---|---|',
        `| **Real: alerta** | VP=${tp} | FN=${fn} |`,
        `| **Real: sem alerta** | FP=${fp} | VN=${tn} |`,
        '',
        `Precisão: **${precision.toFixed(3)}** · Revocação (recall): **${recall.toFixed(3)}** · F1: **${f1.toFixed(3)}**`,
        '',
        '## Cenários individuais',
        '',
        '| Cenário | Descrição | Verdade | Previsto | Razão | OK |',
        '|---|---|---|---|---|---|',
        ...results.map(
            (r) =>
                `| ${r.name} | ${r.description} | ${r.groundTruth} | ${r.predicted} | ${r.predictedReason ?? '—'} | ${r.correct ? '✅' : '❌'} |`,
        ),
    ];
    fs.writeFileSync(path.join(outDir, 'scenarios.md'), md.join('\n') + '\n', 'utf-8');
});

describe('Bateria de cenários — piscadas (não devem gerar alerta)', () => {
    it('piscada curta (~60ms) — dentro da faixa normal de piscada', () => {
        const clock = makeClock(1_000_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05)); // closedSince ~ +1
        clock.advance(37); engine.processFrame(makeFrame(0.05));
        clock.advance(20); engine.processFrame(makeFrame(0.35)); // reabre; duração ~60ms
        record('blink_curto_60ms', 'Piscada de ~60ms (limite inferior da faixa normal 50-400ms)', 'NORMAL', engine);
    });

    it('piscada típica (~200ms)', () => {
        const clock = makeClock(1_000_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(177); engine.processFrame(makeFrame(0.05));
        clock.advance(20); engine.processFrame(makeFrame(0.35)); // duração ~200ms
        record('blink_tipico_200ms', 'Piscada típica de ~200ms', 'NORMAL', engine);
    });

    it('piscada no limite superior (~390ms)', () => {
        const clock = makeClock(1_000_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(367); engine.processFrame(makeFrame(0.05));
        clock.advance(20); engine.processFrame(makeFrame(0.35)); // duração ~390ms
        record('blink_limite_390ms', 'Piscada de ~390ms (limite superior da faixa normal, maxBlinkMs=400)', 'NORMAL', engine);
    });
});

describe('Bateria de cenários — fechamento prolongado dos olhos', () => {
    it('fechamento de 600ms — abaixo do limiar de aviso (700ms)', () => {
        const clock = makeClock(2_000_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(597); engine.processFrame(makeFrame(0.05)); // closedForMs ~600ms, ainda fechado
        record('fechamento_abaixo_aviso_600ms', 'Olhos fechados por 600ms (< warnCloseMs=700ms)', 'NORMAL', engine);
    });

    it('fechamento de 900ms — dispara aviso (PROLONGED_CLOSE)', () => {
        const clock = makeClock(2_100_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(897); engine.processFrame(makeFrame(0.05)); // closedForMs ~900ms
        record('fechamento_prolongado_900ms', 'Olhos fechados por 900ms (> warnCloseMs=700ms)', 'WARNING', engine);
    });

    it('fechamento de 1700ms — dispara alarme (EYES_CLOSED_DURATION)', () => {
        const clock = makeClock(2_200_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1697); engine.processFrame(makeFrame(0.05)); // closedForMs ~1700ms
        record('fechamento_critico_1700ms', 'Olhos fechados por 1700ms (> drowsinessThresholdMs=1500ms)', 'ALARM', engine);
    });

    it('micro-sono agudo — EAR bem abaixo do limiar por 2000ms (MICROSLEEP)', () => {
        const clock = makeClock(2_300_000);
        const engine = new DetectionEngine();
        // 0.05 < 0.21 * 0.55 (0.1155) — "bem fechado", nível de micro-sono.
        clock.advance(1); engine.processFrame(makeFrame(0.02));
        clock.advance(1); engine.processFrame(makeFrame(0.02));
        clock.advance(1); engine.processFrame(makeFrame(0.02));
        clock.advance(1997); engine.processFrame(makeFrame(0.02)); // ~2000ms > microsleepAlarmMs=1800ms
        record('microsleep_agudo_2000ms', 'EAR muito baixo (nível micro-sono) sustentado por 2000ms', 'ALARM', engine);
    });

    it('recuperação após alarme — reabertura sustentada volta a NORMAL', () => {
        const clock = makeClock(2_400_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1); engine.processFrame(makeFrame(0.05));
        clock.advance(1697); engine.processFrame(makeFrame(0.05));
        expect(engine.getState()).toBe('ALARM'); // pré-condição do cenário
        // Reabre e mantém aberto — PERCLOS decai abaixo do release level (0.15).
        for (let i = 0; i < 5; i++) {
            clock.advance(200);
            engine.processFrame(makeFrame(0.35));
        }
        record('recuperacao_apos_alarme', 'Reabertura sustentada dos olhos após ALARM (EYES_CLOSED_DURATION)', 'NORMAL', engine);
    });
});

describe('Bateria de cenários — bocejo', () => {
    it('bocejo confirmado (~500ms)', () => {
        const clock = makeClock(3_000_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.35, 0.75));
        clock.advance(499); engine.processFrame(makeFrame(0.35, 0.75)); // ~500ms > yawnMinMs=400ms
        record('bocejo_confirmado_500ms', 'Boca aberta (aspect 0.75) sustentada por 500ms', 'WARNING', engine);
    });

    it('bocejo não confirmado (~200ms, abaixo do mínimo)', () => {
        const clock = makeClock(3_100_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.35, 0.75));
        clock.advance(199); engine.processFrame(makeFrame(0.35, 0.75)); // ~200ms < yawnMinMs=400ms
        record('bocejo_nao_confirmado_200ms', 'Boca aberta por apenas 200ms (< yawnMinMs=400ms)', 'NORMAL', engine);
    });
});

describe('Bateria de cenários — queda de cabeça', () => {
    it('queda de cabeça confirmada (~2500ms)', () => {
        const clock = makeClock(4_000_000);
        const engine = new DetectionEngine();
        // baseline nose-drop calibrado = 0.30; margem padrão = 0.07 → dispara acima de 0.37.
        clock.advance(1); engine.processFrame(makeFrame(0.35, 0.2, 0.45));
        clock.advance(2499); engine.processFrame(makeFrame(0.35, 0.2, 0.45)); // ~2500ms > headDropMinMs=2000ms
        record('queda_cabeca_confirmada_2500ms', 'Nariz abaixo do baseline+margem sustentado por 2500ms', 'WARNING', engine);
    });

    it('queda de cabeça curta (~1000ms, não confirmada)', () => {
        const clock = makeClock(4_100_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processFrame(makeFrame(0.35, 0.2, 0.45));
        clock.advance(999); engine.processFrame(makeFrame(0.35, 0.2, 0.45)); // ~1000ms < headDropMinMs=2000ms
        record('queda_cabeca_curta_1000ms', 'Queda de cabeça por apenas 1000ms (< headDropMinMs=2000ms)', 'NORMAL', engine);
    });
});

describe('Bateria de cenários — rosto ausente', () => {
    it('rosto ausente confirmado (~6000ms)', () => {
        const clock = makeClock(5_000_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processNoFace();
        clock.advance(5999); engine.processNoFace(); // ~6000ms > faceLostWarnMs=5000ms
        record('rosto_ausente_confirmado_6000ms', 'Rosto ausente por 6000ms', 'WARNING', engine);
    });

    it('rosto ausente curto (~2000ms, não confirmado)', () => {
        const clock = makeClock(5_100_000);
        const engine = new DetectionEngine();
        clock.advance(1); engine.processNoFace();
        clock.advance(1999); engine.processNoFace(); // ~2000ms < faceLostWarnMs=5000ms
        record('rosto_ausente_curto_2000ms', 'Rosto ausente por apenas 2000ms (< faceLostWarnMs=5000ms)', 'NORMAL', engine);
    });
});

describe('Bateria de cenários — tendência de sonolência (fase prodrômica)', () => {
    it('declínio gradual do EAR (olhos tecnicamente abertos) dispara EAR_TREND', () => {
        const clock = makeClock(6_000_000);
        const engine = new DetectionEngine();
        // EAR=0.25 > threshold(0.21): olhos ficam "abertos" o tempo todo (sem
        // fechar), mas 0.25 representa um declínio de 28,6% vs baseline 0.35
        // (>= earTrendWarnFraction=0.18) — a "pálpebra pesando" gradual.
        for (let i = 0; i < 25; i++) {
            clock.advance(100);
            engine.processFrame(makeFrame(0.25));
        }
        record('tendencia_declinio_gradual', 'EAR=0.25 sustentado (declínio de 28,6% vs. baseline 0.35), olhos nunca fecham', 'WARNING', engine);
    });
});
