import type { Clock } from '../temporal/clock';
import type { ClosedSegment } from './eyeStateDetector';

/**
 * Classifica a duração de um segmento de fechamento (produzido pelo
 * `EyeStateDetector`) em piscada normal, piscada lenta, ou nenhum dos dois
 * (zona-morta). Extraído de `DetectionEngine.processFrame()`, onde essa
 * classificação e o rastreio de taxa viviam misturados com o resto da
 * lógica de decisão.
 *
 * A zona-morta entre `maxBlinkMs` e `slowBlinkMinMs` existe de propósito —
 * ver o comentário original em `detectionEngine.ts` sobre o falso-positivo
 * de SLOW_BLINKS (2026-09-23): sem essa margem, a inflação de medição da
 * histerese de reabertura + filtro de mediana do EAR fazia piscadas
 * fisiologicamente normais serem contadas como lentas.
 */
export type BlinkKind = 'normal' | 'slow';

export interface BlinkConfig {
    minBlinkMs: number;
    maxBlinkMs: number;
    slowBlinkMinMs: number;
    /** Teto superior da faixa de "piscada lenta" — tipicamente microsleepAlarmMs. */
    slowBlinkMaxMs: number;
    slowBlinkRateThreshold: number;
    slowBlinkMinObservationMs: number;
}

export interface BlinkEvent {
    kind: BlinkKind | null;
    durationMs: number;
    at: number;
}

const RATE_WINDOW_MS = 60000;

export class BlinkDetector {
    private readonly clock: Clock;
    private config: BlinkConfig;

    private blinkTimestamps: number[] = [];
    private slowBlinkTimestamps: number[] = [];
    private startedAt: number | null = null;

    constructor(clock: Clock, config: BlinkConfig) {
        this.clock = clock;
        this.config = config;
    }

    public updateConfig(config: BlinkConfig): void {
        this.config = config;
    }

    /** Início da sessão de observação — necessário pra `slowBlinkMinObservationMs`. */
    public markStarted(): void {
        if (this.startedAt === null) this.startedAt = this.clock.now();
    }

    public onClosedSegment(segment: ClosedSegment): BlinkEvent {
        const { durationMs, end: at } = segment;
        let kind: BlinkKind | null = null;

        if (durationMs >= this.config.minBlinkMs && durationMs <= this.config.maxBlinkMs) {
            kind = 'normal';
            this.blinkTimestamps.push(at);
        } else if (durationMs >= this.config.slowBlinkMinMs && durationMs < this.config.slowBlinkMaxMs) {
            kind = 'slow';
            this.slowBlinkTimestamps.push(at);
        }

        return { kind, durationMs, at };
    }

    private observedMs(now: number): number {
        if (this.startedAt === null) return 0;
        return Math.min(RATE_WINDOW_MS, Math.max(1, now - this.startedAt));
    }

    public getBlinkRate(now: number): number {
        const windowStart = now - RATE_WINDOW_MS;
        this.blinkTimestamps = this.blinkTimestamps.filter((t) => t > windowStart);
        if (this.startedAt === null) return 0;
        return Math.round(this.blinkTimestamps.length / (this.observedMs(now) / RATE_WINDOW_MS));
    }

    public getSlowBlinkRate(now: number): number {
        const windowStart = now - RATE_WINDOW_MS;
        this.slowBlinkTimestamps = this.slowBlinkTimestamps.filter((t) => t > windowStart);
        if (this.startedAt === null) return 0;
        // Sem tempo mínimo de observação a taxa é inflada no início da sessão
        // (1 piscada lenta em 5s = "12/min" = falso SLOW_BLINKS).
        if (this.observedMs(now) < this.config.slowBlinkMinObservationMs) return 0;
        return this.slowBlinkTimestamps.length / (this.observedMs(now) / RATE_WINDOW_MS);
    }

    public isSlowBlinksActive(now: number): boolean {
        return this.getSlowBlinkRate(now) >= this.config.slowBlinkRateThreshold;
    }

    public getLastBlinkAt(): number | null {
        return this.blinkTimestamps.length > 0 ? this.blinkTimestamps[this.blinkTimestamps.length - 1] : null;
    }

    public reset(): void {
        this.blinkTimestamps = [];
        this.slowBlinkTimestamps = [];
        this.startedAt = null;
    }
}
