import type { FeatureVector } from '../detection/featureExtractor';
import { FEATURE_ORDER, NULL_BLINK_SENTINEL } from './featureOrder';

/**
 * Único ponto de conversão FeatureVector → array na ordem FEATURE_ORDER.
 * Usado pelo ONNX, pelo modelo do usuário (treino e predição) e pelo coletor,
 * para que a sentinela de "sem piscada" (-1) e a rejeição de NaN/Infinity
 * sejam idênticas em todos os caminhos.
 *
 * Retorna null se qualquer feature não for finita: um vetor inválido nunca
 * deve virar score.
 */
export function featureVectorToArray(fv: FeatureVector): number[] | null {
    const out: number[] = new Array(FEATURE_ORDER.length);
    for (let i = 0; i < FEATURE_ORDER.length; i++) {
        const key = FEATURE_ORDER[i];
        const val = key === 'msSinceLastBlink'
            ? (fv.msSinceLastBlink === null ? NULL_BLINK_SENTINEL : fv.msSinceLastBlink)
            : fv[key];
        if (typeof val !== 'number' || !Number.isFinite(val)) return null;
        out[i] = val;
    }
    return out;
}

export function vectorToTensor(fv: FeatureVector): Float32Array | null {
    const arr = featureVectorToArray(fv);
    return arr ? Float32Array.from(arr) : null;
}
