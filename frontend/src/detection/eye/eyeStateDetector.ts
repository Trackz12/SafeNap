import type { Clock } from '../temporal/clock';

/**
 * Estado do olho — extraído da lógica que antes vivia inline em
 * `DetectionEngine.processFrame()` como 4 campos privados soltos
 * (`eyesClosed`, `closedSince`, `belowThresholdStreak`, `closedCandidateSince`).
 *
 * O mapeamento abaixo é uma RENOMEAÇÃO do comportamento que já existia via
 * histerese (`closeConfirmFrames` + `hysteresisFactor`), não uma mudança de
 * lógica — os mesmos dois limiares (`threshold` e `threshold*hysteresisFactor`)
 * continuam sendo os únicos números que decidem a transição:
 *
 *   OPEN:    ear >= threshold, olho não está fechado
 *   CLOSING: ear <  threshold, mas ainda não confirmou a janela de
 *            confirmação (zona de confirmação, existia como
 *            `belowThresholdStreak` sem nome)
 *   CLOSED:  confirmado fechado, ear ainda <= threshold
 *   OPENING: confirmado fechado, mas ear já subiu acima de threshold e ainda
 *            não passou de threshold*hysteresisFactor (a zona-morta da
 *            histerese de reabertura — existia sem nome; hoje o "estado"
 *            binário `eyesClosed` já ficava true durante essa zona, então
 *            nomear OPENING aqui não muda a decisão de fechado/aberto)
 *   UNKNOWN: sem rosto/EAR confiável — usado enquanto a câmera não
 *            forneceu nenhum frame válido ainda, ou explicitamente via
 *            markUnknown() quando o rosto se perde.
 */
export type EyeState = 'OPEN' | 'CLOSING' | 'CLOSED' | 'OPENING' | 'UNKNOWN';

/**
 * MUDANÇA DE COMPORTAMENTO (auditoria de qualidade de detecção, 2026-09-23,
 * achado nº 2): a confirmação de fechamento passou de CONTAGEM DE QUADROS
 * para DURAÇÃO + piso de quadros.
 *
 *   ANTES: `belowThresholdStreak >= closeConfirmFrames` (4/3/2 quadros nos
 *          presets lenient/standard/strict). O laço de detecção real roda a
 *          ~10 FPS (`vision/mediapipe.ts`: setTimeout de 100 ms), então
 *          "3 quadros" equivalia a ~300 ms no preset padrão. Piscada humana
 *          normal dura 100–400 ms: uma piscada de 200 ms produzia apenas 2
 *          quadros abaixo do limiar e NUNCA era confirmada como fechamento.
 *          Consequência: nenhum `closedSegmentEnded` era emitido, a piscada
 *          não era contada (`blinkRate` ≈ 0), não entrava no PERCLOS e não
 *          alimentava a taxa de piscada lenta. Falso negativo sistemático — e
 *          o comportamento mudava junto com o FPS (o mesmo "3 quadros" vale
 *          300 ms a 10 FPS, 100 ms a 30 FPS e 50 ms a 60 FPS).
 *
 *   DEPOIS: confirma quando `tempoAbaixoDoLimiar >= closeConfirmMs` **E**
 *           `quadrosAbaixoDoLimiar >= closeConfirmMinFrames`. O tempo é a
 *           unidade do fenômeno fisiológico; os quadros ficam no papel que o
 *           §14 da auditoria define para eles — piso de ruído, não relógio.
 *
 *   MOTIVO: fechamento ocular é um fenômeno temporal. Medir em quadros faz o
 *           sistema ser mais sensível em máquinas rápidas e cego em máquinas
 *           lentas, o que é inaceitável num projeto que vai ser testado por
 *           muitas pessoas em hardware diferente no mesmo dia.
 *
 *   RISCO: a ~10 FPS o preset padrão passa a confirmar no 2º quadro (~100 ms)
 *          em vez do 3º (~300 ms), ou seja, confirma MAIS fechamentos. Isso é
 *          o objetivo (piscadas deixam de ser invisíveis), mas aumenta a
 *          exposição a um mergulho transitório de EAR. Mitigado por
 *          `closeConfirmMinFrames = 2` (um quadro isolado nunca confirma) e
 *          pelo filtro de mediana de 3 quadros que já existia.
 *
 * ENGINEERING PARAMETER / NEEDS VALIDATION: `closeConfirmMs` (60/90/150 ms em
 * strict/standard/lenient) foi escolhido para ficar ABAIXO da piscada
 * fisiológica mais curta (~100 ms) e ACIMA de um único quadro de ruído. NÃO é
 * um valor derivado de experimento. Validação necessária: gravar sessões com
 * marcação manual de piscadas e medir recall de piscada por preset a 10, 30 e
 * 60 FPS.
 */
export interface EyeStateConfig {
    /** Tempo contínuo abaixo do threshold antes de confirmar fechado (ms). */
    closeConfirmMs: number;
    /** Piso de quadros consecutivos — proteção contra ruído, NÃO unidade de tempo. */
    closeConfirmMinFrames: number;
    /** Fator sobre o threshold que o EAR precisa superar pra reabrir (evita flicker). */
    hysteresisFactor: number;
    /** Janela do filtro de mediana sobre o EAR cru (frames). */
    smoothingWindow: number;
}

export interface ClosedSegment {
    start: number;
    end: number;
    durationMs: number;
}

export interface EyeStateUpdate {
    /** EAR suavizado (mediana da janela) — o valor que alimenta as decisões. */
    ear: number;
    state: EyeState;
    /** Atalho: state === 'CLOSED' || state === 'OPENING' (fechado por hysteresis). */
    closed: boolean;
    /** ms contínuos no estado fechado (0 se não estiver fechado). */
    closedForMs: number;
    /**
     * Presente só no frame em que os olhos acabaram de reabrir
     * (transição CLOSED/OPENING → OPEN): o segmento de fechamento completo,
     * pronto para o PerclosTracker e o BlinkDetector consumirem.
     */
    closedSegmentEnded: ClosedSegment | null;
}

const DEFAULT_SMOOTHING_WINDOW = 3;

/**
 * Detecta o estado do olho a partir do EAR cru, com suavização por mediana e
 * histerese de confirmação. NÃO dispara efeitos colaterais (sem
 * wsClient/sessionStats) — devolve dados; quem orquestra (DetectionEngine)
 * decide o que fazer com a transição (emitir evento, contar piscada etc.).
 * Isso é deliberado: mantém a classe testável isoladamente, alimentando EAR
 * e lendo o resultado, sem precisar mockar WebSocket/sessão.
 */
export class EyeStateDetector {
    private readonly clock: Clock;
    private config: EyeStateConfig;

    private earBuffer: number[] = [];
    private belowThresholdStreak = 0;
    private closedCandidateSince: number | null = null;
    private state: EyeState = 'UNKNOWN';
    private closedSince: number | null = null;

    constructor(clock: Clock, config: EyeStateConfig) {
        this.clock = clock;
        this.config = config;
    }

    public updateConfig(config: EyeStateConfig): void {
        this.config = config;
    }

    private smooth(rawEar: number): number {
        const window = this.config.smoothingWindow || DEFAULT_SMOOTHING_WINDOW;
        this.earBuffer.push(rawEar);
        if (this.earBuffer.length > window) this.earBuffer.shift();
        const sorted = [...this.earBuffer].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Processa um novo EAR cru. `threshold` é passado a cada chamada (não
     * guardado) porque pode mudar entre frames (recalibração) sem exigir
     * recriar o detector.
     */
    public update(rawEar: number, threshold: number): EyeStateUpdate {
        const now = this.clock.now();
        const ear = this.smooth(rawEar);

        const below = ear < threshold;
        if (below) {
            if (this.closedCandidateSince === null) this.closedCandidateSince = now;
            this.belowThresholdStreak++;
        } else {
            this.belowThresholdStreak = 0;
            this.closedCandidateSince = null;
        }

        const wasClosed = this.state === 'CLOSED' || this.state === 'OPENING';
        // Confirmação por TEMPO (fenômeno fisiológico) com piso de quadros
        // (proteção contra ruído) — ver docstring de EyeStateConfig.
        const belowForMs = this.closedCandidateSince !== null ? now - this.closedCandidateSince : 0;
        const confirmed =
            belowForMs >= this.config.closeConfirmMs &&
            this.belowThresholdStreak >= this.config.closeConfirmMinFrames;

        let nowClosed = wasClosed;
        if (!wasClosed && confirmed) {
            nowClosed = true;
        } else if (wasClosed && ear > threshold * this.config.hysteresisFactor) {
            nowClosed = false;
        }

        let closedSegmentEnded: ClosedSegment | null = null;

        if (nowClosed && !wasClosed) {
            this.closedSince = this.closedCandidateSince ?? now;
            this.state = 'CLOSED';
        } else if (!nowClosed && wasClosed) {
            const start = this.closedSince ?? now;
            closedSegmentEnded = { start, end: now, durationMs: now - start };
            this.closedSince = null;
            this.belowThresholdStreak = 0;
            this.closedCandidateSince = null;
            this.state = 'OPEN';
        } else if (nowClosed && wasClosed) {
            // Ainda fechado — distingue CLOSED (ear <= threshold) de OPENING
            // (na zona-morta da histerese, sinal de que está reabrindo).
            this.state = ear <= threshold ? 'CLOSED' : 'OPENING';
        } else {
            // Não fechado — distingue OPEN de CLOSING (streak em confirmação).
            this.state = below ? 'CLOSING' : 'OPEN';
        }

        const closedForMs = nowClosed && this.closedSince !== null ? now - this.closedSince : 0;

        return { ear, state: this.state, closed: nowClosed, closedForMs, closedSegmentEnded };
    }

    /**
     * Rosto perdido / EAR não confiável neste frame. Fecha um segmento em
     * aberto (se houver) e zera os contadores — sem isso, um "since" de
     * antes da perda de rosto sobrevive ao gap e o primeiro frame de EAR
     * baixo pós-reaquisição (ruído comum de tracking) computaria a duração
     * do fechamento incluindo todo o tempo em que o rosto esteve ausente.
     * (Este era o bug corrigido em `processNoFace()` antes da extração —
     * ver `.ai/memory.md`, entrada de 2026-09-20/23.)
     */
    public markUnknown(): ClosedSegment | null {
        const now = this.clock.now();
        let closedSegmentEnded: ClosedSegment | null = null;
        if ((this.state === 'CLOSED' || this.state === 'OPENING') && this.closedSince !== null) {
            closedSegmentEnded = { start: this.closedSince, end: now, durationMs: now - this.closedSince };
        }
        this.state = 'UNKNOWN';
        this.closedSince = null;
        this.belowThresholdStreak = 0;
        this.closedCandidateSince = null;
        this.earBuffer = [];
        return closedSegmentEnded;
    }

    public getState(): EyeState {
        return this.state;
    }

    public reset(): void {
        this.earBuffer = [];
        this.belowThresholdStreak = 0;
        this.closedCandidateSince = null;
        this.state = 'UNKNOWN';
        this.closedSince = null;
    }
}
