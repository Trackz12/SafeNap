import React from 'react';
import { useMetrics } from '../detection/useMetrics';
import type { DetectionState } from '../detection/detectionEngine';

const STATE_CONFIG: Record<DetectionState, { color: string; label: string; sub: string }> = {
    NORMAL: { color: 'var(--primary)', label: 'NORMAL', sub: 'Monitorando sem sinais de fadiga' },
    WARNING: { color: 'var(--warning)', label: 'ATENÇÃO', sub: 'Sinais de fadiga detectados' },
    ALARM: { color: 'var(--alarm)', label: 'PERIGO', sub: 'Sonolência confirmada — reaja!' },
};

const RADIUS = 74;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const StatusGauge: React.FC = () => {
    const metrics = useMetrics(250);
    const cfg = STATE_CONFIG[metrics.state];

    const perclosPct = Math.min(1, metrics.perclos);
    const warningLevel = 0.25;
    const alarmLevel = 0.45;
    const scaleMax = 0.7;
    const gaugePct = Math.min(1, perclosPct / scaleMax);

    const dashOffset = CIRCUMFERENCE * (1 - gaugePct);

    const warningAngle = Math.min(warningLevel / scaleMax, 1) * CIRCUMFERENCE;
    const alarmAngle = Math.min(alarmLevel / scaleMax, 1) * CIRCUMFERENCE;

    const reason = React.useMemo(() => {
        if (!metrics.reason) return null;
        const map: Record<string, string> = {
            EYES_CLOSED_DURATION: 'Olhos fechados por tempo prolongado',
            PERCLOS_CRITICAL: 'PERCLOS crítico',
            PERCLOS: 'PERCLOS elevado',
            YAWN: 'Bocejo detectado',
            HEAD_DROP: 'Cabeça abaixando',
            FACE_LOST: 'Rosto fora do enquadramento',
            PROLONGED_CLOSE: 'Olhos fechados acima do normal',
            ML_WARNING: 'Modelo ML: alto risco de fadiga',
            ML_ALARM: 'Modelo ML: sonolência confirmada',
        };
        return map[metrics.reason] ?? metrics.reason;
    }, [metrics.reason]);

    return (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', padding: '1.5rem 1rem' }}>
            <div style={{ position: 'relative', width: 190, height: 190 }}>
                <svg viewBox="0 0 190 190" style={{ transform: 'rotate(-90deg)', width: '100%', height: '100%' }}>
                    <circle cx="95" cy="95" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="12" />

                    <circle
                        cx="95" cy="95" r={RADIUS} fill="none"
                        stroke={cfg.color}
                        strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={CIRCUMFERENCE}
                        strokeDashoffset={dashOffset}
                        style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease', filter: `drop-shadow(0 0 6px ${cfg.color})` }}
                    />

                    {[warningAngle, alarmAngle].map((angle, i) => (
                        <circle
                            key={i}
                            cx="95" cy="95" r={RADIUS} fill="none"
                            stroke={i === 0 ? 'var(--warning)' : 'var(--alarm)'}
                            strokeWidth="4"
                            strokeDasharray={`2 ${CIRCUMFERENCE - 2}`}
                            strokeDashoffset={-angle}
                            opacity="0.85"
                        />
                    ))}
                </svg>

                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>PERCLOS</div>
                    <div style={{ fontSize: '2rem', fontWeight: 700, color: cfg.color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                        {(perclosPct * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>últimos 60s</div>
                    <div style={{
                        marginTop: '0.4rem',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        letterSpacing: '0.1em',
                        color: cfg.color,
                        border: `1px solid ${cfg.color}`,
                        borderRadius: 999,
                        padding: '2px 12px',
                        background: 'rgba(0,0,0,0.3)',
                    }}>
                        {cfg.label}
                    </div>
                </div>
            </div>

            <div style={{ textAlign: 'center', marginTop: '0.25rem' }}>
                <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{reason ?? cfg.sub}</div>
            </div>
        </div>
    );
};
