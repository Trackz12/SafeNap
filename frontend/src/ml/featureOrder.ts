export const FEATURE_ORDER = [
    'ear', 'earL', 'earR', 'mouthAspect', 'noseDropRatio', 'yawRatio',
    'earMean', 'earStdDev', 'earMin', 'earMax', 'earTrendPerSec',
    'blinkRate', 'msSinceLastBlink', 'perclos',
    'mouthMean', 'mouthMax', 'mouthTrendPerSec', 'noseDropMean',
] as const;

export type FeatureKey = (typeof FEATURE_ORDER)[number];

export const NUM_FEATURES = FEATURE_ORDER.length;

export const NULL_BLINK_SENTINEL = -1;
