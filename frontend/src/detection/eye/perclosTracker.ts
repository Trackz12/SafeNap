/**
 * PERCLOS (PERcentage of eyelid CLOSure) — fração de tempo com os olhos
 * fechados dentro de uma janela deslizante.
 *
 * MUDANÇA DE COMPORTAMENTO (auditoria de arquitetura, 2026-09-23 — aprovada
 * explicitamente pelo usuário antes de implementar):
 *
 *   ANTES: perclos = closedMs / perclosWindowMs, onde perclosWindowMs era
 *          SEMPRE 60000ms de relógio, mesmo que boa parte da janela não
 *          tivesse rosto observável (oclusão, GPU engasgando, olhar pro
 *          retrovisor). Esse tempo sem rosto não entrava como "closed" nem
 *          era excluído do denominador — silenciosamente contava como se
 *          fossem olhos abertos, diluindo o PERCLOS bem no momento em que a
 *          confiança no dado deveria cair, não a métrica.
 *
 *   DEPOIS: perclos = closedMs / validObservedMs, onde validObservedMs =
 *           windowMs - tempoSemRostoNaJanela. Períodos sem rosto reduzem o
 *           denominador em vez de silenciosamente contar como "aberto".
 *           Exposto também `confidence = validObservedMs / windowMs`, para
 *           quem consome saber o quão preenchida a janela estava.
 *
 *   MOTIVO: consistência com o resto da auditoria — perda de rosto deve
 *           virar UNKNOWN, nunca "eyes open" nem "eyes closed" implícito.
 *
 *   RISCO: em sessões com MUITA perda de rosto intermitente, o PERCLOS
 *          numérico reportado pode ser mais alto do que era antes (porque o
 *          denominador agora é menor) — isso é a correção pretendida, não
 *          um efeito colateral, mas é uma mudança de valor observável, por
 *          isso está documentada aqui e não só no changelog do commit.
 *
 *   NEEDS VALIDATION: o piso de `validObservedMs` abaixo do qual o PERCLOS é
 *          tratado como não-confiável (hoje simplesmente retorna 0 quando
 *          validObservedMs<=0) não foi validado com dados reais de uso —
 *          é um valor de sanidade, não um número derivado de experimento.
 */

export interface Interval {
    start: number;
    end: number;
}

export interface PerclosConfig {
    /** Duração da janela deslizante (ms). Preset padrão: 60000. */
    windowMs: number;
    /** Segmentos de fechamento mais curtos que isto não contam (filtra piscada normal). */
    ignoreMs: number;
}

export interface PerclosResult {
    /** 0-1. */
    perclos: number;
    /** ms de tempo com rosto observável dentro da janela (denominador real). */
    validObservedMs: number;
    /** ms de fechamento contabilizado dentro da janela. */
    closedMs: number;
    /** validObservedMs / windowMs — 1.0 = janela inteira observada, sem lacunas. */
    confidence: number;
}

export class PerclosTracker {
    private config: PerclosConfig;
    private closedSegments: Interval[] = [];
    private lostIntervals: Interval[] = [];

    constructor(config: PerclosConfig) {
        this.config = config;
    }

    public updateConfig(config: PerclosConfig): void {
        this.config = config;
    }

    public recordClosedSegment(segment: Interval): void {
        this.closedSegments.push(segment);
    }

    public recordLostInterval(interval: Interval): void {
        this.lostIntervals.push(interval);
    }

    private sumOverlap(intervals: Interval[], windowStart: number, minDurationMs = 0): number {
        let sum = 0;
        for (const iv of intervals) {
            if (iv.end <= windowStart) continue;
            if (iv.end - iv.start < minDurationMs) continue;
            sum += iv.end - Math.max(iv.start, windowStart);
        }
        return sum;
    }

    /**
     * `liveClosedSince`/`liveLostSince`: início do segmento/intervalo AINDA
     * em andamento neste instante (olhos fechados agora, ou rosto ausente
     * agora), não fechado ainda em `closedSegments`/`lostIntervals` — mesmo
     * papel que `this.eyesClosed && this.closedSince` tinha no código
     * original.
     */
    public compute(now: number, liveClosedSince: number | null, liveLostSince: number | null): PerclosResult {
        const windowStart = now - this.config.windowMs;
        this.closedSegments = this.closedSegments.filter((s) => s.end > windowStart);
        this.lostIntervals = this.lostIntervals.filter((s) => s.end > windowStart);

        let closedMs = this.sumOverlap(this.closedSegments, windowStart, this.config.ignoreMs);
        if (liveClosedSince !== null) {
            closedMs += now - Math.max(liveClosedSince, windowStart);
        }

        let lostMs = this.sumOverlap(this.lostIntervals, windowStart);
        if (liveLostSince !== null) {
            lostMs += now - Math.max(liveLostSince, windowStart);
        }

        const validObservedMs = Math.max(0, this.config.windowMs - lostMs);
        const perclos = validObservedMs > 0 ? Math.min(1, closedMs / validObservedMs) : 0;
        const confidence = this.config.windowMs > 0 ? validObservedMs / this.config.windowMs : 0;

        return { perclos, validObservedMs, closedMs, confidence };
    }

    public reset(): void {
        this.closedSegments = [];
        this.lostIntervals = [];
    }
}
