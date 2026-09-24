import type { Clock } from './clock';

/**
 * Tendência de declínio do EAR (fase prodrômica — pálpebra pesando
 * gradualmente), extraído de `DetectionEngine` (`longEarBuffer` +
 * `computeEarTrendFraction`). Só coleta amostras de olhos ABERTOS — picos de
 * piscada/oclusão não podem contaminar o declínio progressivo.
 *
 * MUDANÇA DE COMPORTAMENTO (2026-09-24, junto com o aumento da cadência do laço):
 *
 *   ANTES: `minSamples` (20) e `recentSampleCount` (10) eram CONTAGENS DE
 *          AMOSTRA. A documentação descrevia os 20 como "~2s de dados", o que só
 *          era verdade na cadência medida de 8 FPS. Ao subir o laço para 30 FPS,
 *          as mesmas 20 amostras passariam a valer 0,67 s: o EAR_TREND — que é
 *          REGRA FORTE de WARNING em `fusion/signalFusion.ts` — dispararia com
 *          um terço da evidência temporal anterior. Seria uma regressão de falso
 *          positivo causada pela mudança de cadência, não por qualquer decisão
 *          sobre fadiga.
 *
 *   DEPOIS: as duas janelas são em MILISSEGUNDOS. `minObservationMs` (2000)
 *           preserva o "~2s de dados" que a documentação sempre prometeu, agora
 *           de fato e em qualquer cadência; `recentWindowMs` (1000) define a
 *           janela da média "atual". `minSamples` sobrevive apenas como piso de
 *           ruído, no papel que o §14 da auditoria reserva para contagem de
 *           quadros.
 *
 *   MOTIVO: tendência é fenômeno temporal. Medir em amostras acopla a
 *           sensibilidade do sinal à velocidade da máquina.
 */
export interface EarTrendConfig {
    windowMs: number;
    /** Tempo mínimo coberto pelas amostras antes de calcular uma fração. */
    minObservationMs: number;
    /** Janela recente que forma a média "atual" comparada ao baseline (ms). */
    recentWindowMs: number;
    /** Piso de amostras válidas — proteção contra ruído, NÃO unidade de tempo. */
    minSamples: number;
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

        // Exige TEMPO de observação, não quantidade de amostras: a 30 FPS,
        // 20 amostras são 0,67 s — evidência fraca de "pálpebra pesando".
        const last = this.buffer[this.buffer.length - 1];
        if (last.t - this.buffer[0].t < this.config.minObservationMs) return null;

        const recentCutoff = last.t - this.config.recentWindowMs;
        let sum = 0;
        let n = 0;
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            if (this.buffer[i].t < recentCutoff) break;
            sum += this.buffer[i].e;
            n++;
        }
        if (n === 0) return null;
        const recent = sum / n;
        if (recent <= 0) return null;

        return (baseline - recent) / baseline;
    }

    public reset(): void {
        this.buffer = [];
    }
}
