import React, { useEffect, useState } from 'react';
import { safetyEngine, type SafetySnapshot } from '../safety/safetyEngine';
import { wsClient, type ConnectionStatus, EventType } from '../websocket/socketClient';
import { Activity, ShieldAlert, ShieldCheck, Wifi, WifiOff, Eye, Meh, ArrowDown, UserX } from 'lucide-react';

const REASON_LABELS: Record<string, string> = {
    EYES_CLOSED_DURATION: 'Olhos fechados por tempo prolongado',
    PERCLOS_CRITICAL: 'PERCLOS crítico (olhos fechados com frequência)',
    PERCLOS: 'PERCLOS elevado',
    YAWN: 'Bocejo detectado',
    HEAD_DROP: 'Cabeça abaixando',
    FACE_LOST: 'Rosto fora do enquadramento',
    PROLONGED_CLOSE: 'Olhos fechados acima do normal',
    ML_WARNING: 'Modelo ML: alto risco de fadiga',
    ML_ALARM: 'Modelo ML: sonolência confirmada',
};

export const StatusDashboard: React.FC = () => {
    const [safety, setSafety] = useState<SafetySnapshot>(safetyEngine.getSnapshot());
    const [wsStatus, setWsStatus] = useState<ConnectionStatus>("DISCONNECTED");
    const [hardwareConnected, setHardwareConnected] = useState<boolean>(false);

    useEffect(() => {
        const unsub = safetyEngine.onStateChange((snapshot) => {
            setSafety(snapshot);
        });

        const handleStatus = (status: unknown) => {
            setWsStatus(status as ConnectionStatus);
        };
        wsClient.on('status', handleStatus);
        setWsStatus(wsClient.status);

        const handleHardwareStatus = (payload: unknown) => {
            const p = payload as { connected?: unknown } | undefined;
            if (p && typeof p.connected === 'boolean') {
                setHardwareConnected(p.connected);
            }
        };

        wsClient.on(EventType.HARDWARE_STATUS, handleHardwareStatus);
        // A conexão é gerenciada globalmente (main.tsx); aqui apenas garantimos.
        wsClient.connect();

        return () => {
            unsub();
            wsClient.off('status', handleStatus);
            wsClient.off(EventType.HARDWARE_STATUS, handleHardwareStatus);
        };
    }, []);

    const getStatusColor = () => {
        if (safety.state === "ALARM") return "var(--alarm)";
        if (safety.state === "WARNING") return "var(--warning)";
        return "var(--primary)";
    };

    const getStatusText = () => {
        if (safety.state === "ALARM") return "PERIGO: SONOLÊNCIA DETECTADA!";
        if (safety.state === "WARNING") return "ATENÇÃO: SINAIS DE FADIGA";
        return "SISTEMA NORMAL";
    };

    const statusIcon = () => {
        const color = getStatusColor();
        if (!safety.reason) return <ShieldCheck size={32} color={color} />;
        if (safety.reason === 'YAWN') return <Meh size={32} color={color} />;
        if (safety.reason === 'HEAD_DROP') return <ArrowDown size={32} color={color} />;
        if (safety.reason === 'FACE_LOST') return <UserX size={32} color={color} />;
        if (safety.reason === 'PERCLOS' || safety.reason === 'PERCLOS_CRITICAL' || safety.reason === 'EYES_CLOSED_DURATION' || safety.reason === 'PROLONGED_CLOSE') {
            return <Eye size={32} color={color} />;
        }
        return <ShieldAlert size={32} color={color} />;
    };

    return (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2>Status do Sistema</h2>

            <div className="metric-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem', border: `1px solid ${getStatusColor()}` }}>
                {statusIcon()}
                <div>
                    <h3>Estado de Segurança</h3>
                    <div className="metric-value" style={{ color: getStatusColor() }}>
                        {getStatusText()}
                    </div>
                    {safety.reason && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.3rem' }}>
                            Motivo: {REASON_LABELS[safety.reason] ?? safety.reason}
                        </div>
                    )}
                </div>
            </div>

            <div className="metric-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                {wsStatus === "CONNECTED" ? <Wifi size={24} color="var(--primary)"/> : <WifiOff size={24} color="var(--text-muted)"/>}
                <div>
                    <h3>Conexão com Backend</h3>
                    <div className="metric-value" style={{ fontSize: '1.2rem', color: wsStatus === "CONNECTED" ? 'var(--primary)' : 'var(--text-muted)' }}>
                        {wsStatus}
                    </div>
                </div>
            </div>

            <div className="metric-card" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                {hardwareConnected ? <Activity size={24} color="var(--primary)"/> : <WifiOff size={24} color="var(--text-muted)"/>}
                <div>
                    <h3>Conexão com Arduino</h3>
                    <div className="metric-value" style={{ fontSize: '1.2rem', color: hardwareConnected ? "var(--primary)" : 'var(--text-muted)' }}>
                        {hardwareConnected ? "CONECTADO" : "DESCONECTADO"}
                    </div>
                </div>
            </div>
        </div>
    );
};
