import React, { useEffect, useRef, useState } from 'react';
import { sessionStats, type SessionSnapshot } from '../detection/sessionStats';
import { Clock, Eye, Activity, AlertTriangle } from 'lucide-react';

function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export const SessionStatsPanel: React.FC = () => {
    const [snap, setSnap] = useState<SessionSnapshot | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        const update = () => {
            setSnap(sessionStats.snapshot(Date.now(), 0));
        };
        update();
        timerRef.current = setInterval(update, 1000);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, []);

    if (!snap) return null;

    const items = [
        { icon: <Clock size={18} color="var(--primary)" />, label: 'Tempo ativo', value: snap.active ? formatDuration(snap.durationMs) : '—' },
        { icon: <Eye size={18} color="var(--primary)" />, label: 'Piscadas', value: `${snap.blinkCount}` },
        { icon: <Activity size={18} color="var(--primary)" />, label: 'EAR médio', value: snap.avgEar > 0 ? snap.avgEar.toFixed(3) : '—' },
        { icon: <AlertTriangle size={18} color="var(--warning)" />, label: 'Avisos', value: `${snap.warningCount}` },
    ];

    return (
        <div className="glass-panel" style={{ padding: '1rem' }}>
            <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '1rem' }}>Sessão atual</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
                {items.map((it) => (
                    <div key={it.label} className="metric-card" style={{ margin: 0, padding: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        {it.icon}
                        <div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{it.label}</div>
                            <div style={{ fontWeight: 700, fontSize: '1.05rem', fontVariantNumeric: 'tabular-nums' }}>{it.value}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
