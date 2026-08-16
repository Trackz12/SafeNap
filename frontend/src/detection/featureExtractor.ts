import type { FrameAnalysis } from '../vision/frameAnalyzer';

export interface FeatureContext {
    perclos: number;
    blinkRate: number;
    lastBlinkAt: number | null;
}

export interface FeatureExtractorOptions {
    bufferSize?: number;
    minFramesForFeatures?: number;
    maxFrameGapMs?: number;
}

export interface FeatureVector {
    ear: number;
    earL: number;
    earR: number;
    mouthAspect: number;
    noseDropRatio: number;
    yawRatio: number;

    earMean: number;
    earStdDev: number;
    earMin: number;
    earMax: number;
    earTrendPerSec: number;

    blinkRate: number;
    msSinceLastBlink: number | null;
    perclos: number;

    mouthMean: number;
    mouthMax: number;
    mouthTrendPerSec: number;

    noseDropMean: number;

    windowSize: number;
    windowDurationMs: number;
    extractedAt: number;
}

interface BufferEntry {
    t: number;
    frame: FrameAnalysis;
}

// ── Funções puras exportadas para teste isolado ──

export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

export function stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    let sumSq = 0;
    for (const v of values) sumSq += (v - m) ** 2;
    return Math.sqrt(sumSq / values.length);
}

export function linearTrend(points: Array<{ t: number; v: number }>): number {
    const n = points.length;
    if (n < 2) return 0;
    let sT = 0;
    let sV = 0;
    let sTV = 0;
    let sT2 = 0;
    for (const p of points) {
        sT += p.t;
        sV += p.v;
        sTV += p.t * p.v;
        sT2 += p.t * p.t;
    }
    const denom = n * sT2 - sT * sT;
    if (Math.abs(denom) < 1e-10) return 0;
    return ((n * sTV - sT * sV) / denom) * 1000;
}

// ── Classe principal ──

const DEFAULT_BUFFER_SIZE = 10;
const DEFAULT_MIN_FRAMES = 3;
const DEFAULT_MAX_FRAME_GAP_MS = 1000;

export class FeatureExtractor {
    private readonly bufferSize: number;
    private readonly minFramesForFeatures: number;
    private readonly maxFrameGapMs: number;
    private buffer: BufferEntry[] = [];

    constructor(options?: FeatureExtractorOptions) {
        this.bufferSize = options?.bufferSize ?? DEFAULT_BUFFER_SIZE;
        this.minFramesForFeatures = options?.minFramesForFeatures ?? DEFAULT_MIN_FRAMES;
        this.maxFrameGapMs = options?.maxFrameGapMs ?? DEFAULT_MAX_FRAME_GAP_MS;
    }

    private push(frame: FrameAnalysis, now: number): void {
        if (!Number.isFinite(now)) return;
        if (
            !Number.isFinite(frame.ear) ||
            !Number.isFinite(frame.mouthAspect) ||
            !Number.isFinite(frame.noseDropRatio) ||
            !Number.isFinite(frame.yawRatio)
        ) return;

        const last = this.buffer[this.buffer.length - 1];
        if (last && now <= last.t) return;
        if (last && now - last.t > this.maxFrameGapMs) this.buffer = [];

        this.buffer.push({ t: now, frame });
        if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }

    public extract(
        frame: FrameAnalysis,
        now: number,
        context: FeatureContext,
    ): FeatureVector | null {
        this.push(frame, now);
        if (this.buffer.length < this.minFramesForFeatures) return null;

        const ears = this.buffer.map((b) => b.frame.ear);
        const mouths = this.buffer.map((b) => b.frame.mouthAspect);
        const noseDrops = this.buffer.map((b) => b.frame.noseDropRatio);
        const earPts = this.buffer.map((b) => ({ t: b.t, v: b.frame.ear }));
        const mouthPts = this.buffer.map((b) => ({ t: b.t, v: b.frame.mouthAspect }));

        return {
            ear: frame.ear,
            earL: frame.earL,
            earR: frame.earR,
            mouthAspect: frame.mouthAspect,
            noseDropRatio: frame.noseDropRatio,
            yawRatio: frame.yawRatio,

            earMean: mean(ears),
            earStdDev: stdDev(ears),
            earMin: Math.min(...ears),
            earMax: Math.max(...ears),
            earTrendPerSec: linearTrend(earPts),

            blinkRate: context.blinkRate,
            msSinceLastBlink:
                context.lastBlinkAt === null
                    ? null
                    : Math.max(0, now - context.lastBlinkAt),
            perclos: context.perclos,

            mouthMean: mean(mouths),
            mouthMax: Math.max(...mouths),
            mouthTrendPerSec: linearTrend(mouthPts),

            noseDropMean: mean(noseDrops),

            windowSize: this.buffer.length,
            windowDurationMs: now - this.buffer[0].t,
            extractedAt: now,
        };
    }

    public reset(): void {
        this.buffer = [];
    }
}

export const featureExtractor = new FeatureExtractor();
