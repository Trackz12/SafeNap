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
            background: 'rgba(9,9,11,0.94)',
            backdropFilter: 'blur(var(--blur-md))',
            WebkitBackdropFilter: 'blur(var(--blur-md))',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 'var(--space-3)', padding: 'var(--space-4)', textAlign: 'center',
        }}>
            {!showWizard && !progress.isCalibrating && (
                <>
                    <MonitorSmartphone size={40} color="var(--primary)" />
                    <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>
                        {remoteOwner ? 'Espelhando outro dispositivo' : 'Outro dispositivo já monitora'}
                    </h3>
                    <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', maxWidth: 320, lineHeight: 1.5 }}>
                        {remoteOwner
                            ? 'A câmera roda no dispositivo detector. Painel, alertas, calibração e dados de sessão são compartilhados em tempo real.'
                            : 'A vaga de detector está ocupada. Você vê os mesmos dados ao vivo.'}
                    </p>
                    {remoteOwner && (
                        <button
                            className="btn"
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
