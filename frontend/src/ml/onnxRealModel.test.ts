import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web';
import { FEATURE_ORDER, NUM_FEATURES } from './featureOrder';
import { featureVectorToArray, vectorToTensor } from './vectorToTensor';
import { ML_WARNING_THRESHOLD } from './thresholds';
import type { FeatureVector } from '../detection/featureExtractor';

/**
 * Inferência com o runtime REAL (onnxruntime-web/WASM em Node) e o ARQUIVO REAL
 * embarcado (public/models/drowsiness.onnx). Sem mocks. Verifica o contrato que
 * drowsinessModel.ts assume: nomes de I/O, shape [1,18], saída [1,2] com a
 * classe DROWSY no índice 1. NÃO mede acurácia (o modelo é sintético/experimental).
 */
const MODEL = resolve(__dirname, '../../public/models/drowsiness.onnx');

function vec(overrides: Partial<FeatureVector> = {}): FeatureVector {
    const awake: Record<string, number> = {
        ear: .30, earL: .30, earR: .30, mouthAspect: .08, noseDropRatio: .45, yawRatio: .02,
        earMean: .30, earStdDev: .01, earMin: .28, earMax: .32, earTrendPerSec: 0,
        blinkRate: 15, perclos: .02, mouthMean: .08, mouthMax: .10, mouthTrendPerSec: 0, noseDropMean: .45,
    };
    return {
        ...(awake as unknown as FeatureVector),
        msSinceLastBlink: 2000, windowSize: 10, windowDurationMs: 900, extractedAt: 0, ...overrides,
    };
}

interface OnnxGolden { tolerance: number; vectors: number[][]; expected_p_drowsy: number[] }
const golden = JSON.parse(
    readFileSync(resolve(__dirname, '../../../shared/onnx_golden.json'), 'utf-8'),
) as OnnxGolden;

let session: ort.InferenceSession;

async function drowsyProbability(fv: FeatureVector): Promise<number> {
    const tensor = vectorToTensor(fv);
    expect(tensor).not.toBeNull();
    const out = await session.run({ features: new ort.Tensor('float32', tensor!, [1, NUM_FEATURES]) });
    const p = out['probabilities'].data as Float32Array;
    expect(p.length).toBe(2);
    return p[1]; // só o índice 1 é confiável entre runtimes (ver o teste de paridade abaixo)
}

describe('ONNX embarcado com onnxruntime-web real', () => {
    beforeAll(async () => {
        session = await ort.InferenceSession.create(readFileSync(MODEL), { executionProviders: ['wasm'] });
    });

    it('nomes de entrada/saída são os que drowsinessModel.ts assume', () => {
        expect(session.inputNames).toEqual(['features']);
        expect(session.outputNames).toContain('probabilities');
    });

    it('vetor válido → probabilidade finita em [0,1]', async () => {
        const p = await drowsyProbability(vec());
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
    });

    it('fumaça (não é acurácia): alerta claro < ML_WARNING ≤ olhos quase fechados + PERCLOS alto', async () => {
        const awake = await drowsyProbability(vec());
        const drowsy = await drowsyProbability(vec({
            ear: .12, earL: .12, earR: .12, earMean: .13, earMin: .10, earMax: .16,
            perclos: .5, blinkRate: 5, msSinceLastBlink: 6000,
        }));
        expect(awake).toBeLessThan(ML_WARNING_THRESHOLD);
        expect(drowsy).toBeGreaterThanOrEqual(ML_WARNING_THRESHOLD);
    });

    // Achado da auditoria: para este TreeEnsembleClassifier binário o ORT-web 1.27 devolve
    // probabilities = [-p, p] e label = 1, enquanto o ORT Python devolve [1-p, p]. Só p[1]
    // (o que o frontend lê) coincide — por isso o código NUNCA usa `label` nem p[0].
    it('P(DROWSY) (índice 1) do ORT-web coincide com o ORT Python em 43 vetores fixos', async () => {
        for (let i = 0; i < golden.vectors.length; i++) {
            const out = await session.run({
                features: new ort.Tensor('float32', Float32Array.from(golden.vectors[i]), [1, NUM_FEATURES]),
            });
            const p1 = (out['probabilities'].data as Float32Array)[1];
            expect(Math.abs(p1 - golden.expected_p_drowsy[i]), `vetor ${i}`).toBeLessThan(golden.tolerance);
        }
    });

    it('a sentinela -1 (sem piscada) produz o mesmo tensor que o caminho de treino/coleta', async () => {
        const fv = vec({ msSinceLastBlink: null });
        const arr = featureVectorToArray(fv)!;
        expect(arr[FEATURE_ORDER.indexOf('msSinceLastBlink')]).toBe(-1);
        expect(await drowsyProbability(fv)).toBeGreaterThanOrEqual(0);
    });

    it('vetor com NaN nunca chega ao modelo', () => {
        expect(vectorToTensor(vec({ ear: NaN }))).toBeNull();
    });
});
