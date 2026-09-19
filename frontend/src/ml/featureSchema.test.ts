import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURE_ORDER, NUM_FEATURES, NULL_BLINK_SENTINEL } from './featureOrder';
import { featureVectorToArray, vectorToTensor } from './vectorToTensor';
import type { FeatureVector } from '../detection/featureExtractor';

// Fonte única de verdade: shared/feature_schema.json (lida também pelo Python).
const schema = JSON.parse(
    readFileSync(resolve(__dirname, '../../../shared/feature_schema.json'), 'utf-8'),
) as { features: string[]; nullBlinkSentinel: number };

/** Ordem congelada: qualquer mudança aqui invalida todo ONNX já treinado. */
const FROZEN_ORDER = [
    'ear', 'earL', 'earR', 'mouthAspect', 'noseDropRatio', 'yawRatio',
    'earMean', 'earStdDev', 'earMin', 'earMax', 'earTrendPerSec',
    'blinkRate', 'msSinceLastBlink', 'perclos',
    'mouthMean', 'mouthMax', 'mouthTrendPerSec', 'noseDropMean',
];

/** FeatureVector cujo valor de cada feature é o seu índice+1 (detecta troca de ordem). */
function indexedVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
    const base: Record<string, number> = {};
    FEATURE_ORDER.forEach((k, i) => { base[k] = i + 1; });
    return {
        ...(base as unknown as FeatureVector),
        windowSize: 10, windowDurationMs: 900, extractedAt: 0,
        ...overrides,
    };
}

describe('feature schema (paridade com shared/feature_schema.json)', () => {
    it('FEATURE_ORDER é idêntico ao schema compartilhado, posição a posição', () => {
        expect([...FEATURE_ORDER]).toEqual(schema.features);
    });

    it('a ordem está congelada e tem 18 features únicas', () => {
        expect([...FEATURE_ORDER]).toEqual(FROZEN_ORDER);
        expect(NUM_FEATURES).toBe(18);
        expect(new Set(FEATURE_ORDER).size).toBe(18);
    });

    it('sentinela de piscada coincide com o schema', () => {
        expect(NULL_BLINK_SENTINEL).toBe(schema.nullBlinkSentinel);
    });
});

describe('vectorToTensor / featureVectorToArray', () => {
    it('coloca cada feature na posição de FEATURE_ORDER (não só por nome)', () => {
        const t = vectorToTensor(indexedVector());
        expect(t).not.toBeNull();
        expect(Array.from(t!)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    });

    it('produz Float32Array de 18 posições', () => {
        const t = vectorToTensor(indexedVector());
        expect(t).toBeInstanceOf(Float32Array);
        expect(t!.length).toBe(18);
    });

    it('msSinceLastBlink null vira a sentinela -1', () => {
        const arr = featureVectorToArray(indexedVector({ msSinceLastBlink: null }));
        expect(arr![FEATURE_ORDER.indexOf('msSinceLastBlink')]).toBe(-1);
    });

    it.each([NaN, Infinity, -Infinity])('rejeita o vetor inteiro se uma feature for %s', (bad) => {
        expect(vectorToTensor(indexedVector({ perclos: bad }))).toBeNull();
        expect(featureVectorToArray(indexedVector({ earStdDev: bad }))).toBeNull();
    });

    it('rejeita feature ausente (undefined)', () => {
        const fv = indexedVector() as unknown as Record<string, unknown>;
        delete fv.mouthMax;
        expect(featureVectorToArray(fv as unknown as FeatureVector)).toBeNull();
    });

    it('msSinceLastBlink NaN também é rejeitado', () => {
        expect(featureVectorToArray(indexedVector({ msSinceLastBlink: NaN }))).toBeNull();
    });
});
