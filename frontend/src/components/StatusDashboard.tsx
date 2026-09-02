import React, { useEffect, useState } from 'react';
import { safetyEngine, type SafetySnapshot } from '../safety/safetyEngine';
import { wsClient, type ConnectionStatus, EventType } from '../websocket/socketClient';
import { ShieldCheck, ShieldAlert, Wifi, WifiOff, Usb, ZapOff } from 'lucide-react';

const STATE_STYLE: Record<string, { badge: string; icon: React.ReactNode }> = {
    NORMAL:  { badge: 'badge-green',  icon: <ShieldCheck size={12} /> },
    WARNING: { badge: 'badge-yellow', icon: <ShieldAlert size={12} /> },
    ALARM:   { badge: 'badge-red',    icon: <ShieldAlert size={12} /> },
};

interface HardwareHealth {
    connected: boolean;
    responsive: boolean;
}

export const StatusDashboard: React.FC = () => {
    const [safety, setSafety] = useState<SafetySnapshot>({ state: 'NORMAL', reason: null });
    const [wsStatus, setWsStatus] = useState<ConnectionStatus>('DISCONNECTED');
    const [hardware, setHardware] = useState<HardwareHealth | null>(null);

    useEffect(() => {
        const unsubSafety = safetyEngine.onStateChange((s) => setSafety(s));
        const handleWs = (status: unknown) => setWsStatus(status as ConnectionStatus);
        wsClient.on('status', handleWs);
        setWsStatus(wsClient.status);

        // Saude do Arduino (conectado + respondendo aos pings do backend)
        const handleHardware = (payload: unknown) => {
            const p = payload as { connected?: unknown; responsive?: unknown } | undefined;
            if (p && typeof p.connected === 'boolean') {
                setHardware({
                    connected: p.connected,
                    responsive: typeof p.responsive === 'boolean' ? p.responsive : true,
                });
            }
        };
        wsClient.on(EventType.HARDWARE_STATUS, handleHardware);

        return () => {
            unsubSafety();
            wsClient.off('status', handleWs);
            wsClient.off(EventType.HARDWARE_STATUS, handleHardware);
        };
    }, []);

    const cfg = STATE_STYLE[safety.state] || STATE_STYLE.NORMAL;
    const stateLabel: Record<string, string> = { NORMAL: 'Normal', WARNING: 'Atenção', ALARM: 'Perigo' };

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span className={`badge ${cfg.badge}`}>
                {cfg.icon}
                {stateLabel[safety.state]}
            </span>

            <span className={`badge ${wsStatus === 'CONNECTED' ? 'badge-green' : 'badge-muted'}`}>
                {wsStatus === 'CONNECTED'
                    ? <><Wifi size={12} /> Online</>
                    : <><WifiOff size={12} /> Offline</>
                }
            </span>

            {hardware && (
                <span
                    className={`badge ${hardware.connected && hardware.responsive ? 'badge-green' : hardware.connected ? 'badge-yellow' : 'badge-muted'}`}
                    title={hardware.connected
                        ? hardware.responsive
                            ? 'Arduino conectado e respondendo'
                            : 'Arduino conectado mas sem responder (travado?)'
                        : 'Arduino desconectado'}
                >
                    {hardware.connected
                        ? (hardware.responsive
                            ? <><Usb size={12} /> Arduino</>
                            : <><ZapOff size={12} /> Travado</>)
                        : <><ZapOff size={12} /> Arduino</>
                    }
                </span>
            )}
        </div>
    );
};
