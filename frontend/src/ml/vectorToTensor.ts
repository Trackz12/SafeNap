import type { FeatureVector } from '../detection/featureExtractor';
import { FEATURE_ORDER, NULL_BLINK_SENTINEL } from './featureOrder';

export function vectorToTensor(fv: FeatureVector): Float32Array | null {
    const tensor = new Float32Array(FEATURE_ORDER.length);
    for (let i = 0; i < FEATURE_ORDER.length; i++) {
        const key = FEATURE_ORDER[i];
        let val: number;
        if (key === 'msSinceLastBlink') {
            val = fv.msSinceLastBlink === null ? NULL_BLINK_SENTINEL : fv.msSinceLastBlink;
        } else {
            val = (fv as unknown as Record<string, number>)[key];
        }
        if (!Number.isFinite(val)) return null;
        tensor[i] = val;
    }
    return tensor;
}
