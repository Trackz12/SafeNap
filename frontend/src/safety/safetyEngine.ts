import { metricsStore } from '../detection/metricsStore';
import type { DetectionMetrics, DetectionState, AlarmReason, WarningReason } from '../detection/detectionEngine';

export type SafetyState = DetectionState;

export type SafetyReason = AlarmReason | WarningReason | null;

export interface SafetySnapshot {
    state: SafetyState;
    reason: SafetyReason;
}

/**
 * Espelha o estado da engine de deteção para a camada de UI.
 * A fonte de verdade é o DetectionEngine (frontend), já que toda a lógica
 * de decisão roda localmente conforme a arquitetura do projeto.
 * O backend apenas reage aos eventos para acionar o hardware (Arduino).
 */
export class SafetyEngine {
    private currentState: SafetyState = 'NORMAL';
    private reason: SafetyReason = null;
    private listeners: Array<(...args: any[]) => void> = [];

    constructor() {
        metricsStore.subscribe((metrics: DetectionMetrics) => {
            this.setState(metrics.state, metrics.reason);
        });
    }

    private setState(newState: SafetyState, reason: SafetyReason) {
        if (this.currentState !== newState || this.reason !== reason) {
            this.currentState = newState;
            this.reason = reason;
            this.notifyListeners();
        }
    }

    public getState(): SafetyState {
        return this.currentState;
    }

    public getSnapshot(): SafetySnapshot {
        return { state: this.currentState, reason: this.reason };
    }

    public onStateChange(callback: (snapshot: SafetySnapshot) => void): () => void {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== callback);
        };
    }

    private notifyListeners() {
        this.listeners.forEach(cb => cb(this.getSnapshot()));
    }
}

export const safetyEngine = new SafetyEngine();
