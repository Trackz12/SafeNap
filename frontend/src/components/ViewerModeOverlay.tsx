import React, { useEffect, useState } from 'react';
import { roleStore, type DeviceRole } from '../sync/roleStore';
import { calibrationProgress } from '../sync/calibrationProgress';
import { wsClient } from '../websocket/socketClient';
import { Camera, MonitorSmartphone } from 'lucide-react';
import { CalibrationWizard } from './CalibrationWizard';

/**
 * Overlay exibido sobre a área da câmera quando este dispositivo é VIEWER
 * (outro device detém o papel de detector e processa as imagens).
 * Não abre câmera: apenas informa o papel, permite pedir calibração remota
 * (com o mesmo wizard guiado, em modo remoto) e acompanha o progresso ao vivo.
 */
export const ViewerModeOverlay: React.FC = () => {
    const [role, setRole] = useState<DeviceRole>(roleStore.getRole());
    const [detectorOwner, setDetectorOwner] = useState<string | null>(roleStore.getDetectorOwner());
    const [progress, setProgress] = useState(calibrationProgress.get());
    const [showWizard, setShowWizard] = useState(false);

    useEffect(() => {
        const unsubRole = roleStore.subscribe(() => {
            setRole(roleStore.getRole());
            setDetectorOwner(roleStore.getDetectorOwner());
        });
        const unsubProgress = calibrationProgress.subscribe(() => {
            const p = calibrationProgress.get();
            setProgress(p);
            if (p.isCalibrating) setShowWizard(true);
        });
        return () => { unsubRole(); unsubProgress(); };
    }, []);

    // Se o papel deixar de ser viewer, fecha o wizard local (efeito, não render-phase).
    useEffect(() => {
        if (role !== 'viewer') setShowWizard(false);
    }, [role]);

    if (role !== 'viewer') return null;

    const selfId = wsClient.getSessionId();
    const remoteOwner = detectorOwner && detectorOwner !== selfId;

    return (
        <div style={{
            position: 'absolute', inset: 0, zIndex: 40,
            background: 'rgba(10,12,16,0.92)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.8rem', padding: '1rem', textAlign: 'center', borderRadius: 12,
        }}>
            {!showWizard && !progress.isCalibrating && (
                <>
                    <MonitorSmartphone size={40} color="var(--primary)" />
                    <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
                        {remoteOwner ? 'Espelhando outro dispositivo' : 'Outro dispositivo já monitora'}
                    </h3>
                    <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)', maxWidth: 320 }}>
                        {remoteOwner
                            ? 'A câmera roda no dispositivo detector. Painel, alertas, calibração e dados de sessão são compartilhados em tempo real.'
                            : 'A vaga de detector está ocupada. Você vê os mesmos dados ao vivo.'}
                    </p>
                    {remoteOwner && (
                        <button
                            className="btn btn-secondary"
                            onClick={() => setShowWizard(true)}
                            style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                        >
                            <Camera size={16} /> Pedir calibração ao detector
                        </button>
                    )}
                </>
            )}

            {showWizard && (
                <CalibrationWizard
                    visible
                    mode="remote"
                    onFinish={() => setShowWizard(false)}
                />
            )}
        </div>
    );
};
