import type { Clock } from '../temporal/clock';

/**
 * Micro-sono: fechamento AGUDO e SUSTENTADO (EAR bem abaixo do threshold,
 * mais baixo que um fechamento normal), independente do PERCLOS acumulado
 * de 60s — que dilui eventos agudos isolados. Detector dedicado porque um
 * único episódio agudo pode ser clinicamente mais significativo que um
 * PERCLOS elevado por várias piscadas.
 *
 * O cooldown é deliberadamente carregado ATRAVÉS de um `ackAlarm()`: se a
 * pessoa reconhece o alarme mas os olhos continuam fechados, o sistema NÃO
 * deve reclassificar isso como um "novo" micro-sono instantaneamente (ver
 * teste de caracterização em `detectionEngine.ml.test.ts` — comportamento
 * falha-segura existente, preservado aqui, não uma decisão nova).
 */
export interface MicrosleepConfig {
    /** Fração do threshold de olho aberto — abaixo disso é "bem fechado". */
    thresholdFactor: number;
    alarmMs: number;
    cooldownMs: number;
    /** Quadros consecutivos mínimos antes de considerar o streak confirmado. */
    confirmFrames: number;
}

export interface MicrosleepResult {
    candidateMs: number;
    /** Duração e streak batem o limiar, E não está em cooldown — pronto pra alarmar. */
    meetsThreshold: boolean;
}

export class MicrosleepDetector {
    private readonly clock: Clock;
    private config: MicrosleepConfig;

    private candidateSince: number | null = null;
    private streak = 0;
    private lastTriggeredAt = -Infinity;

    constructor(clock: Clock, config: MicrosleepConfig) {
        this.clock = clock;
        this.config = config;
    }

    public updateConfig(config: MicrosleepConfig): void {
        this.config = config;
    }

    public update(ear: number, threshold: number): MicrosleepResult {
        const now = this.clock.now();
        if (ear < threshold * this.config.thresholdFactor) {
            if (this.candidateSince === null) this.candidateSince = now;
            this.streak++;
        } else {
            this.candidateSince = null;
            this.streak = 0;
        }

        const candidateMs = this.candidateSince !== null ? now - this.candidateSince : 0;
        const inCooldown = now - this.lastTriggeredAt < this.config.cooldownMs;
        const meetsThreshold =
            candidateMs >= this.config.alarmMs &&
            this.streak >= this.config.confirmFrames &&
            !inCooldown;

        return { candidateMs, meetsThreshold };
    }

    /** Chamado pelo orquestrador no frame em que MICROSLEEP de fato vira a razão de alarme. */
    public markTriggered(): void {
        this.lastTriggeredAt = this.clock.now();
    }

    /**
     * Rosto perdido / EAR não confiável: zera o candidato (mesmo raciocínio
     * do `EyeStateDetector.markUnknown()` — um "since" de antes do gap não
     * pode sobreviver a ele). NÃO zera `lastTriggeredAt`: o cooldown é sobre
     * tempo de relógio, não sobre continuidade de observação.
     */
    public markUnknown(): void {
        this.candidateSince = null;
        this.streak = 0;
    }

    /** Reset completo de sessão (não usado por markUnknown/ackAlarm — ver docstring da classe). */
    public reset(): void {
        this.candidateSince = null;
        this.streak = 0;
        this.lastTriggeredAt = -Infinity;
    }
}
