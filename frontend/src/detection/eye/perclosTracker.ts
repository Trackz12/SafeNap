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
 * SEGUNDA MUDANÇA DE COMPORTAMENTO (auditoria de qualidade de detecção,
 * 2026-09-23, achado nº 3):
 *
 *   ANTES: `validObservedMs = windowMs - lostMs` — o denominador assumia a
 *          janela INTEIRA como observada desde o primeiro frame da sessão.
 *          Aos 5 s de sessão, com 4 s de olhos fechados, o resultado era
 *          `4000 / 60000 = 6,7%` em vez dos 80% reais. Efeito prático: o
 *          PERCLOS ficava numericamente INERTE no primeiro minuto de uso
 *          (para bater `perclosWarningLevel`=0,25 eram necessários 15 s
 *          acumulados de fechamento) e, pior, reportava um número baixo com
 *          aparência de medida válida. Falso negativo silencioso.
 *
 *   DEPOIS: `validObservedMs = min(windowMs, now - observationStartedAt) -
 *           lostMs`. O denominador cresce junto com a sessão até encher a
 *           janela. Junto com isso, `sufficient` informa se houve observação
 *           suficiente para a razão significar algo — quem consome (a fusão)
 *           ignora o PERCLOS enquanto `sufficient === false`, em vez de
 *           tratar um número calculado sobre 2 s de dados como PERCLOS.
 *
 *   MOTIVO: um percentual só é um percentual sobre o que foi de fato
 *           observado. Inflar o denominador com tempo que nunca existiu é
 *           matematicamente errado e enviesa para falso negativo exatamente
 *           no início da sessão, quando ninguém ainda calibrou o hábito de
 *           uso do sistema.
 *
 *   RISCO: entre `minObservationMs` e a janela cheia, o PERCLOS agora é mais
 *          sensível do que era antes (denominador menor). Isso é a correção
 *          pretendida, mas é uma mudança de valor observável — episódios que
 *          antes passavam batidos no primeiro minuto agora podem gerar
 *          WARNING. Mitigado por `minObservationMs` e pelo fato de que um
 *          fechamento longo o suficiente para dominar uma janela curta já
 *          dispara `EYES_CLOSED_DURATION`/`MICROSLEEP` antes, por regra forte.
 *
 * ENGINEERING PARAMETER / NEEDS VALIDATION: `minObservationMs` (padrão
 * 20000 ms = 1/3 da janela de 60 s) é uma escolha de engenharia para que a
 * razão não seja calculada sobre pouquíssimos dados. NÃO é um valor derivado
 * de experimento. Validação necessária: rodar sessões rotuladas variando
 * `minObservationMs` em {10s, 20s, 30s} e medir taxa de falso positivo de
 * PERCLOS no primeiro minuto contra rótulo humano de sonolência.
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
    /** Observação válida mínima para a razão ser reportada como significativa. */
    minObservationMs: number;
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
    /**
     * `validObservedMs >= minObservationMs`. Quando falso, `perclos` ainda é
     * calculado (útil para depuração/gráfico) mas NÃO deve alimentar decisão —
     * ver `FusionInputs.perclosValid`.
     */
    sufficient: boolean;
}

export class PerclosTracker {
    private config: PerclosConfig;
    private closedSegments: Interval[] = [];
    private lostIntervals: Interval[] = [];
    /** Primeiro instante em que este tracker observou qualquer coisa. */
    private observationStartedAt: number | null = null;

    constructor(config: PerclosConfig) {
        this.config = config;
    }

    /**
     * Marca o início da observação. Idempotente — só o primeiro valor conta.
     * Chamado pelo orquestrador no primeiro frame (com ou sem rosto), porque
     * "quanto tempo faz que estamos olhando" é propriedade da sessão, não do
     * tracker.
     */
    public markObservationStart(now: number): void {
        if (this.observationStartedAt === null) this.observationStartedAt = now;
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
        this.markObservationStart(now);
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

        // A janela só vale até onde a observação de fato começou: antes disso
        // não havia "tempo de olhos abertos", havia ausência de sistema.
        const elapsedObservable = this.observationStartedAt !== null
            ? Math.min(this.config.windowMs, now - this.observationStartedAt)
            : 0;
        const validObservedMs = Math.max(0, elapsedObservable - lostMs);
        const perclos = validObservedMs > 0 ? Math.min(1, closedMs / validObservedMs) : 0;
        const confidence = this.config.windowMs > 0 ? validObservedMs / this.config.windowMs : 0;
        const sufficient = validObservedMs >= this.config.minObservationMs;

        return { perclos, validObservedMs, closedMs, confidence, sufficient };
    }

    public reset(): void {
        this.closedSegments = [];
        this.lostIntervals = [];
        this.observationStartedAt = null;
    }
}
