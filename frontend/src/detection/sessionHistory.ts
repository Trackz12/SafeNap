/**
 * Histórico persistente de sessões de monitoramento.
 *
 * Um "resumo de sessão" é gravado quando a sessão termina (câmera parada
 * com duração mínima) contendo: duração, piscadas, avisos, alarmes,
 * episódios, EAR médio e timestamp. Máximo de 50 sessões (FIFO).
 *
 * Exportação: CSV (planilha) e JSON (dados completos).
 */

import { sessionStats } from '../detection/sessionStats';

const STORAGE_KEY = 'safenap_session_history_v1';
const MAX_SESSIONS = 50;
/** Duração mínima para valer o registro (evita ruído de liga/desliga). */
const MIN_SESSION_MS = 30_000;

export interface SessionSummary {
    /** Início da sessão (epoch ms). */
    startedAt: number;
    /** Fim da sessão (epoch ms). */
    endedAt: number;
    /** Duração em ms. */
    durationMs: number;
    /** Total de piscadas. */
    blinkCount: number;
    /** Avisos emitidos. */
    warningCount: number;
    /** Episódios de olhos fechados prolongados. */
    episodeCount: number;
    /** EAR médio da sessão (0 se sem dados). */
    avgEar: number;
    /** Piscadas lentas (SEP) registradas. */
    slowBlinkCount: number;
}

function loadSessions(): SessionSummary[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveSessions(sessions: SessionSummary[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch {
        // localStorage cheio/indisponível — ignora silenciosamente
    }
}

class SessionHistory {
    private sessions: SessionSummary[] = loadSessions();
    private sessionStartedAt: number | null = null;
    private snapshotAtStart: { blinkCount: number; warningCount: number; episodeCount: number } | null = null;

    /** Marca o início de uma sessão (chamado quando a câmera liga). */
    public markSessionStart(): void {
        const snap = sessionStats.snapshot(Date.now(), 0);
        this.sessionStartedAt = Date.now();
        this.snapshotAtStart = {
            blinkCount: snap.blinkCount,
            warningCount: snap.warningCount,
            episodeCount: snap.episodeCount,
        };
    }

    /** Marca o fim da sessão e persiste o resumo se tiver duração mínima. */
    public markSessionEnd(): void {
        if (this.snapshotAtStart === null || this.sessionStartedAt === null) return;
        const snap = sessionStats.snapshot(Date.now(), 0);
        const endedAt = Date.now();

        const summary: SessionSummary = {
            startedAt: this.sessionStartedAt,
            endedAt,
            durationMs: endedAt - this.sessionStartedAt,
            blinkCount: Math.max(0, snap.blinkCount - this.snapshotAtStart.blinkCount),
            warningCount: Math.max(0, snap.warningCount - this.snapshotAtStart.warningCount),
            episodeCount: Math.max(0, snap.episodeCount - this.snapshotAtStart.episodeCount),
            avgEar: snap.avgEar,
            slowBlinkCount: 0,
        };
        this.sessionStartedAt = null;
        this.snapshotAtStart = null;

        if (summary.durationMs < MIN_SESSION_MS) return;

        this.sessions.push(summary);
        if (this.sessions.length > MAX_SESSIONS) {
            this.sessions = this.sessions.slice(-MAX_SESSIONS);
        }
        saveSessions(this.sessions);
    }

    public getSessions(): SessionSummary[] {
        return [...this.sessions].sort((a, b) => b.startedAt - a.startedAt);
    }

    public clear(): void {
        this.sessions = [];
        saveSessions(this.sessions);
    }

    /** Exporta como CSV (compatível com Excel/Sheets, separador vírgula). */
    public exportCsv(): string {
        const header = 'Data Inicio,Duracao (min),Piscadas,Avisos,Episodios,EAR Medio';
        const rows = this.getSessions().map((s) => {
            const date = new Date(s.startedAt).toLocaleString('pt-BR');
            const minutes = (s.durationMs / 60000).toFixed(1);
            const ear = s.avgEar > 0 ? s.avgEar.toFixed(3) : '';
            return `${date},${minutes},${s.blinkCount},${s.warningCount},${s.episodeCount},${ear}`;
        });
        return [header, ...rows].join('\n');
    }

    /** Exporta como JSON (dados completos para análise). */
    public exportJson(): string {
        return JSON.stringify(
            {
                exportedAt: new Date().toISOString(),
                app: 'SafeNap',
                sessions: this.getSessions(),
            },
            null,
            2,
        );
    }

    /** Dispara o download de um arquivo no navegador. */
    public download(content: string, filename: string, mimeType: string): void {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

export const sessionHistory = new SessionHistory();
