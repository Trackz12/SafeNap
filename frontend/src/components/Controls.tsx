import React, { useState } from 'react';
import { Settings, Vibrate, Volume2, VolumeX, Link } from 'lucide-react';
import { getApiUrl } from '../config/api';

export const Controls: React.FC = () => {
    const [port, setPort] = useState<string>("");
    const apiUrl = getApiUrl();

    const testHardware = async (command: string) => {
        try {
            await fetch(`${apiUrl}/hardware/test/${command}`, { method: 'POST' });
        } catch (e) {
            console.error("Erro ao testar hardware", e);
        }
    };

    const connectArduino = async () => {
        try {
            const res = await fetch(`${apiUrl}/hardware/connect${port ? `?port=${port}` : ''}`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert("Arduino conectado com sucesso!");
            } else {
                alert("Falha ao conectar no Arduino.");
            }
        } catch (e) {
            console.error("Erro ao conectar", e);
        }
    };

    return (
        <div className="glass-panel">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Settings size={20} /> Controles Manuais
            </h2>

            <div className="metric-card">
                <h3>Conexão Arduino</h3>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                    <input 
                        type="text" 
                        placeholder="Ex: COM3 (opcional)" 
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        style={{ padding: '0.5rem', borderRadius: '4px', border: 'none', flex: '1 1 150px' }}
                    />
                    <button className="btn btn-secondary" onClick={connectArduino} style={{ flex: '1 1 auto' }}>
                        <Link size={16} /> Conectar
                    </button>
                </div>
            </div>

            <div className="controls-grid">
                <button className="btn btn-secondary" onClick={() => testHardware("ALARM")}>
                    <Volume2 size={16} /> Testar Alarme
                </button>
                <button className="btn btn-secondary" onClick={() => testHardware("VIBRATION")}>
                    <Vibrate size={16} /> Testar Vibração
                </button>
                <button className="btn btn-secondary" onClick={() => testHardware("OFF")}>
                    <VolumeX size={16} /> Desligar Alerta
                </button>
            </div>
        </div>
    );
};
