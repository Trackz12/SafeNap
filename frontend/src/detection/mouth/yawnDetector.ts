import type { Clock } from '../temporal/clock';

/** Bocejo — extraído de `DetectionEngine.processYawn()`, mesma lógica. */
export interface YawnConfig {
    mouthAspectThreshold: number;
    minMs: number;
    cooldownMs: number;
}

export interface YawnResult {
    active: boolean;
    /** Verdadeiro só no frame em que o bocejo acabou de ser confirmado. */
    justStarted: boolean;
}

export class YawnDetector {
    private readonly clock: Clock;
    private config: YawnConfig;

    private since: number | null = null;
    private active = false;
    private lastEventAt = -Infinity;

    constructor(clock: Clock, config: YawnConfig) {
        this.clock = clock;
        this.config = config;
    }

    public updateConfig(config: YawnConfig): void {
        this.config = config;
    }

    public update(mouthAspect: number): YawnResult {
        const now = this.clock.now();
        let justStarted = false;

        if (mouthAspect > this.config.mouthAspectThreshold) {
            if (this.since === null) this.since = now;
            if (now - this.since >= this.config.minMs && !this.active) {
                this.active = true;
                this.lastEventAt = now;
                justStarted = true;
            }
        } else {
            this.since = null;
            if (this.active && now - this.lastEventAt >= this.config.cooldownMs) {
                this.active = false;
            }
        }

        return { active: this.active, justStarted };
    }

    public reset(): void {
        this.since = null;
        this.active = false;
        this.lastEventAt = -Infinity;
    }
}
