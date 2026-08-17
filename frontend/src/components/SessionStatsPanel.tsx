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

const STAT_ITEMS = [
    { icon: Clock,       color: 'var(--primary)',  label: 'Tempo ativo', getVal: (s: SessionSnapshot) => s.active ? formatDuration(s.durationMs) : '—' },
    { icon: Eye,         color: 'var(--primary)',  label: 'Piscadas',   getVal: (s: SessionSnapshot) => `${s.blinkCount}` },
    { icon: Activity,    color: 'var(--primary)',  label: 'EAR médio',  getVal: (s: SessionSnapshot) => s.avgEar > 0 ? s.avgEar.toFixed(3) : '—' },
    { icon: AlertTriangle, color: 'var(--warning)', label: 'Avisos',    getVal: (s: SessionSnapshot) => `${s.warningCount}` },
];

export const SessionStatsPanel: React.FC = () => {
    const [snap, setSnap] = useState<SessionSnapshot | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        const update = () => setSnap(sessionStats.snapshot(Date.now(), 0));
        update();
        timerRef.current = setInterval(update, 1000);
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, []);

    if (!snap) return null;

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            <div className="glass-panel-header">
                <span className="glass-panel-title">Sessão atual</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)' }}>
                {STAT_ITEMS.map(({ icon: Icon, color, label, getVal }) => (
                    <div key={label} className="metric-card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                        <div style={{
                            width: 28,
                            height: 28,
                            borderRadius: 'var(--radius-sm)',
                            background: `${color}10`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                        }}>
                            <Icon size={14} color={color} />
                        </div>
                        <div>
                            <div className="metric-label">{label}</div>
                            <div style={{
                                fontWeight: 600,
                                fontSize: 'var(--text-lg)',
                                fontVariantNumeric: 'tabular-nums',
                                letterSpacing: '-0.01em',
                            }}>
                                {getVal(snap)}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
