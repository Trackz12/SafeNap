const STORAGE_KEY = 'safenap_calibration_v3';

export const DEFAULT_THRESHOLD = 0.25;

// Mínimo de amostras por fase (aberta e fechada) — ~2s a 10fps cada.
export const MIN_CALIBRATION_SAMPLES = 20;

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
            console.warn("Calibração salva inválida; recalcule.", e);
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

    public startCalibration(): void {
        this.isCalibrating = true;
        this.phase = 'open';
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.settleUntil = Date.now() + this.settleDelayMs;
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
        this.notify();
        return true;
    }

    public finishCalibration(): number | null {
        this.isCalibrating = false;
        this.phase = 'idle';

        if (
            this.openSamples.length < MIN_CALIBRATION_SAMPLES ||
            this.closedSamples.length < MIN_CALIBRATION_SAMPLES
        ) {
            this.openSamples = [];
            this.closedSamples = [];
            this.noseDropSamples = [];
            this.notify();
            return null;
        }

        const openMedian = median(this.openSamples);
        const closedMedian = median(this.closedSamples);
        const gap = openMedian - closedMedian;

        if (gap < MIN_OPEN_CLOSED_GAP) {
            this.openSamples = [];
            this.closedSamples = [];
            this.noseDropSamples = [];
            this.notify();
            return null;
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
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.persist();
        this.notify();
        return this.closedEyeThreshold;
    }

    public cancelCalibration(): void {
        this.isCalibrating = false;
        this.phase = 'idle';
        this.openSamples = [];
        this.closedSamples = [];
        this.noseDropSamples = [];
        this.notify();
    }

    // ---------- persistência manual (usado por testes / fallback) ----------

    public clearCalibration(): void {
        this.baselineEar = null;
        this.closedBaselineEar = null;
        this.baselineNoseDrop = null;
        this.closedEyeThreshold = DEFAULT_THRESHOLD;
        this.calibratedAt = null;
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

    // ---------- getters ----------

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
