import React, { useEffect, useState } from 'react';
import { modelStatusStore, type ModelStatus } from '../ml/modelStatusStore';
import { drowsinessModel } from '../ml/drowsinessModel';
import { BrainCircuit, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

const STATUS_LABEL: Record<ModelStatus, string> = {
    idle: 'Modelo ML não carregado',
    loading: 'Carregando modelo ML…',
    ready: 'Modelo ML pronto',
    error: 'Modelo ML com erro',
};

const STATUS_COLOR: Record<ModelStatus, string> = {
    idle: 'var(--muted)',
    loading: 'var(--warning)',
    ready: 'var(--primary)',
    error: 'var(--alarm)',
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

        const interval = setInterval(() => {
            const result = drowsinessModel.getLastScore();
            setScore(result.score);
        }, 500);

        return () => {
            unsub();
            clearInterval(interval);
        };
    }, []);

    const color = STATUS_COLOR[status];
    const scorePct = score === null ? null : Math.round(score * 100);

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 14px',
            borderRadius: '10px',
            background: 'color-mix(in srgb, ' + color + ' 8%, transparent)',
            border: '1px solid color-mix(in srgb, ' + color + ' 25%, transparent)',
            fontSize: '0.85rem',
        }}>
            {status === 'loading' && <Loader2 size={18} color="var(--warning)" className="spin" />}
            {status === 'ready' && <CheckCircle2 size={18} color="var(--primary)" />}
            {status === 'error' && <AlertTriangle size={18} color="var(--alarm)" />}
            {status === 'idle' && <BrainCircuit size={18} color="var(--muted)" />}

            <div style={{ flex: 1 }}>
                <div style={{ color, fontWeight: 600 }}>{STATUS_LABEL[status]}</div>
                {error && (
                    <div style={{ color: 'var(--alarm)', fontSize: '0.75rem' }}>
                        {error}
                    </div>
                )}
                {status === 'ready' && scorePct !== null && (
                    <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
                        Score de sonolência: <strong style={{ color: scorePct > 85 ? 'var(--alarm)' : scorePct > 70 ? 'var(--warning)' : 'var(--primary)' }}>{scorePct}%</strong>
                    </div>
                )}
                {status === 'ready' && scorePct === null && (
                    <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
                        Aguardando frames…
                    </div>
                )}
            </div>
        </div>
    );
};
