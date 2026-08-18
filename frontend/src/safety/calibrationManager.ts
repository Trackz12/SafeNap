const STORAGE_KEY = 'safenap_calibration_v3';

export const DEFAULT_THRESHOLD = 0.25;

// Mínimo de amostras por fase (aberta e fechada) — ~2s a 10fps cada.
export const MIN_CALIBRATION_SAMPLES = 20;

// Tempo máximo por fase de calibração antes de abortar com timeout.
export const MAX_CALIBRATION_PHASE_MS = 12000;

// Após quanto tempo sem recalibrar o sistema sugere uma nova calibração.
export const RECALIBRATION_PROMPT_MS = 6 * 60 * 60 * 1000;

// Limites de sanidade do threshold.
const THRESHOLD_MIN = 0.12;
const THRESHOLD_MAX = 0.45;

// Separção mínima entre as medianas aberta/fechada — abaixo disso o usuário
// provavelmente não fechou os olhos e a calibração é descartada.
const MIN_OPEN_CLOSED_GAP = 0.05;

// Tempo sem coleta logo após iniciar a calibração — dá tempo para
// auto-exposição/auto-foco estabilizarem antes de capturar a baseline.
const DEFAULT_SETTLE_MS = 1200;

export type CalibrationPhase = 'idle' | 'open' | 'closed';

/** Resultado da última tentativa de calibração (null = nenhuma/não aplicável). */
export type CalibrationOutcome = 'ok' | 'timeout' | 'gap' | 'insufficient_samples' | null;

interface PersistedCalibration {
    baselineEar: number;
    threshold: number;
    baselineNoseDrop: number | null;
    calibratedAt: number;
}

const clamp = (v: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, v));

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Payload compartilhado da calibração (detector -> backend -> viewers). */
export interface RemoteCalibration {
    baselineEar: number | null;
    closedBaselineEar?: number | null;
    threshold: number;
    baselineNoseDrop: number | null;
    calibratedAt: number | null;
    skipped?: boolean;
}

export class CalibrationManager {
    private baselineEar: number | null = null;
    private closedBaselineEar: number | null = null;
    private baselineNoseDrop: number | null = null;
    private closedEyeThreshold: number = DEFAULT_THRESHOLD;
    private calibratedAt: number | null = null;

    private readonly warningDuration = 1000;
    private readonly alarmDuration = 1500;

    public isCalibrating: boolean = false;
    public phase: CalibrationPhase = 'idle';

    private lastOutcome: CalibrationOutcome = null;
    private phaseStartedAt: number | null = null;

    /** Usuário optou por monitorar sem calibrar (threshold padrão). */
    private useDefaultSkip = false;

    private openSamples: number[] = [];
    private closedSamples: number[] = [];
    private noseDropSamples: number[] = [];
    private settleUntil = 0;
    public settleDelayMs = DEFAULT_SETTLE_MS;

    private listeners: Array<() => void> = [];

    constructor() {
        this.loadPersisted();
    }

    private loadPersisted(): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw) as PersistedCalibration;
            if (
                typeof data.baselineEar === 'number' &&
                Number.isFinite(data.baselineEar) &&
                typeof data.threshold === 'number' &&
                Number.isFinite(data.threshold)
            ) {
                this.baselineEar = data.baselineEar;
                this.baselineNoseDrop =
                    typeof data.baselineNoseDrop === 'number' ? data.baselineNoseDrop : null;
                this.closedEyeThreshold = clamp(data.threshold, THRESHOLD_MIN, THRESHOLD_MAX);
                this.calibratedAt =
                    typeof data.calibratedAt === 'number' ? data.calibratedAt : Date.now();
            }
        } catch (e) {
            console.warn("Calibração salva inválida; recalcule.", e instanceof Error ? e.message : e);
        }
    }

    private persist(): void {
        try {
            const data: PersistedCalibration = {
                baselineEar: this.baselineEar ?? DEFAULT_THRESHOLD,
                threshold: this.closedEyeThreshold,
                baselineNoseDrop: this.baselineNoseDrop,
                calibratedAt: this.calibratedAt ?? Date.now(),
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn("Falha ao salvar calibração:", e);
        }
    }

    public subscribe(cb: () => void): () => void {
        this.listeners.push(cb);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== cb);
        };
    }

    private notify(): void {
        for (const cb of this.listeners) cb();
    }

    public getSampleCount(): number {
        return this.openSamples.length;
    }

    public getOpenSampleCount(): number {
        return this.openSamples.length;
    }

    public getClosedSampleCount(): number {
        return this.closedSamples.length;
    }

    // ---------- fluxo de calibração bifásica ----------

    /** Conduz as fases automaticamente (avanço + timeout). Iniciado/parado pelo próprio manager. */
    private driver: ReturnType<typeof setInterval> | null = null;

    public startCalibration(): void {
        if (this.isCalibrating) {
            this.cancelCalibration();
        }
        this.isCalibrating = true;
        this.phase = 'open';
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.lastOutcome = null;
        this.settleUntil = Date.now() + this.settleDelayMs;
        this.phaseStartedAt = Date.now();
        this.startDriver();
        this.notify();
    }

    public addSample(ear: number, noseDropRatio?: number): void {
        if (!this.isCalibrating || this.phase === 'idle') return;
        if (Date.now() < this.settleUntil) return;
        if (!Number.isFinite(ear) || ear <= 0) return;

        if (this.phase === 'open') {
            this.openSamples.push(ear);
            if (noseDropRatio !== undefined && Number.isFinite(noseDropRatio)) {
                this.noseDropSamples.push(noseDropRatio);
            }
        } else if (this.phase === 'closed') {
            this.closedSamples.push(ear);
        }
        this.notify();
    }

    public advanceToClosedPhase(): boolean {
        if (!this.isCalibrating || this.phase !== 'open') return false;
        if (this.openSamples.length < MIN_CALIBRATION_SAMPLES) return false;
        this.phase = 'closed';
        this.settleUntil = 0; // sem nova espera de settle na fase 2
        this.phaseStartedAt = Date.now();
        this.notify();
        return true;
    }

    private startDriver(): void {
        if (this.driver) clearInterval(this.driver);
        this.driver = setInterval(() => this.driverTick(), 200);
    }

    private stopDriver(): void {
        if (this.driver) {
            clearInterval(this.driver);
            this.driver = null;
        }
    }

    private driverTick(): void {
        if (!this.isCalibrating) {
            this.stopDriver();
            return;
        }
        const now = Date.now();
        const elapsed = this.phaseStartedAt !== null ? now - this.phaseStartedAt : 0;

        if (this.phase === 'open') {
            if (this.openSamples.length >= MIN_CALIBRATION_SAMPLES) {
                this.advanceToClosedPhase();
                return;
            }
            if (elapsed > MAX_CALIBRATION_PHASE_MS) {
                this.abort('timeout');
                return;
            }
        } else if (this.phase === 'closed') {
            if (this.closedSamples.length >= MIN_CALIBRATION_SAMPLES) {
                this.finalize();
                return;
            }
            if (elapsed > MAX_CALIBRATION_PHASE_MS) {
                this.abort('timeout');
                return;
            }
        }
    }

    private abort(outcome: Exclude<CalibrationOutcome, 'ok' | null>): void {
        this.stopDriver();
        this.isCalibrating = false;
        this.phase = 'idle';
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.phaseStartedAt = null;
        this.lastOutcome = outcome;
        this.notify();
    }

    private finalize(): CalibrationOutcome {
        this.stopDriver();
        this.isCalibrating = false;
        this.phase = 'idle';

        if (
            this.openSamples.length < MIN_CALIBRATION_SAMPLES ||
            this.closedSamples.length < MIN_CALIBRATION_SAMPLES
        ) {
            this.openSamples = [];
            this.closedSamples = [];
            this.noseDropSamples = [];
            this.phaseStartedAt = null;
            this.lastOutcome = 'insufficient_samples';
            this.notify();
            return this.lastOutcome;
        }

        const openMedian = median(this.openSamples);
        const closedMedian = median(this.closedSamples);
        const gap = openMedian - closedMedian;

        if (gap < MIN_OPEN_CLOSED_GAP) {
            this.openSamples = [];
            this.closedSamples = [];
            this.noseDropSamples = [];
            this.phaseStartedAt = null;
            this.lastOutcome = 'gap';
            this.notify();
            return this.lastOutcome;
        }

        this.baselineEar = openMedian;
        this.closedBaselineEar = closedMedian;
        this.closedEyeThreshold = clamp(
            (openMedian + closedMedian) / 2,
            THRESHOLD_MIN,
            THRESHOLD_MAX,
        );
        this.baselineNoseDrop =
            this.noseDropSamples.length > 0
                ? median(this.noseDropSamples)
                : null;

        this.calibratedAt = Date.now();
        this.useDefaultSkip = false;
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.phaseStartedAt = null;
        this.lastOutcome = 'ok';
        this.persist();
        this.notify();
        return this.lastOutcome;
    }

    public finishCalibration(): number | null {
        if (!this.isCalibrating) return null;
        const outcome = this.finalize();
        return outcome === 'ok' ? this.closedEyeThreshold : null;
    }

    public cancelCalibration(): void {
        this.stopDriver();
        this.isCalibrating = false;
        this.phase = 'idle';
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.phaseStartedAt = null;
        this.notify();
    }

    // ---------- persistência manual (usado por testes / fallback) ----------

    public clearCalibration(): void {
        this.baselineEar = null;
        this.closedBaselineEar = null;
        this.baselineNoseDrop = null;
        this.closedEyeThreshold = DEFAULT_THRESHOLD;
        this.calibratedAt = null;
        this.useDefaultSkip = false;
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // ignore
        }
        this.notify();
    }

    public setBaselineEar(ear: number): void {
        this.baselineEar = ear;
        this.closedEyeThreshold = clamp(ear * 0.75, THRESHOLD_MIN, THRESHOLD_MAX);
        this.calibratedAt = Date.now();
        this.persist();
        this.notify();
    }

    /**
     * Aplica uma calibração recebida de outro dispositivo via sync.
     * Não persiste localmente (o backend é a fonte da calibração compartilhada).
     */
    public applyRemoteCalibration(remote: RemoteCalibration): void {
        if (
            typeof remote.baselineEar === 'number' &&
            Number.isFinite(remote.baselineEar) &&
            typeof remote.threshold === 'number' &&
            Number.isFinite(remote.threshold)
        ) {
            this.baselineEar = remote.baselineEar;
            this.closedBaselineEar =
                typeof remote.closedBaselineEar === 'number' ? remote.closedBaselineEar : null;
            this.closedEyeThreshold = clamp(remote.threshold, THRESHOLD_MIN, THRESHOLD_MAX);
            this.baselineNoseDrop =
                typeof remote.baselineNoseDrop === 'number' ? remote.baselineNoseDrop : null;
            this.calibratedAt =
                typeof remote.calibratedAt === 'number' ? remote.calibratedAt : Date.now();
            this.useDefaultSkip = false;
        } else if (remote.skipped === true) {
            this.useDefaultSkip = true;
        }
        this.notify();
    }

    // ---------- getters ----------

    public isCalibrated(): boolean {
        return this.baselineEar !== null && this.calibratedAt !== null;
    }

    /**
     * A detecção pode avaliar estados (WARNING/ALARM)?
     * Sim quando há calibração válida ou quando o usuário optou por usar
     * o threshold padrão (menor precisão, mas sem bloqueio).
     */
    public canEvaluate(): boolean {
        return this.isCalibrated() || this.useDefaultSkip;
    }

    /** Usuário optou por monitorar sem calibrar (threshold padrão). */
    public skipWithDefault(): void {
        this.useDefaultSkip = true;
        this.notify();
    }

    public isSkipped(): boolean {
        return this.useDefaultSkip;
    }

    /** Resultado da última tentativa de calibração (null se nunca tentou). */
    public getOutcome(): CalibrationOutcome {
        return this.lastOutcome;
    }

    /** Tempo (ms) decorrido na fase atual; null se fora de calibração. */
    public getPhaseElapsedMs(): number | null {
        if (!this.isCalibrating || this.phaseStartedAt === null) return null;
        return Date.now() - this.phaseStartedAt;
    }

    /** True durante o settle inicial (estabilização de câmera/luz). */
    public isSettling(): boolean {
        return this.isCalibrating && Date.now() < this.settleUntil;
    }

    /**
     * Verdadeiro quando a calibração vigente está velha o bastante para o
     * sistema sugerir recalibrar ao iniciar a câmera.
     */
    public isStale(): boolean {
        if (this.calibratedAt === null) return false;
        return Date.now() - this.calibratedAt > RECALIBRATION_PROMPT_MS;
    }

    public getThreshold(): number {
        return this.closedEyeThreshold;
    }

    public getBaseline(): number | null {
        return this.baselineEar;
    }

    public getClosedBaseline(): number | null {
        return this.closedBaselineEar;
    }

    public getBaselineNoseDrop(): number | null {
        return this.baselineNoseDrop;
    }

    public getCalibratedAt(): number | null {
        return this.calibratedAt;
    }

    public getAlarmDurationMs(): number {
        return this.alarmDuration;
    }

    public getWarningDurationMs(): number {
        return this.warningDuration;
    }
}

export const calibrationManager = new CalibrationManager();
