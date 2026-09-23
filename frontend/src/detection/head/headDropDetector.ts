import type { Clock } from '../temporal/clock';

/**
 * Queda de cabeça — extraído de `DetectionEngine.processHeadDrop()`.
 *
 * Exige corroboração ocular desde 2026-09-23 (achado de auditoria real:
 * olhar pro painel/celular com os olhos bem abertos disparava aviso sozinho,
 * porque a detecção olhava só a posição do nariz). Sonolência real sempre
 * vem com a pálpebra caindo junto — mesmo relaxamento muscular — enquanto um
 * olhar alerta pra baixo não tem esse sinal. Preservado aqui, não é uma
 * mudança desta refatoração.
 */
export interface HeadDropConfig {
    /** Margem acima do baseline de nose-drop que conta como "cabeça caindo". */
    margin: number;
    minMs: number;
}

export interface HeadDropResult {
    dropped: boolean;
}

export class HeadDropDetector {
    private readonly clock: Clock;
    private config: HeadDropConfig;

    private dropSince: number | null = null;
    private dropped = false;

    constructor(clock: Clock, config: HeadDropConfig) {
        this.clock = clock;
        this.config = config;
    }

    public updateConfig(config: HeadDropConfig): void {
        this.config = config;
    }

    /**
     * `baseline` null significa "ainda sem calibração de nose-drop" — a
     * detecção fica desativada (nunca reporta dropped=true), mesmo
     * comportamento do código original.
     */
    public update(noseDropRatio: number, baseline: number | null, eyesLookAlert: boolean): HeadDropResult {
        if (baseline === null) {
            this.dropped = false;
            this.dropSince = null;
            return { dropped: false };
        }

        const now = this.clock.now();
        const droppedNow = noseDropRatio > baseline + this.config.margin;

        if (droppedNow) {
            if (this.dropSince === null) this.dropSince = now;
            if (!this.dropped && !eyesLookAlert && now - this.dropSince >= this.config.minMs) {
                this.dropped = true;
            }
        } else {
            this.dropSince = null;
            if (this.dropped && noseDropRatio < baseline + this.config.margin * 0.5) {
                this.dropped = false;
            }
        }

        return { dropped: this.dropped };
    }

    public reset(): void {
        this.dropSince = null;
        this.dropped = false;
    }
}
