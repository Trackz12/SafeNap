import React, { useState } from 'react';
import { Settings, Vibrate, Volume2, VolumeX, Link, Loader2 } from 'lucide-react';
import { getApiUrl } from '../config/api';

export const Controls: React.FC = () => {
    const [port, setPort] = useState('');
    const [connecting, setConnecting] = useState(false);
    const [hwStatus, setHwStatus] = useState<string | null>(null);
    const apiUrl = getApiUrl();

    const testHardware = async (command: string) => {
        setHwStatus(`Enviando ${command}…`);
        try {
            const res = await fetch(`${apiUrl}/hardware/test/${command}`, { method: 'POST' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setHwStatus(`${command} enviado`);
            setTimeout(() => setHwStatus(null), 2000);
        } catch (e) {
            console.error('Erro ao testar hardware', e);
            setHwStatus(`Erro ao enviar ${command}`);
            setTimeout(() => setHwStatus(null), 3000);
        }
    };

    const connectArduino = async () => {
        setConnecting(true);
        try {
            const res = await fetch(`${apiUrl}/hardware/connect${port ? `?port=${port}` : ''}`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Arduino conectado com sucesso!');
            } else {
                alert(`Falha ao conectar no Arduino: ${data.error || 'desconhecido'}`);
            }
        } catch (e) {
            console.error('Erro ao conectar', e);
            alert(`Erro de conexão: ${e instanceof Error ? e.message : 'verifique se o backend está rodando'}`);
        } finally {
            setConnecting(false);
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
                <label className="metric-label" htmlFor="arduino-port" style={{ marginBottom: 'var(--space-2)', display: 'block' }}>
                    Conexão Arduino
                </label>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input
                        id="arduino-port"
                        type="text"
                        className="input"
                        placeholder="COM3 (opcional)"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        aria-label="Porta serial do Arduino"
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <button className="btn" onClick={connectArduino} disabled={connecting} aria-label="Conectar Arduino">
                        {connecting ? <Loader2 size={14} className="spin" /> : <Link size={14} />} {connecting ? 'Conectando…' : 'Conectar'}
                    </button>
                </div>
            </div>

            <div className="divider" />

            {/* Hardware tests */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 'var(--space-2)' }}>
                <button className="btn" onClick={() => testHardware('ALARM')} aria-label="Testar alarme sonoro" style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}>
                    <Volume2 size={14} /> Alarme
                </button>
                <button className="btn" onClick={() => testHardware('VIBRATION')} aria-label="Testar vibração" style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}>
                    <Vibrate size={14} /> Vibração
                </button>
                <button className="btn" onClick={() => testHardware('OFF')} aria-label="Desligar alerta" style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}>
                    <VolumeX size={14} /> Desligar
                </button>
            </div>
            {hwStatus && (
                <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'center' }}>
                    {hwStatus}
                </div>
            )}
        </div>
    );
};
