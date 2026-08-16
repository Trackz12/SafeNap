import React from 'react';

export const EarBar: React.FC<{ ear: number; threshold: number }> = ({ ear, threshold }) => {
    const max = 0.45;
    const pct = Math.min(100, Math.max(0, (ear / max) * 100));
    const thresholdPct = Math.min(100, Math.max(0, (threshold / max) * 100));
    const closed = ear < threshold;

    return (
        <div style={{ width: '100%', background: 'rgba(0,0,0,0.6)', borderRadius: 6, padding: '4px 8px', marginTop: 4 }}>
            <div style={{ position: 'relative', height: 8, background: 'rgba(255,255,255,0.15)', borderRadius: 4 }}>
                <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${pct}%`,
                    background: closed ? 'var(--alarm)' : 'var(--primary)',
                    borderRadius: 4,
                    transition: 'width 0.15s linear, background 0.2s',
                }} />
                <div style={{
                    position: 'absolute', top: -2, bottom: -2,
                    left: `${thresholdPct}%`,
                    width: 2,
                    background: 'var(--alarm)',
                }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#e2e8f0', marginTop: 2 }}>
                <span>EAR {ear.toFixed(3)}</span>
                <span>limite {threshold.toFixed(3)}</span>
            </div>
        </div>
    );
};
