import type { Clock } from '../temporal/clock';

/**
 * Bocejo.
 *
 * MUDANÇA DE COMPORTAMENTO (auditoria de qualidade de detecção, 2026-09-23,
 * achado nº 5): a semântica de `active` e de `cooldownMs` foi corrigida.
 *
 *   ANTES: `active` só era rebaixado no ramo "boca fechada", e apenas quando
 *          `now - lastEventAt >= cooldownMs`. Dois defeitos concretos:
 *          (a) uma única abertura de 400 ms mantinha `active = true` por
 *              `cooldownMs` INTEIRO (10 s no preset padrão). Como YAWN é regra
 *              forte de WARNING em `fusion/signalFusion.ts`, isso significava
 *              10 s de banner de aviso por um bocejo de meio segundo;
 *          (b) enquanto `mouthAspect` permanecesse acima do limiar, o ramo
 *              `else` nunca executava e `active` NUNCA caía — falar alto, rir
 *              ou cantar com a boca bem aberta sustentava YAWN indefinidamente.
 *          O nome `cooldownMs` prometia "não re-disparar tão cedo" mas
 *          implementava "permanecer ativo por tanto tempo".
 *
 *   DEPOIS: três parâmetros com um papel cada:
 *          - `minMs`       — abertura precisa durar isso pra confirmar bocejo;
 *          - `maxMs`       — abertura que dura MAIS que isso não é bocejo
 *                            (bocejo é transitório: cresce, chega ao máximo e
 *                            fecha). Boca aberta além disso rebaixa `active`,
 *                            resolvendo o caso (b) de fala/riso/canto;
 *          - `activeHoldMs`— quanto `active` persiste após a boca fechar, só
 *                            para o WARNING não piscar entre quadros;
 *          - `cooldownMs`  — agora é de fato um guarda de RE-disparo: um novo
 *                            bocejo só pode ser confirmado depois dele.
 *
 *   MOTIVO: bocejo é evidência de SUPORTE (§10 da auditoria). Um sinal de
 *           suporte que domina a razão de WARNING por 10 s a cada abertura de
 *           boca, e indefinidamente se a boca ficar aberta, é um amplificador
 *           de falso positivo — precisamente o que os testes práticos com
 *           várias pessoas iriam expor.
 *
 *   RISCO: bocejos reais agora produzem WARNING por menos tempo. Isso é a
 *          redução de falso positivo pretendida; YAWN continua somando no
 *          score contínuo de suporte enquanto ativo, e continua incapaz de
 *          gerar ALARM sozinho (inalterado).
 *
 * ENGINEERING PARAMETER / NEEDS VALIDATION: `maxMs` (7000 ms) e
 * `activeHoldMs` (2000 ms). O primeiro vem da faixa usualmente citada para a
 * duração de um bocejo (~4–6 s) com folga; o segundo é anti-flicker. Nenhum
 * dos dois foi medido neste projeto. Validação necessária: gravar sessões com
 * bocejos e com fala/riso rotulados e medir falso positivo de YAWN por valor
 * de `maxMs`.
 */
export interface YawnConfig {
    mouthAspectThreshold: number;
    minMs: number;
    /** Abertura mais longa que isto não é bocejo (fala/riso/canto/boca aberta à toa). */
    maxMs: number;
    /** Persistência de `active` após a boca fechar (anti-flicker do WARNING). */
    activeHoldMs: number;
    /** Intervalo mínimo antes de um NOVO bocejo poder ser confirmado. */
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
            const openMs = now - this.since;

            if (
                !this.active &&
                openMs >= this.config.minMs &&
                openMs < this.config.maxMs &&
                now - this.lastEventAt >= this.config.cooldownMs
            ) {
                this.active = true;
                this.lastEventAt = now;
                justStarted = true;
            }

            // Boca aberta além da duração plausível de um bocejo: fala, riso,
            // canto ou boca simplesmente aberta — não é evidência de fadiga.
            if (this.active && openMs >= this.config.maxMs) {
                this.active = false;
            }
        } else {
            this.since = null;
            if (this.active && now - this.lastEventAt >= this.config.activeHoldMs) {
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
