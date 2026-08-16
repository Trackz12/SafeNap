import React, { useEffect, useRef, useState } from 'react';
import { sessionStats, type HistoryPoint } from '../detection/sessionStats';

const WINDOW_MS = 60000;
const W = 600;
const H = 160;
const PAD = { top: 10, right: 8, bottom: 18, left: 30 };

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
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    const now = Date.now();
    const history = sessionStats.getHistory().filter((p) => p.t >= now - WINDOW_MS);

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const baseline = PAD.top + plotH;

    const yScale = [0, 0.15, 0.3, 0.45];
    const perclosWarnLevel = 0.15;
    const earWarnLevel = 0.2;

    const earPath = buildPath(history, 'ear', now);
    const perclosPath = buildPath(history, 'perclos', now);
    const perclosArea = buildArea(history, 'perclos', now);

    return (
        <div className="glass-panel" style={{ padding: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <h3 style={{ margin: 0, fontSize: '1rem' }}>Últimos 60 segundos</h3>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span style={{ width: 18, height: 3, background: 'var(--primary)', display: 'inline-block', borderRadius: 2 }} />
                        EAR
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span style={{ width: 18, height: 3, background: 'var(--warning)', display: 'inline-block', borderRadius: 2 }} />
                        PERCLOS
                    </span>
                </div>
            </div>

            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
                {yScale.map((v) => {
                    const y = PAD.top + plotH - (v / EAR_MAX) * plotH;
                    return (
                        <g key={v}>
                            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                            <text x={PAD.left - 5} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text-muted)">{v.toFixed(2)}</text>
                        </g>
                    );
                })}

                {history.length >= 2 && (
                    <>
                        <path d={perclosArea} fill="rgba(250,204,21,0.08)" />
                        <path d={perclosPath} fill="none" stroke="var(--warning)" strokeWidth="1.5" opacity="0.9" />
                        <path d={earPath} fill="none" stroke="var(--primary)" strokeWidth="2" />
                        <line
                            x1={PAD.left} x2={W - PAD.right}
                            y1={PAD.top + plotH - (earWarnLevel / EAR_MAX) * plotH}
                            y2={PAD.top + plotH - (earWarnLevel / EAR_MAX) * plotH}
                            stroke="var(--alarm)" strokeWidth="1" strokeDasharray="4 4" opacity="0.5"
                        />
                        <line
                            x1={PAD.left} x2={W - PAD.right}
                            y1={PAD.top + plotH - ((perclosWarnLevel * EAR_MAX) / EAR_MAX) * plotH}
                            y2={PAD.top + plotH - ((perclosWarnLevel * EAR_MAX) / EAR_MAX) * plotH}
                            stroke="var(--alarm)" strokeWidth="1" strokeDasharray="4 4" opacity="0.3"
                        />
                    </>
                )}

                <line x1={PAD.left} x2={W - PAD.right} y1={baseline} y2={baseline} stroke="rgba(255,255,255,0.2)" strokeWidth="1" />

                {history.length < 2 && (
                    <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                        Aguardando dados do monitoramento...
                    </text>
                )}

                {[0, 15, 30, 45, 60].map((s) => {
                    const x = PAD.left + (s / 60) * plotW;
                    return (
                        <text key={s} x={x} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--text-muted)">
                            {s === 60 ? 'agora' : `-${60 - s}s`}
                        </text>
                    );
                })}
            </svg>
        </div>
    );
};
