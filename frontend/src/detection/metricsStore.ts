import type { DetectionMetrics } from './detectionEngine';

type Listener = (metrics: DetectionMetrics) => void;

class MetricsStore {
    private listeners: Listener[] = [];
    private latest: DetectionMetrics | null = null;

    public publish(metrics: DetectionMetrics): void {
        this.latest = metrics;
        for (const cb of this.listeners) {
            try {
                cb(metrics);
            } catch (e) {
                console.error('Erro em listener de metricas:', e);
            }
        }
    }

    public get(): DetectionMetrics | null {
        return this.latest;
    }

    public subscribe(cb: Listener): () => void {
        this.listeners.push(cb);
        if (this.latest) cb(this.latest);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== cb);
        };
    }
}

export const metricsStore = new MetricsStore();
