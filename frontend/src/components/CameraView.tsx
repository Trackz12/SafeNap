import React, { useEffect, useRef, useState, useCallback } from 'react';
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
    const [pauseNotice, setPauseNotice] = useState<string | null>(null);
    const metrics = useMetrics(200);

    // Ref que espelha o estado atual das métricas — usada dentro de effects
    // com deps vazias (o handler de visibilidade precisa do estado mais recente).
    const metricsRef = useRef(metrics);
    useEffect(() => { metricsRef.current = metrics; }, [metrics]);

    /** Ref para rastrear se o componente está montado (guard contra race conditions). */
    const mountedRef = useRef(true);
    /** Ref para rastrear se uma operação de toggle está em progresso. */
    const togglingRef = useRef(false);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // Pré-carregamento da IA (uma única vez)
    useEffect(() => {
        const preloadAI = async () => {
            try {
                await mediaPipeManager.initialize();
                if (mountedRef.current) {
                    setIsAiReady(true);
                    setAiError(false);
                }
            } catch (e) {
                console.error("Erro ao pré-carregar IA:", e);
                if (mountedRef.current) setAiError(true);
            }
        };
        const preloadTimer = setTimeout(preloadAI, 1000);

        const handleVisibilityChange = () => {
            if (document.hidden && cameraManager.isCameraActive()) {
                // Se havia um alarme ativo quando o app ficou em segundo plano,
                // avisa claramente que o monitoramento foi interrompido — um
                // motorista sonolento nao deve ficar sem alerta silenciosamente.
                const wasAlarm = metricsRef.current.state === 'ALARM' || metricsRef.current.state === 'WARNING';
                cameraManager.stopCamera();
                mediaPipeManager.stopDetection();
                cameraStatusStore.setActive(false);
                calibrationManager.cancelCalibration();
                mlDataCollector.stop();
                setIsActive(false);
                setShowWizard(false);
                releaseDetector();
                if (wasAlarm) {
                    setPauseNotice('Monitoramento pausado enquanto a tela esteve oculta (alerta ativo). Reabra o app e reative a câmera.');
                } else {
                    setPauseNotice('Monitoramento pausado enquanto a tela esteve oculta.');
                }
            }
        };

        const handlePageHide = () => {
            handleVisibilityChange();
            // Libera WASM do MediaPipe no unload real da página
            mediaPipeManager.releaseModel();
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("pagehide", handlePageHide);

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
            mountedRef.current = false;
            clearTimeout(preloadTimer);
            unsubRemoteCal();
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            window.removeEventListener("pagehide", handlePageHide);
            if (cameraManager.isCameraActive()) {
                cameraManager.stopCamera();
                mediaPipeManager.stopDetection();
            }
            cameraStatusStore.setActive(false);
            calibrationManager.cancelCalibration();
            mlDataCollector.stop();
            // NÃO chamar releaseModel() aqui — o singleton precisa sobreviver
            // entre re-renders do React. A liberação do WASM acontece no pagehide.
        };
    }, []);

    // FPS counter — só roda quando a câmera está ativa
    useEffect(() => {
        if (!isActive) {
            setFps(0);
            return;
        }

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
        return () => cancelAnimationFrame(rafHandle);
    }, [isActive]);

    const toggleCamera = useCallback(async () => {
        if (!videoRef.current) return;

        // Guard contra duplo-clique / race condition
        if (togglingRef.current) return;
        togglingRef.current = true;

        try {
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

            setClaimNotice(null);
            const role = await claimDetectorWithResponse();
            if (!mountedRef.current) return;
            if (role === 'viewer') {
                setClaimNotice('Outro dispositivo já está monitorando. Este virou espectador.');
                return;
            }

            setIsLoading(true);
            await cameraManager.startCamera(videoRef.current);
            if (!mountedRef.current) {
                cameraManager.stopCamera();
                return;
            }
            setIsActive(true);

            await new Promise((resolve) => setTimeout(resolve, 500));
            if (!mountedRef.current) {
                cameraManager.stopCamera();
                return;
            }

            try {
                if (!isAiReady) {
                    await mediaPipeManager.initialize();
                    if (mountedRef.current) {
                        setIsAiReady(true);
                        setAiError(false);
                    }
                }
                mediaPipeManager.startDetection(videoRef.current);
                cameraStatusStore.setActive(true);
                mlDataCollector.start();
                drowsinessModel.initialize().catch(() => { });
                setShowWizard(true);
            } catch (aiErr: unknown) {
                console.warn("Erro ao iniciar modelo de IA MediaPipe:", aiErr);
                if (mountedRef.current) {
                    setAiError(true);
                    setShowWizard(false);
                }
            }
        } catch (err: unknown) {
            console.error("Falha ao iniciar câmera:", err);
            cameraManager.stopCamera();
            if (mountedRef.current) setIsActive(false);
            releaseDetector();
            alert((err as Error).message || "Erro ao iniciar a câmera.");
        } finally {
            if (mountedRef.current) setIsLoading(false);
            togglingRef.current = false;
        }
    }, [isActive, isAiReady]);

    const startDisabled = isLoading || (!isAiReady && !aiError && !isActive);

    /* Status badge */
    const statusColor = isActive
        ? (metrics.eyesClosed ? 'var(--alarm)' : 'var(--primary)')
        : 'var(--text-faint)';
    const statusLabel = isActive
        ? (metrics.facePresent
            ? (metrics.eyesClosed ? 'Olhos fechados' : 'Monitorando')
            : 'Sem rosto')
        : 'Inativo';
    const statusBadge = isActive
        ? (metrics.eyesClosed ? 'badge-red' : 'badge-green')
        : 'badge-muted';

    return (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 0, overflow: 'hidden' }}>
            {/* Header bar */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '1px solid var(--border-subtle)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <Camera size={16} color="var(--primary)" />
                    <span className="glass-panel-title">Monitoramento</span>
                </div>
                <button
                    className={`btn ${isActive ? 'btn-danger' : 'btn-primary'}`}
                    onClick={toggleCamera}
                    disabled={startDisabled}
                    style={{ fontSize: 'var(--text-xs)' }}
                >
                    {isLoading
                        ? 'Iniciando…'
                        : isActive
                            ? <><CameraOff size={14} /> Parar</>
                            : aiError && !isAiReady
                                ? 'Tentar novamente'
                                : isAiReady
                                    ? <><Camera size={14} /> Iniciar</>
                                    : 'Carregando IA…'
                    }
                </button>
            </div>

            {/* Video area */}
            <div className="camera-wrapper" style={{ borderRadius: 0 }}>
                <video ref={videoRef} className="camera-video" playsInline autoPlay muted />

                {/* Bottom gradient + EAR bar */}
                {isActive && (
                    <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        background: 'linear-gradient(to top, rgba(0,0,0,0.9), transparent)',
                        padding: 'var(--space-8) var(--space-3) var(--space-3) var(--space-3)',
                    }}>
                        <EarBar ear={metrics.ear} threshold={metrics.threshold} />
                    </div>
                )}

                {/* Top overlay badges */}
                <div className="camera-overlay">
                    <span className={`badge ${statusBadge}`}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
                        {statusLabel}
                    </span>
                    {isActive && (
                        <span className="badge badge-muted">
                            {metrics.eyesClosed
                                ? <EyeClosed size={12} color="var(--alarm)" />
                                : <User size={12} color="var(--primary)" />
                            }
                            {metrics.yawnActive && <Meh size={12} color="var(--warning)" />}
                            {metrics.headDropped && <Frown size={12} color="var(--warning)" />}
                            {fps} FPS
                        </span>
                    )}
                </div>

                {/* Empty / loading states */}
                {!isActive && !isLoading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>Câmera inativa</span>
                    </div>
                )}
                {isLoading && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', fontWeight: 600 }}>Carregando IA…</span>
                    </div>
                )}

                <CalibrationWizard visible={showWizard && isActive} onFinish={() => setShowWizard(false)} />
                <ViewerModeOverlay />
            </div>

            {/* Warnings below video */}
            {isActive && aiError && !isAiReady && (
                <div className="badge badge-yellow" style={{ padding: 'var(--space-2) var(--space-3)', justifyContent: 'center' }}>
                    Modelo de IA indisponível — apenas vídeo ativo
                </div>
            )}

            {claimNotice && (
                <div className="badge badge-yellow" style={{ padding: 'var(--space-2) var(--space-3)', justifyContent: 'center' }}>
                    {claimNotice}
                </div>
            )}

            {pauseNotice && (
                <div className="badge badge-red" role="alert" style={{ padding: 'var(--space-2) var(--space-3)', justifyContent: 'center' }}>
                    {pauseNotice}
                </div>
            )}
        </div>
    );
};
