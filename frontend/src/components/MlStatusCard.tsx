import React, { useEffect, useState } from 'react';
import { modelStatusStore, type ModelStatus } from '../ml/modelStatusStore';
import { metricsStore } from '../detection/metricsStore';
import { BrainCircuit, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

const STATUS_CONFIG: Record<ModelStatus, { label: string; color: string; badge: string }> = {
    idle:    { label: 'Modelo ML não carregado',  color: 'var(--text-muted)', badge: 'badge-muted' },
    loading: { label: 'Carregando modelo ML…',    color: 'var(--warning)',    badge: 'badge-yellow' },
    ready:   { label: 'Modelo ML pronto',         color: 'var(--primary)',    badge: 'badge-green' },
    error:   { label: 'Modelo ML com erro',        color: 'var(--alarm)',      badge: 'badge-red' },
};

const STATUS_ICONS: Record<ModelStatus, React.ReactNode> = {
    idle:    <BrainCircuit size={14} />,
    loading: <Loader2 size={14} className="spin" />,
    ready:   <CheckCircle2 size={14} />,
    error:   <AlertTriangle size={14} />,
};

export const MlStatusCard: React.FC = () => {
    const [status, setStatus] = useState<ModelStatus>(modelStatusStore.getStatus());
    const [error, setError] = useState<string | null>(modelStatusStore.getError());
    const [score, setScore] = useState<number | null>(null);

    useEffect(() => {
        const unsub = modelStatusStore.subscribe(() => {
            setStatus(modelStatusStore.getStatus());
            setError(modelStatusStore.getError());
        });
        const unsubMetrics = metricsStore.subscribe((m) => setScore(m.mlScore));
        return () => { unsub(); unsubMetrics(); };
    }, []);

    const cfg = STATUS_CONFIG[status];
    const scorePct = score === null ? null : Math.round(score * 100);
    const scoreColor = scorePct !== null
        ? scorePct > 85 ? 'var(--alarm)' : scorePct > 70 ? 'var(--warning)' : 'var(--primary)'
        : 'var(--text-muted)';

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            <div className="glass-panel-header">
                <span className="glass-panel-title">Modelo ML</span>
                <span className={`badge ${cfg.badge}`}>
                    {STATUS_ICONS[status]}
                    {cfg.label}
                </span>
            </div>

            {error && (
                <div style={{
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--alarm-dim)',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--alarm)',
                    lineHeight: 1.5,
                }}>
                    {error}
                </div>
            )}

            {status === 'ready' && scorePct !== null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Score de sonolência</span>
                    <span style={{ fontWeight: 600, fontSize: 'var(--text-md)', color: scoreColor, fontVariantNumeric: 'tabular-nums' }}>
                        {scorePct}%
                    </span>
                </div>
            )}

            {status === 'ready' && scorePct === null && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                    Aguardando frames…
                </div>
            )}
        </div>
    );
};
