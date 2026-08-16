import type { DetectionState } from './detectionEngine';

export interface HistoryPoint {
    t: number;
    ear: number;
    perclos: number;
    state: DetectionState;
}

export interface SessionSnapshot {
    active: boolean;
    durationMs: number;
    blinkCount: number;
    blinkRate: number;
    episodeCount: number;
    warningCount: number;
    avgEar: number;
    drowsyTimeMs: number;
    history: HistoryPoint[];
}

const HISTORY_MAX_SECONDS = 90;

class SessionStats {
    private startedAt: number | null = null;
    private blinkCount = 0;
    private episodeCount = 0;
    private warningCount = 0;
    private earSum = 0;
    private earCount = 0;
    private drowsySamples = 0;
    private totalSamples = 0;
    private lastSampleAt = 0;
    private history: HistoryPoint[] = [];

    public markStarted(now: number): void {
        if (this.startedAt === null) this.startedAt = now;
    }

    public recordBlink(now: number): void {
        this.blinkCount++;
        void now;
    }

    public recordEpisode(now: number): void {
        this.episodeCount++;
        void now;
    }

    public recordWarning(now: number): void {
        this.warningCount++;
        void now;
    }

    public addEar(ear: number): void {
        this.earSum += ear;
        this.earCount++;
    }

    public sample(now: number, ear: number, perclos: number, state: DetectionState = 'NORMAL'): void {
        this.totalSamples++;
        if (state !== 'NORMAL') this.drowsySamples++;
        this.lastSampleAt = now;
        this.history.push({ t: now, ear, perclos, state });

        const cutoff = now - HISTORY_MAX_SECONDS * 1000;
        while (this.history.length > 0 && this.history[0].t < cutoff) {
            this.history.shift();
        }
    }

    public getHistory(): HistoryPoint[] {
        return this.history;
    }

    public snapshot(now: number, blinkRate: number): SessionSnapshot {
        return {
            active: this.startedAt !== null && now - this.lastSampleAt < 5000,
            durationMs: this.startedAt !== null ? now - this.startedAt : 0,
            blinkCount: this.blinkCount,
            blinkRate,
            episodeCount: this.episodeCount,
            warningCount: this.warningCount,
            avgEar: this.earCount > 0 ? this.earSum / this.earCount : 0,
            drowsyTimeMs: this.totalSamples > 0
                ? (this.drowsySamples / this.totalSamples) * (this.duration(now))
                : 0,
            history: this.history,
        };
    }

    private duration(now: number): number {
        return this.startedAt !== null ? now - this.startedAt : 0;
    }

    public reset(): void {
        this.startedAt = null;
        this.blinkCount = 0;
        this.episodeCount = 0;
        this.warningCount = 0;
        this.earSum = 0;
        this.earCount = 0;
        this.drowsySamples = 0;
        this.totalSamples = 0;
        this.lastSampleAt = 0;
        this.history = [];
    }

    /**
     * Aplica um snapshot recebido do device detector via sync.
     * Os contadores são espelhados integralmente; o histórico curto recebido
     * mantém o gráfico ao vivo do lado viewer.
     */
    public applyRemote(snap: SessionSnapshot): void {
        this.startedAt = snap.active ? Date.now() - snap.durationMs : this.startedAt;
        this.blinkCount = snap.blinkCount;
        this.episodeCount = snap.episodeCount;
        this.warningCount = snap.warningCount;
        if (snap.avgEar > 0) {
            this.earSum = snap.avgEar;
            this.earCount = 1;
        }
        if (snap.durationMs > 0) {
            // Reconstrói a razão de tempo sonolento de forma coerente.
            this.totalSamples = 1000;
            this.drowsySamples = Math.round((snap.drowsyTimeMs / snap.durationMs) * 1000);
        }
        if (snap.history.length > 0) {
            this.history = snap.history.slice();
        }
        this.lastSampleAt = snap.active ? Date.now() : this.lastSampleAt;
    }
}

export const sessionStats = new SessionStats();
