import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeFrame, type FrameAnalysis } from '../vision/frameAnalyzer';
import { FeatureExtractor } from '../detection/featureExtractor';
import { DetectionEngine } from '../detection/detectionEngine';
import { metricsStore } from '../detection/metricsStore';
import { calibrationManager } from '../safety/calibrationManager';
import { FEATURE_ORDER } from './featureOrder';
import { featureVectorToArray } from './vectorToTensor';

/**
 * Paridade treino↔inferência: o fixture shared/feature_golden.json é gerado pelo
 * pipeline Python (ml/scripts/make_golden_fixture.py). Aqui o código TypeScript
 * REAL (não uma reimplementação) precisa reproduzir os mesmos números.
 */
interface Golden {
    tolerance: number;
    frames: Array<{
        t: number;
        points: Record<string, [number, number, number]>;
        context: { perclos: number; blinkRate: number; lastBlinkAt: number | null };
        expectedAnalysis: Record<string, number>;
        expectedFeatures: Record<string, number> | null;
    }>;
    blinkSequence: {
        start: number; dtMs: number; ears: number[];
        expected: Array<{ perclos: number; blinkRate: number }>;
    };
}

const golden = JSON.parse(
    readFileSync(resolve(__dirname, '../../../shared/feature_golden.json'), 'utf-8'),
) as Golden;

const close = (a: number, b: number): boolean =>
    Math.abs(a - b) <= golden.tolerance * Math.max(1, Math.abs(b));

function landmarksOf(points: Record<string, [number, number, number]>) {
    const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    for (const [idx, [x, y, z]] of Object.entries(points)) lm[Number(idx)] = { x, y, z };
    return lm;
}

describe('paridade Python ↔ TypeScript (fixture dourado)', () => {
    it('analyzeFrame reproduz os 6 valores brutos do Python em todos os frames', () => {
        for (const f of golden.frames) {
            const got = analyzeFrame(landmarksOf(f.points));
            expect(got, `frame t=${f.t}`).not.toBeNull();
            for (const [k, want] of Object.entries(f.expectedAnalysis)) {
                const val = (got as unknown as Record<string, number>)[k];
                expect(close(val, want), `${k} frame ${f.t}: TS=${val} Python=${want}`).toBe(true);
            }
        }
    });

    it('FeatureExtractor reproduz o vetor de 18 features do Python (na ordem do schema)', () => {
        const fe = new FeatureExtractor();
        let compared = 0;
        for (const f of golden.frames) {
            const analysis = analyzeFrame(landmarksOf(f.points)) as FrameAnalysis;
            const fv = fe.extract(analysis, f.t, f.context);
            if (f.expectedFeatures === null) {
                expect(fv, `warmup t=${f.t}`).toBeNull();
                continue;
            }
            expect(fv).not.toBeNull();
            const got = featureVectorToArray(fv!)!;
            FEATURE_ORDER.forEach((k, i) => {
                const want = f.expectedFeatures![k];
                expect(close(got[i], want), `${k} t=${f.t}: TS=${got[i]} Python=${want}`).toBe(true);
            });
            compared++;
        }
        expect(compared).toBeGreaterThan(5);
    });
});

describe('paridade do estado de piscada/PERCLOS (DetectionEngine real × BlinkTracker Python)', () => {
    let engine: DetectionEngine;

    beforeEach(() => {
        calibrationManager.clearCalibration();
        calibrationManager.skipWithDefault(); // limiar 0,25 = threshold do fixture
        metricsStore.reset();
        engine = new DetectionEngine();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        calibrationManager.clearCalibration();
        metricsStore.reset();
    });

    it('perclos e blinkRate coincidem quadro a quadro em 400 frames', () => {
        const { start, dtMs, ears, expected } = golden.blinkSequence;
        let maxPerclos = 0;
        ears.forEach((ear, i) => {
            vi.setSystemTime(start + i * dtMs);
            engine.processFrame({ ear, earL: ear, earR: ear, mouthAspect: 0.2, noseDropRatio: 0.3, yawRatio: 0, quality: 'GOOD' });
            const m = metricsStore.get()!;
            expect(close(m.perclos, expected[i].perclos), `perclos frame ${i}: TS=${m.perclos} Py=${expected[i].perclos}`).toBe(true);
            expect(m.blinkRate, `blinkRate frame ${i}`).toBe(expected[i].blinkRate);
            maxPerclos = Math.max(maxPerclos, m.perclos);
        });
        expect(maxPerclos).toBeGreaterThan(0); // o cenário realmente exercita o PERCLOS
    });
});
