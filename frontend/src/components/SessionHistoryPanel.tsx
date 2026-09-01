import React, { useState } from 'react';
import { History, Download, FileJson, Trash2 } from 'lucide-react';
import { sessionHistory, type SessionSummary } from '../detection/sessionHistory';

function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    return `${m}min`;
}

export const SessionHistoryPanel: React.FC = () => {
    const [sessions, setSessions] = useState<SessionSummary[]>(sessionHistory.getSessions());
    const [expanded, setExpanded] = useState(false);

    const refresh = () => setSessions(sessionHistory.getSessions());

    const exportCsv = () => {
        const csv = sessionHistory.exportCsv();
        const date = new Date().toISOString().slice(0, 10);
        sessionHistory.download(csv, `safenap-sessoes-${date}.csv`, 'text/csv;charset=utf-8');
    };

    const exportJson = () => {
        const json = sessionHistory.exportJson();
        const date = new Date().toISOString().slice(0, 10);
        sessionHistory.download(json, `safenap-sessoes-${date}.json`, 'application/json');
    };

    const clearHistory = () => {
        sessionHistory.clear();
        refresh();
    };

    if (sessions.length === 0 && !expanded) {
        return (
            <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
                <div className="glass-panel-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <History size={14} color="var(--text-muted)" />
                        <span className="glass-panel-title">Histórico</span>
                    </div>
                </div>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)', margin: 0 }}>
                    Nenhuma sessão registrada ainda. Sessões com mais de 30s de monitoramento aparecem aqui.
                </p>
            </div>
        );
    }

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            <div className="glass-panel-header" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <History size={14} color="var(--text-muted)" />
                    <span className="glass-panel-title">Histórico</span>
                    <span className="badge badge-muted">{sessions.length}</span>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <button className="btn" onClick={exportCsv} aria-label="Exportar CSV" title="Exportar CSV">
                        <Download size={14} />
                    </button>
                    <button className="btn" onClick={exportJson} aria-label="Exportar JSON" title="Exportar JSON">
                        <FileJson size={14} />
                    </button>
                    <button className="btn" onClick={clearHistory} aria-label="Limpar histórico" title="Limpar histórico">
                        <Trash2 size={14} />
                    </button>
                </div>
            </div>

            {/* Últimas 3 sessões por padrão; expandir mostra todas */}
            {(expanded ? sessions : sessions.slice(0, 3)).map((s) => (
                <div
                    key={s.startedAt}
                    className="metric-card"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' }}
                >
                    <div>
                        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                            {new Date(s.startedAt).toLocaleDateString('pt-BR')}
                        </div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            {new Date(s.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                            {' · '}
                            {formatDuration(s.durationMs)}
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        <span title="Piscadas">👁 {s.blinkCount}</span>
                        <span title="Avisos" style={{ color: s.warningCount > 0 ? 'var(--warning)' : undefined }}>
                            ⚠ {s.warningCount}
                        </span>
                        <span title="Episódios de olhos fechados" style={{ color: s.episodeCount > 0 ? 'var(--alarm)' : undefined }}>
                            ● {s.episodeCount}
                        </span>
                    </div>
                </div>
            ))}

            {sessions.length > 3 && (
                <button className="btn" onClick={() => setExpanded(!expanded)} style={{ width: '100%', fontSize: 'var(--text-xs)' }}>
                    {expanded ? 'Mostrar menos' : `Ver todas (${sessions.length})`}
                </button>
            )}
        </div>
    );
};
