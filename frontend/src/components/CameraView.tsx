import React, { useEffect, useRef, useState } from 'react';
import { cameraManager } from '../camera/cameraManager';
import { mediaPipeManager } from '../vision/mediapipe';
import { cameraStatusStore } from '../camera/cameraStatusStore';
import { calibrationManager } from '../safety/calibrationManager';
import { drowsinessModel } from '../ml/drowsinessModel';
import { mlDataCollector } from '../ml/mlDataCollector';
import { Camera, CameraOff, User, EyeClosed, Meh, Frown } from 'lucide-react';
import { useMetrics } from '../detection/useMetrics';
import { EarBar } from './EarBar';
import { CalibrationWizard } from './CalibrationWizard';
import { ViewerModeOverlay } from './ViewerModeOverlay';
import { claimDetectorWithResponse, releaseDetector, onRemoteCalibrationRequested } from '../sync/multiDeviceSync';

export const CameraView: React.FC = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isActive, setIsActive] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isAiReady, setIsAiReady] = useState(false);
    const [aiError, setAiError] = useState(false);
    const [fps, setFps] = useState(0);
    const [showWizard, setShowWizard] = useState(false);
    const [claimNotice, setClaimNotice] = useState<string | null>(null);
    const metrics = useMetrics(200);

    useEffect(() => {
        const preloadAI = async () => {
            try {
                await mediaPipeManager.initialize();
                setIsAiReady(true);
                setAiError(false);
            } catch (e) {
                console.error("Erro ao pré-carregar IA:", e);
                setAiError(true);
            }
        };
        const preloadTimer = setTimeout(preloadAI, 1000);

        let frameCount = 0;
        let lastCount = performance.now();
        let rafHandle: number;
        const countLoop = (t: number) => {
            frameCount++;
            if (t - lastCount >= 1000) {
                setFps(Math.round((frameCount * 1000) / (t - lastCount)));
                frameCount = 0;
                lastCount = t;
            }
            rafHandle = requestAnimationFrame(countLoop);
        };
        rafHandle = requestAnimationFrame(countLoop);

        const handleVisibilityChange = () => {
            if (document.hidden && cameraManager.isCameraActive()) {
                cameraManager.stopCamera();
                mediaPipeManager.stopDetection();
                cameraStatusStore.setActive(false);
                calibrationManager.cancelCalibration();
                mlDataCollector.stop();
                setIsActive(false);
                setShowWizard(false);
                releaseDetector();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("pagehide", handleVisibilityChange);

        // Detector: atende pedidos de calibração vindos de viewers.
        const unsubRemoteCal = onRemoteCalibrationRequested((action) => {
            if (!cameraManager.isCameraActive()) return;
            if (action === 'start') {
                setShowWizard(true);
                calibrationManager.startCalibration();
            } else if (action === 'cancel') {
                calibrationManager.cancelCalibration();
            }
        });

            return () => {
                clearTimeout(preloadTimer);
                cancelAnimationFrame(rafHandle);
                unsubRemoteCal();
                document.removeEventListener("visibilitychange", handleVisibilityChange);
                window.removeEventListener("pagehide", handleVisibilityChange);
                if (cameraManager.isCameraActive()) {
                    cameraManager.stopCamera();
                    mediaPipeManager.stopDetection();
                }
                cameraStatusStore.setActive(false);
                calibrationManager.cancelCalibration();
                mlDataCollector.stop();
            };
    }, []);

    const toggleCamera = async () => {
        if (!videoRef.current) return;

        if (isActive) {
            cameraManager.stopCamera();
            mediaPipeManager.stopDetection();
            cameraStatusStore.setActive(false);
            calibrationManager.cancelCalibration();
            mlDataCollector.stop();
            setIsActive(false);
            setShowWizard(false);
            releaseDetector();
            return;
        }

        // Negocia o papel de detector antes de abrir a câmera: se outro
        // device já detém o papel, este device vira viewer (sem câmera).
        setClaimNotice(null);
        const role = await claimDetectorWithResponse();
        if (role === 'viewer') {
            setClaimNotice('Outro dispositivo já está monitorando. Este virou espectador (viewer).');
            return;
        }
        // role === 'detector' | 'standalone' prosseguem com a câmera.

        try {
            setIsLoading(true);
            await cameraManager.startCamera(videoRef.current);
            setIsActive(true);

            await new Promise((resolve) => setTimeout(resolve, 500));

            try {
                if (!isAiReady) {
                    await mediaPipeManager.initialize();
                    setIsAiReady(true);
                    setAiError(false);
                }
                mediaPipeManager.startDetection(videoRef.current);
                cameraStatusStore.setActive(true);
                mlDataCollector.start();
                drowsinessModel.initialize().catch(() => { });
                setShowWizard(true);
            } catch (aiErr: unknown) {
                console.warn("Erro ao iniciar modelo de IA MediaPipe:", aiErr);
                setAiError(true);
                setShowWizard(false);
            }
        } catch (err: unknown) {
            console.error("Falha ao iniciar câmera:", err);
            cameraManager.stopCamera();
            setIsActive(false);
            releaseDetector();
            alert((err as Error).message || "Erro ao iniciar a câmera.");
        } finally {
            setIsLoading(false);
        }
    };

    const startDisabled = isLoading || (!isAiReady && !aiError && !isActive);

    const eyeStatusIcon = metrics.eyesClosed
        ? <EyeClosed size={16} color="var(--alarm)" />
        : <User size={16} color={metrics.facePresent ? 'var(--primary)' : 'var(--text-muted)'} />;

    return (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Camera size={20} color="var(--primary)" /> Monitoramento
                </h2>
                <button
                    className={`btn ${isActive ? 'btn-danger' : 'btn-primary'}`}
                    onClick={toggleCamera}
                    disabled={startDisabled}
                    style={{ opacity: startDisabled ? 0.7 : 1 }}
                >
                    {isLoading ? 'Iniciando...' : isActive ? <><CameraOff size={18} /> Parar Câmera</> : aiError && !isAiReady ? 'Tentar novamente' : isAiReady ? <><Camera size={18} /> Iniciar Câmera</> : 'Carregando IA...'}
                </button>
            </div>

            <div className="camera-wrapper">
                <video ref={videoRef} className="camera-video" playsInline autoPlay muted />

                {isActive && (
                    <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)',
                        padding: '2rem 1rem 0.75rem 1rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                    }}>
                        <EarBar ear={metrics.ear} threshold={metrics.threshold} />
                    </div>
                )}

                <div className="camera-overlay">
                    <div className="badge" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div className="status-indicator" style={{ background: isActive ? (metrics.eyesClosed ? 'var(--alarm)' : 'var(--primary)') : 'var(--alarm)' }} />
                        {isActive ? (metrics.facePresent ? (metrics.eyesClosed ? 'Olhos fechados' : 'Monitorando') : 'Sem rosto') : 'Inativo'}
                    </div>
                    {isActive && (
                        <div className="badge" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {eyeStatusIcon}
                            {metrics.yawnActive && <Meh size={14} color="var(--warning)" />}
                            {metrics.headDropped && <Frown size={14} color="var(--warning)" />}
                            <span>{fps} FPS</span>
                        </div>
                    )}
                </div>

                {!isActive && !isLoading && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'var(--text-muted)' }}>
                        Câmera não iniciada
                    </div>
                )}
                {isLoading && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'var(--primary)', fontWeight: 'bold' }}>
                        Carregando IA...
                    </div>
                )}

                <CalibrationWizard visible={showWizard && isActive} onFinish={() => setShowWizard(false)} />
                <ViewerModeOverlay />
            </div>

            {isActive && aiError && !isAiReady && (
                <div style={{ color: 'var(--warning)', fontSize: '0.85rem', textAlign: 'center' }}>
                    Modelo de IA indisponível — apenas vídeo ativo, sem análise.
                </div>
            )}

            {claimNotice && (
                <div style={{
                    padding: '0.6rem 0.8rem', borderRadius: 8,
                    background: 'rgba(250,204,21,0.12)', border: '1px solid rgba(250,204,21,0.35)',
                    fontSize: '0.85rem', color: 'var(--warning)', textAlign: 'center',
                }}>
                    {claimNotice} — os dados ao vivo continuam visíveis no painel.
                </div>
            )}
        </div>
    );
};
