import React, { useState } from 'react';
import { Settings, Vibrate, Volume2, VolumeX, Link } from 'lucide-react';
import { getApiUrl } from '../config/api';

export const Controls: React.FC = () => {
    const [port, setPort] = useState('');
    const apiUrl = getApiUrl();

    const testHardware = async (command: string) => {
        try {
            await fetch(`${apiUrl}/hardware/test/${command}`, { method: 'POST' });
        } catch (e) {
            console.error('Erro ao testar hardware', e);
        }
    };

    const connectArduino = async () => {
        try {
            const res = await fetch(`${apiUrl}/hardware/connect${port ? `?port=${port}` : ''}`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Arduino conectado com sucesso!');
            } else {
                alert('Falha ao conectar no Arduino.');
            }
        } catch (e) {
            console.error('Erro ao conectar', e);
        }
    };

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            <div className="glass-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <Settings size={14} color="var(--text-muted)" />
                    <span className="glass-panel-title">Controles</span>
                </div>
            </div>

            {/* Arduino connection */}
            <div style={{ marginBottom: 'var(--space-3)' }}>
                <div className="metric-label" style={{ marginBottom: 'var(--space-2)' }}>Conexão Arduino</div>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input
                        type="text"
                        className="input"
                        placeholder="COM3 (opcional)"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <button className="btn" onClick={connectArduino}>
                        <Link size={14} /> Conectar
                    </button>
                </div>
            </div>

            <div className="divider" />

            {/* Hardware tests */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-2)' }}>
                <button className="btn" onClick={() => testHardware('ALARM')} style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}>
                    <Volume2 size={14} /> Alarme
                </button>
                <button className="btn" onClick={() => testHardware('VIBRATION')} style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}>
                    <Vibrate size={14} /> Vibração
                </button>
                <button className="btn" onClick={() => testHardware('OFF')} style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}>
                    <VolumeX size={14} /> Desligar
                </button>
            </div>
        </div>
    );
};
