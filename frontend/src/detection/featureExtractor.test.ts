import { describe, it, expect } from 'vitest';
import {
    FeatureExtractor,
    mean,
    stdDev,
    linearTrend,
} from './featureExtractor';
import type { FrameAnalysis } from '../vision/frameAnalyzer';

const BASE_CONTEXT = { perclos: 0, blinkRate: 0, lastBlinkAt: null };

function frame(ear: number, mouth = 0.1, nose = 0.5, yaw = 0): FrameAnalysis {
    return { ear, earL: ear, earR: ear, mouthAspect: mouth, noseDropRatio: nose, yawRatio: yaw };
}

// ── Funções puras ──

describe('mean', () => {
    it('retorna 0 para array vazio', () => expect(mean([])).toBe(0));
    it('calcula média corretamente', () => expect(mean([2, 4, 6])).toBe(4));
    it('único elemento', () => expect(mean([7])).toBe(7));
});

describe('stdDev', () => {
    it('retorna 0 para <2 elementos', () => {
        expect(stdDev([])).toBe(0);
        expect(stdDev([5])).toBe(0);
    });
    it('retorna 0 para valores constantes', () => expect(stdDev([3, 3, 3, 3])).toBe(0));
    it('calcula desvio populacional', () => {
        const result = stdDev([2, 4, 4, 4, 5, 5, 7, 9]);
        expect(result).toBeCloseTo(2.0, 5);
    });
});

describe('linearTrend', () => {
    it('retorna 0 para <2 pontos', () => expect(linearTrend([{ t: 0, v: 1 }])).toBe(0));
    it('trend positivo (EAR subindo)', () => {
        const pts = [
            { t: 0, v: 0.1 },
            { t: 100, v: 0.2 },
            { t: 200, v: 0.3 },
            { t: 300, v: 0.4 },
        ];
        expect(linearTrend(pts)).toBeGreaterThan(0);
    });
    it('trend negativo (EAR descendo)', () => {
        const pts = [
            { t: 0, v: 0.4 },
            { t: 100, v: 0.3 },
            { t: 200, v: 0.2 },
            { t: 300, v: 0.1 },
        ];
        expect(linearTrend(pts)).toBeLessThan(0);
    });
    it('trend constante', () => {
        const pts = [
            { t: 0, v: 0.3 },
            { t: 100, v: 0.3 },
            { t: 200, v: 0.3 },
        ];
        expect(Math.abs(linearTrend(pts))).toBeLessThan(1e-9);
    });
});

// ── FeatureExtractor ──

describe('FeatureExtractor', () => {
    it('warm-up: retorna null com menos de minFrames', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        expect(ext.extract(frame(0.3), 0, BASE_CONTEXT)).toBeNull();
        expect(ext.extract(frame(0.3), 100, BASE_CONTEXT)).toBeNull();
    });

    it('buffer cheio: mantém só bufferSize entries', () => {
        const ext = new FeatureExtractor({ bufferSize: 5, minFramesForFeatures: 3 });
        for (let i = 0; i < 10; i++) {
            ext.extract(frame(0.3), i * 100, BASE_CONTEXT);
        }
        const v = ext.extract(frame(0.3), 1000, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.windowSize).toBe(5);
    });

    it('earTrendPerSec negativo quando EAR cai', () => {
        const ext = new FeatureExtractor({ bufferSize: 10, minFramesForFeatures: 3 });
        const result = ext.extract(frame(0.4), 0, BASE_CONTEXT);
        expect(result).toBeNull();
        ext.extract(frame(0.35), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        const v = ext.extract(frame(0.25), 300, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.earTrendPerSec).toBeLessThan(0);
    });

    it('earTrendPerSec positivo quando EAR sobe', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.1), 0, BASE_CONTEXT);
        ext.extract(frame(0.2), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        const v = ext.extract(frame(0.4), 300, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.earTrendPerSec).toBeGreaterThan(0);
    });

    it('context pass-through: perclos e blinkRate', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 0, BASE_CONTEXT);
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        const ctx = { perclos: 0.25, blinkRate: 12, lastBlinkAt: 50 };
        const v = ext.extract(frame(0.3), 200, ctx);
        expect(v).not.toBeNull();
        expect(v!.perclos).toBe(0.25);
        expect(v!.blinkRate).toBe(12);
    });

    it('msSinceLastBlink calculado corretamente', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 0, BASE_CONTEXT);
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        const ctx = { perclos: 0, blinkRate: 1, lastBlinkAt: 100 };
        const v = ext.extract(frame(0.3), 350, ctx);
        expect(v).not.toBeNull();
        expect(v!.msSinceLastBlink).toBe(250);
    });

    it('msSinceLastBlink é null quando lastBlinkAt é null', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 0, BASE_CONTEXT);
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        const v = ext.extract(frame(0.3), 200, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.msSinceLastBlink).toBeNull();
    });

    it('reset(): limpa buffer, retorna null', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 0, BASE_CONTEXT);
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        expect(ext.extract(frame(0.3), 300, BASE_CONTEXT)).not.toBeNull();
        ext.reset();
        expect(ext.extract(frame(0.3), 400, BASE_CONTEXT)).toBeNull();
    });

    it('gap de frame: buffer limpo', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3, maxFrameGapMs: 1000 });
        ext.extract(frame(0.3), 0, BASE_CONTEXT);
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        expect(ext.extract(frame(0.3), 300, BASE_CONTEXT)).not.toBeNull();
        ext.extract(frame(0.3), 5000, BASE_CONTEXT);
        const v = ext.extract(frame(0.3), 5100, BASE_CONTEXT);
        expect(v).toBeNull();
    });

    it('fora de ordem/duplicado: ignora frame', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        ext.extract(frame(0.3), 150, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        const v = ext.extract(frame(0.3), 300, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.windowSize).toBe(3);
    });

    it('NaN defensivo: frame com ear NaN é ignorado', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 0, BASE_CONTEXT);
        ext.extract(frame(NaN), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 200, BASE_CONTEXT);
        const v = ext.extract(frame(0.3), 300, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.windowSize).toBe(3);
    });

    it('earMin/earMax captura dip e pico', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.1), 0, BASE_CONTEXT);
        ext.extract(frame(0.4), 100, BASE_CONTEXT);
        ext.extract(frame(0.2), 200, BASE_CONTEXT);
        const v = ext.extract(frame(0.3), 300, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.earMin).toBe(0.1);
        expect(v!.earMax).toBe(0.4);
    });

    it('mouthMax e mouthTrendPerSec', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3, 0.1), 0, BASE_CONTEXT);
        ext.extract(frame(0.3, 0.3), 100, BASE_CONTEXT);
        ext.extract(frame(0.3, 0.5), 200, BASE_CONTEXT);
        const v = ext.extract(frame(0.3, 0.7), 300, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.mouthMax).toBe(0.7);
        expect(v!.mouthTrendPerSec).toBeGreaterThan(0);
    });

    it('windowDurationMs reflete span da janela', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3), 100, BASE_CONTEXT);
        ext.extract(frame(0.3), 500, BASE_CONTEXT);
        const v = ext.extract(frame(0.3), 1000, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.windowDurationMs).toBe(900);
    });

    it('noseDropMean calculado corretamente', () => {
        const ext = new FeatureExtractor({ minFramesForFeatures: 3 });
        ext.extract(frame(0.3, 0.1, 0.2), 0, BASE_CONTEXT);
        ext.extract(frame(0.3, 0.1, 0.4), 100, BASE_CONTEXT);
        const v = ext.extract(frame(0.3, 0.1, 0.6), 200, BASE_CONTEXT);
        expect(v).not.toBeNull();
        expect(v!.noseDropMean).toBeCloseTo(0.4, 5);
    });
});
