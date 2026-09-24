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
/**
 * Classificação temporal EXPLÍCITA de um segmento de fechamento (auditoria de
 * qualidade, 2026-09-23, achado nº 6). Antes, qualquer duração fora das faixas
 * `normal` e `slow` devolvia `null` — a lacuna entre `maxBlinkMs` (400 ms) e
 * `slowBlinkMinMs` (550 ms) era silenciosa: um fechamento de 450 ms não era
 * nada, apesar de entrar no PERCLOS. Agora toda duração tem nome.
 *
 * NENHUMA decisão mudou: só `normal` e `slow` alimentam as taxas, exatamente
 * como antes. `artifact`/`indeterminate`/`prolonged` existem para a lacuna
 * deixar de ser invisível em log e teste.
 *
 *   artifact      < minBlinkMs                       — curto demais pra ser piscada (ruído de tracking)
 *   normal        [minBlinkMs, maxBlinkMs]           — piscada fisiológica
 *   indeterminate (maxBlinkMs, slowBlinkMinMs)       — ZONA-MORTA deliberada (ver abaixo)
 *   slow          [slowBlinkMinMs, slowBlinkMaxMs)   — piscada lenta (sinal de fadiga)
 *   prolonged     >= slowBlinkMaxMs                  — não é piscada; território de micro-sono
 */
export type BlinkKind = 'artifact' | 'normal' | 'indeterminate' | 'slow' | 'prolonged';

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
    kind: BlinkKind;
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
        const kind = this.classify(durationMs);

        // Só piscada normal e piscada lenta alimentam taxa — preservado.
        if (kind === 'normal') this.blinkTimestamps.push(at);
        else if (kind === 'slow') this.slowBlinkTimestamps.push(at);

        return { kind, durationMs, at };
    }

    private classify(durationMs: number): BlinkKind {
        if (durationMs < this.config.minBlinkMs) return 'artifact';
        if (durationMs <= this.config.maxBlinkMs) return 'normal';
        if (durationMs < this.config.slowBlinkMinMs) return 'indeterminate';
        if (durationMs < this.config.slowBlinkMaxMs) return 'slow';
        return 'prolonged';
    }

    /**
     * Tempo de observação que serve de denominador das taxas.
     *
     * MUDANÇA (auditoria de qualidade, 2026-09-23, achado nº 6): agora aceita
     * `validObservedMs` do `PerclosTracker` — que já desconta os intervalos
     * sem rosto e o tempo antes do início da sessão. ANTES era só
     * `now - startedAt`, o que contava trecho sem rosto como observação: com o
     * rosto ausente não há piscada detectável, então o denominador inflava e a
     * taxa de piscadas era subestimada (viés de falso negativo). Reusa a
     * contabilidade já testada do PERCLOS em vez de duplicá-la aqui.
     */
    private observedMs(now: number, validObservedMs?: number): number {
        if (this.startedAt === null) return 0;
        const elapsed = Math.min(RATE_WINDOW_MS, Math.max(1, now - this.startedAt));
        if (validObservedMs === undefined) return elapsed;
        return Math.max(1, Math.min(elapsed, validObservedMs));
    }

    public getBlinkRate(now: number, validObservedMs?: number): number {
        const windowStart = now - RATE_WINDOW_MS;
        this.blinkTimestamps = this.blinkTimestamps.filter((t) => t > windowStart);
        if (this.startedAt === null) return 0;
        return Math.round(this.blinkTimestamps.length / (this.observedMs(now, validObservedMs) / RATE_WINDOW_MS));
    }

    public getSlowBlinkRate(now: number, validObservedMs?: number): number {
        const windowStart = now - RATE_WINDOW_MS;
        this.slowBlinkTimestamps = this.slowBlinkTimestamps.filter((t) => t > windowStart);
        if (this.startedAt === null) return 0;
        const observed = this.observedMs(now, validObservedMs);
        // Sem tempo mínimo de observação a taxa é inflada no início da sessão
        // (1 piscada lenta em 5s = "12/min" = falso SLOW_BLINKS).
        if (observed < this.config.slowBlinkMinObservationMs) return 0;
        return this.slowBlinkTimestamps.length / (observed / RATE_WINDOW_MS);
    }

    public isSlowBlinksActive(now: number, validObservedMs?: number): boolean {
        return this.getSlowBlinkRate(now, validObservedMs) >= this.config.slowBlinkRateThreshold;
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
