import type { Clock } from './clock';

/**
 * Tendência de declínio do EAR (fase prodrômica — pálpebra pesando
 * gradualmente), extraído de `DetectionEngine` (`longEarBuffer` +
 * `computeEarTrendFraction`). Só coleta amostras de olhos ABERTOS — picos de
 * piscada/oclusão não podem contaminar o declínio progressivo.
 */
export interface EarTrendConfig {
    windowMs: number;
    /** Amostras mínimas no buffer antes de calcular uma fração (evita ruído no início). */
    minSamples: number;
    /** Quantas amostras recentes formam a média "atual" comparada ao baseline. */
    recentSampleCount: number;
}

export class EarTrendTracker {
    private readonly clock: Clock;
    private config: EarTrendConfig;
    private buffer: Array<{ t: number; e: number }> = [];

    constructor(clock: Clock, config: EarTrendConfig) {
        this.clock = clock;
        this.config = config;
    }

    public updateConfig(config: EarTrendConfig): void {
        this.config = config;
    }

    /** Só chamar com olhos abertos — quem orquestra decide isso. */
    public addOpenEyeSample(ear: number): void {
        const now = this.clock.now();
        this.buffer.push({ t: now, e: ear });
        const cutoff = now - this.config.windowMs;
        while (this.buffer.length > 0 && this.buffer[0].t < cutoff) {
            this.buffer.shift();
        }
    }

    /** Fração de declínio vs. baseline (0-1+); null se dados insuficientes ou sem baseline. */
    public computeFraction(baseline: number | null): number | null {
        if (this.buffer.length < this.config.minSamples) return null;
        if (baseline === null || baseline <= 0) return null;

        const n = Math.min(this.config.recentSampleCount, this.buffer.length);
        let sum = 0;
        for (let i = this.buffer.length - n; i < this.buffer.length; i++) sum += this.buffer[i].e;
        const recent = sum / n;
        if (recent <= 0) return null;

        return (baseline - recent) / baseline;
    }

    public reset(): void {
        this.buffer = [];
    }
}
