FEATURE_ORDER = [
    'ear', 'earL', 'earR', 'mouthAspect', 'noseDropRatio', 'yawRatio',
    'earMean', 'earStdDev', 'earMin', 'earMax', 'earTrendPerSec',
    'blinkRate', 'msSinceLastBlink', 'perclos',
    'mouthMean', 'mouthMax', 'mouthTrendPerSec', 'noseDropMean',
]

NULL_BLINK_SENTINEL = -1

NUM_FEATURES = len(FEATURE_ORDER)
