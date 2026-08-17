import React, { useEffect, useState } from 'react';
import { safetyEngine, type SafetySnapshot } from '../safety/safetyEngine';
import { wsClient, type ConnectionStatus } from '../websocket/socketClient';
import { ShieldCheck, ShieldAlert, Wifi, WifiOff } from 'lucide-react';

const STATE_STYLE: Record<string, { badge: string; icon: React.ReactNode }> = {
    NORMAL:  { badge: 'badge-green',  icon: <ShieldCheck size={12} /> },
    WARNING: { badge: 'badge-yellow', icon: <ShieldAlert size={12} /> },
    ALARM:   { badge: 'badge-red',    icon: <ShieldAlert size={12} /> },
};

export const StatusDashboard: React.FC = () => {
    const [safety, setSafety] = useState<SafetySnapshot>({ state: 'NORMAL', reason: null });
    const [wsStatus, setWsStatus] = useState<ConnectionStatus>('DISCONNECTED');

    useEffect(() => {
        const unsubSafety = safetyEngine.onStateChange((s) => setSafety(s));
        const handleWs = (status: unknown) => setWsStatus(status as ConnectionStatus);
        wsClient.on('status', handleWs);
        setWsStatus(wsClient.status);
        return () => {
            unsubSafety();
            wsClient.off('status', handleWs);
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
        </div>
    );
};
