import React from 'react';

export const EarBar: React.FC<{ ear: number; threshold: number }> = ({ ear, threshold }) => {
    const max = 0.45;
    const pct = Math.min(100, Math.max(0, (ear / max) * 100));
    const thresholdPct = Math.min(100, Math.max(0, (threshold / max) * 100));
    const closed = ear < threshold;

    return (
        <div style={{ width: '100%' }}>
            {/* Progress bar */}
            <div style={{ position: 'relative', height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
                <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${pct}%`,
                    background: closed ? 'var(--alarm)' : 'var(--primary)',
                    borderRadius: 2,
                    transition: 'width 0.15s linear, background 0.2s',
                    boxShadow: closed ? '0 0 8px var(--alarm)' : 'none',
                }} />
                <div style={{
                    position: 'absolute', top: -3, bottom: -3,
                    left: `${thresholdPct}%`,
                    width: 2,
                    background: 'var(--alarm)',
                    borderRadius: 1,
                    opacity: 0.7,
                }} />
            </div>
            {/* Labels */}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: 'var(--text-xs)', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: closed ? 'var(--alarm)' : 'var(--primary)', fontWeight: closed ? 600 : 400 }}>
                    EAR {ear.toFixed(3)}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.5)' }}>
                    limite {threshold.toFixed(3)}
                </span>
            </div>
        </div>
    );
};
