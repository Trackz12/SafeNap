type Listener = () => void;

export interface CalibrationProgressState {
    /** true enquanto o detector está na fase 1/2 da calibração. */
    isCalibrating: boolean;
    phase: 'open' | 'closed';
    openCount: number;
    closedCount: number;
    /** Resultado da última tentativa remota (null enquanto em andamento/sem dados). */
    outcome: string | null;
    receivedAt: number;
}

const listeners = new Set<Listener>();

let progress: CalibrationProgressState = {
    isCalibrating: false,
    phase: 'open',
    openCount: 0,
    closedCount: 0,
    outcome: null,
    receivedAt: 0,
};

function notify(): void {
    for (const cb of listeners) cb();
}

export const calibrationProgress = {
    get(): CalibrationProgressState {
        return progress;
    },

    receive(
        isCalibrating: boolean,
        phase: 'open' | 'closed',
        openCount: number,
        closedCount: number,
        outcome: string | null,
    ): void {
        progress = { isCalibrating, phase, openCount, closedCount, outcome, receivedAt: Date.now() };
        notify();
    },

    clear(): void {
        if (!progress.isCalibrating && progress.outcome === null) return;
        progress = { isCalibrating: false, phase: 'open', openCount: 0, closedCount: 0, outcome: null, receivedAt: 0 };
        notify();
    },

    subscribe(cb: Listener): () => void {
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    },
};
