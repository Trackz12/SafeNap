import React, { useEffect, useRef, useState } from 'react';
import { sessionStats, type HistoryPoint } from '../detection/sessionStats';

const WINDOW_MS = 60000;
const W = 600;
const H = 160;
const PAD = { top: 10, right: 8, bottom: 20, left: 30 };
const EAR_MAX = 0.5;

function buildPath(points: HistoryPoint[], key: 'ear' | 'perclos', now: number): string {
    if (points.length < 2) return '';
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const start = now - WINDOW_MS;
    return points
        .map((p, i) => {
            const x = PAD.left + ((p.t - start) / WINDOW_MS) * plotW;
            const raw = key === 'ear' ? p.ear : p.perclos;
            const v = Math.min(1, Math.max(0, raw / EAR_MAX));
            const y = PAD.top + plotH - v * plotH;
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
}

function buildArea(points: HistoryPoint[], key: 'ear' | 'perclos', now: number): string {
    const line = buildPath(points, key, now);
    if (!line || points.length < 2) return '';
    const plotH = H - PAD.top - PAD.bottom;
    const baseline = PAD.top + plotH;
    const first = points[0];
    const last = points[points.length - 1];
    const start = now - WINDOW_MS;
    const plotW = W - PAD.left - PAD.right;
    const x0 = PAD.left + ((first.t - start) / WINDOW_MS) * plotW;
    const x1 = PAD.left + ((last.t - start) / WINDOW_MS) * plotW;
    return `${line} L${x1.toFixed(1)},${baseline} L${x0.toFixed(1)},${baseline} Z`;
}

export const LiveChart: React.FC = () => {
    const [, forceTick] = useState(0);
    const rafRef = useRef<number | null>(null);
    const lastUpdate = useRef(0);

    useEffect(() => {
        const tick = (t: number) => {
            if (t - lastUpdate.current >= 1000) {
                lastUpdate.current = t;
                forceTick((n) => n + 1);
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }, []);

    const now = Date.now();
    const history = sessionStats.getHistory().filter((p) => p.t >= now - WINDOW_MS);
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const baseline = PAD.top + plotH;

    const yScale = [0, 0.15, 0.3, 0.45];
    const earWarnLevel = 0.2;

    const earPath = buildPath(history, 'ear', now);
    const perclosPath = buildPath(history, 'perclos', now);
    const perclosArea = buildArea(history, 'perclos', now);

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
                <span className="glass-panel-title">Últimos 60 segundos</span>
                <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <span style={{ width: 14, height: 2, background: 'var(--primary)', borderRadius: 1, display: 'inline-block' }} />
                        EAR
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <span style={{ width: 14, height: 2, background: 'var(--warning)', borderRadius: 1, display: 'inline-block' }} />
                        PERCLOS
                    </span>
                </div>
            </div>

            {/* Chart */}
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
                <defs>
                    <linearGradient id="perclos-grad" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor="var(--warning)" stopOpacity="0.15" />
                        <stop offset="100%" stopColor="var(--warning)" stopOpacity="0" />
                    </linearGradient>
                </defs>

                {/* Grid lines */}
                {yScale.map((v) => {
                    const y = PAD.top + plotH - (v / EAR_MAX) * plotH;
                    return (
                        <g key={v}>
                            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--border-subtle)" strokeWidth="1" />
                            <text x={PAD.left - 5} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text-faint)">
                                {v.toFixed(2)}
                            </text>
                        </g>
                    );
                })}

                {/* Data */}
                {history.length >= 2 && (
                    <>
                        <path d={perclosArea} fill="url(#perclos-grad)" />
                        <path d={perclosPath} fill="none" stroke="var(--warning)" strokeWidth="1.5" opacity="0.7" />
                        <path d={earPath} fill="none" stroke="var(--primary)" strokeWidth="2" />

                        {/* Warning thresholds */}
                        <line
                            x1={PAD.left} x2={W - PAD.right}
                            y1={PAD.top + plotH - (earWarnLevel / EAR_MAX) * plotH}
                            y2={PAD.top + plotH - (earWarnLevel / EAR_MAX) * plotH}
                            stroke="var(--alarm)" strokeWidth="1" strokeDasharray="4 4" opacity="0.4"
                        />
                    </>
                )}

                {/* Baseline */}
                <line x1={PAD.left} x2={W - PAD.right} y1={baseline} y2={baseline} stroke="var(--border-default)" strokeWidth="1" />

                {/* Empty state */}
                {history.length < 2 && (
                    <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="11" fill="var(--text-faint)">
                        Aguardando dados…
                    </text>
                )}

                {/* X-axis labels */}
                {[0, 15, 30, 45, 60].map((s) => {
                    const x = PAD.left + (s / 60) * plotW;
                    return (
                        <text key={s} x={x} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--text-faint)">
                            {s === 60 ? 'agora' : `-${60 - s}s`}
                        </text>
                    );
                })}
            </svg>
        </div>
    );
};
