import { useEffect, useState } from 'react';
import { metricsStore } from '../detection/metricsStore';
import { DEFAULT_METRICS, type DetectionMetrics } from '../detection/detectionEngine';

/**
 * Assina o metricsStore com throttling: a engine publica a cada frame (~10/s),
 * mas a UI so precisa atualizar em intervalos humanos para economizar bateria/CPU no celular.
 */
export function useMetrics(throttleMs = 250): DetectionMetrics {
    const [metrics, setMetrics] = useState<DetectionMetrics>(
        metricsStore.get() ?? DEFAULT_METRICS
    );

    useEffect(() => {
        let lastPush = 0;
        let pending: DetectionMetrics | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const unsubscribe = metricsStore.subscribe((m) => {
            const now = Date.now();
            if (now - lastPush >= throttleMs) {
                lastPush = now;
                setMetrics(m);
            } else {
                pending = m;
                if (!timer) {
                    timer = setTimeout(() => {
                        timer = null;
                        if (pending) {
                            lastPush = Date.now();
                            setMetrics(pending);
                            pending = null;
                        }
                    }, throttleMs - (now - lastPush));
                }
            }
        });

        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [throttleMs]);

    return metrics;
}
