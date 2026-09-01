import React from 'react';
import { useMetrics } from '../detection/useMetrics';
import type { DetectionState } from '../detection/detectionEngine';

const STATE_CONFIG: Record<DetectionState, { color: string; label: string; sub: string; badge: string }> = {
    NORMAL:  { color: 'var(--primary)',  label: 'Normal',   sub: 'Monitorando sem sinais de fadiga', badge: 'badge-green' },
    WARNING: { color: 'var(--warning)',  label: 'Atenção',  sub: 'Sinais de fadiga detectados',      badge: 'badge-yellow' },
    ALARM:   { color: 'var(--alarm)',    label: 'Perigo',   sub: 'Sonolência confirmada — reaja!',   badge: 'badge-red' },
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
            MICROSLEEP: 'Micro-sono detectado',
            EAR_TREND: 'Fadiga crescente (pálpebras pesando)',
            ML_WARNING: 'Modelo ML: alto risco de fadiga',
            ML_ALARM: 'Modelo ML: sonolência confirmada',
        };
        return map[metrics.reason] ?? metrics.reason;
    }, [metrics.reason]);

    return (
        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', padding: 'var(--space-5) var(--space-6)' }}>
            {/* Gauge ring */}
            <div style={{ position: 'relative', width: 160, height: 160, flexShrink: 0 }}>
                <svg viewBox="0 0 190 190" style={{ transform: 'rotate(-90deg)', width: '100%', height: '100%' }}>
                    {/* Track */}
                    <circle
                        cx="95" cy="95" r={RADIUS}
                        fill="none"
                        stroke="var(--border-subtle)"
                        strokeWidth="10"
                    />

                    {/* Value arc */}
                    <circle
                        cx="95" cy="95" r={RADIUS}
                        fill="none"
                        stroke={cfg.color}
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={CIRCUMFERENCE}
                        strokeDashoffset={dashOffset}
                        style={{
                            transition: 'stroke-dashoffset 0.4s cubic-bezier(0.16,1,0.3,1), stroke 0.3s ease',
                            filter: `drop-shadow(0 0 8px ${cfg.color}40)`,
                        }}
                    />

                    {/* Threshold markers */}
                    {[warningAngle, alarmAngle].map((angle, i) => (
                        <circle
                            key={i}
                            cx="95" cy="95" r={RADIUS}
                            fill="none"
                            stroke={i === 0 ? 'var(--warning)' : 'var(--alarm)'}
                            strokeWidth="2"
                            strokeDasharray={`2 ${CIRCUMFERENCE - 2}`}
                            strokeDashoffset={-angle}
                            opacity="0.6"
                        />
                    ))}
                </svg>

                {/* Center content */}
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '1px',
                }}>
                    <span style={{
                        fontSize: 'var(--text-xs)',
                        fontWeight: 500,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                    }}>PERCLOS</span>

                    <span style={{
                        fontSize: '2rem',
                        fontWeight: 700,
                        color: cfg.color,
                        lineHeight: 1,
                        fontVariantNumeric: 'tabular-nums',
                        letterSpacing: '-0.03em',
                    }}>
                        {(perclosPct * 100).toFixed(0)}%
                    </span>

                    <span style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-faint)',
                    }}>últimos 60s</span>
                </div>
            </div>

            {/* Info */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span className={`badge ${cfg.badge}`}>
                        {cfg.label}
                    </span>
                </div>

                <p style={{
                    fontSize: 'var(--text-md)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.4,
                    margin: 0,
                }}>
                    {reason ?? cfg.sub}
                </p>

                {/* Mini status dots row */}
                <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', opacity: metrics.state === 'NORMAL' ? 1 : 0.3 }} />
                        Normal
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)', opacity: metrics.state === 'WARNING' ? 1 : 0.3 }} />
                        Atenção
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--alarm)', opacity: metrics.state === 'ALARM' ? 1 : 0.3 }} />
                        Perigo
                    </span>
                </div>
            </div>
        </div>
    );
};
