import React, { useEffect, useRef, useState } from 'react';
import {
    calibrationManager,
    MIN_CALIBRATION_SAMPLES,
    MAX_CALIBRATION_PHASE_MS,
    type CalibrationOutcome,
} from '../safety/calibrationManager';
import { useMetrics } from '../detection/useMetrics';
import { EarBar } from './EarBar';
import { calibrationProgress } from '../sync/calibrationProgress';
import { requestRemoteCalibration } from '../sync/multiDeviceSync';
import {
    Eye,
    EyeClosed,
    CheckCircle2,
    AlertTriangle,
    Timer,
    RefreshCw,
    Camera,
    MonitorSmartphone,
} from 'lucide-react';

type WizardStep = 'intro' | 'stale-prompt' | 'calibrating' | 'success' | 'error';

export type WizardMode = 'local' | 'remote';

const outcomeMessage: Record<string, string> = {
    timeout: 'Tempo esgotado. Fique de frente para a câmera, parado, e tente de novo.',
    gap: 'Não detectei diferença entre olhos abertos e fechados. Garanta que você realmente fechou os olhos e tente de novo.',
    insufficient_samples: 'Amostras insuficientes. Fique de frente para a câmera, com boa iluminação, e tente de novo.',
};

function PhaseProgress({ count }: { count: number }) {
    const pct = Math.min(100, Math.round((count / MIN_CALIBRATION_SAMPLES) * 100));
    return (
        <div style={{ width: '100%' }}>
            <div style={{ height: 10, background: 'rgba(255,255,255,0.15)', borderRadius: 5, overflow: 'hidden' }}>
                <div style={{
                    width: `${pct}%`, height: '100%',
                    background: 'linear-gradient(90deg, #10b981, #4ade80)',
                    borderRadius: 5, transition: 'width 0.2s linear',
                }} />
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
                {Math.min(count, MIN_CALIBRATION_SAMPLES)} / {MIN_CALIBRATION_SAMPLES} amostras
            </div>
        </div>
    );
}

function SecondsLeft() {
    const [, force] = useState(0);
    useEffect(() => {
        const t = setInterval(() => force((n) => n + 1), 250);
        return () => clearInterval(t);
    }, []);
    const elapsed = calibrationManager.getPhaseElapsedMs() ?? 0;
    const left = Math.max(0, Math.ceil((MAX_CALIBRATION_PHASE_MS - elapsed) / 1000));
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: left <= 3 ? 'var(--warning)' : 'var(--text-muted)' }}>
            <Timer size={14} /> {left}s restantes
        </div>
    );
}

/** Estado ao vivo da calibração, vindo do store local ou do progresso remoto. */
function useCalibrationState(mode: WizardMode) {
    const [, force] = useState(0);
    useEffect(() => {
        const unsub = mode === 'remote'
            ? calibrationProgress.subscribe(() => force((n) => n + 1))
            : calibrationManager.subscribe(() => force((n) => n + 1));
        return unsub;
    }, [mode]);

    if (mode === 'remote') {
        const p = calibrationProgress.get();
        return {
            isCalibrating: p.isCalibrating,
            phase: p.phase,
            openCount: p.openCount,
            closedCount: p.closedCount,
            outcome: p.outcome as CalibrationOutcome,
        };
    }
    return {
        isCalibrating: calibrationManager.isCalibrating,
        phase: calibrationManager.phase,
        openCount: calibrationManager.getOpenSampleCount(),
        closedCount: calibrationManager.getClosedSampleCount(),
        outcome: calibrationManager.getOutcome(),
    };
}

export const CalibrationWizard: React.FC<{
    visible: boolean;
    mode?: WizardMode;
    overlayStyle?: 'absolute' | 'fixed';
    onFinish: () => void;
}> = ({ visible, mode = 'local', overlayStyle = 'absolute', onFinish }) => {
    const [step, setStep] = useState<WizardStep>('intro');
    const initRef = useRef(false);
    const sawCalibratingRef = useRef(false);
    const metrics = useMetrics(150);
    const live = useCalibrationState(mode);

    useEffect(() => {
        if (!visible || initRef.current) return;
        initRef.current = true;
        if (live.isCalibrating) {
            setStep('calibrating');
        } else {
            setStep(calibrationManager.isStale() && calibrationManager.isCalibrated() ? 'stale-prompt' : 'intro');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mode]);

    // Transições de step: só avança para sucesso/erro se a calibração
    // realmente correu durante ESTA exibição (outcome antigo não interfere).
    useEffect(() => {
        if (!visible) {
            initRef.current = false;
            sawCalibratingRef.current = false;
            return;
        }
        if (live.isCalibrating) {
            sawCalibratingRef.current = true;
            setStep('calibrating');
            return;
        }
        if (sawCalibratingRef.current && live.outcome !== null) {
            setStep(live.outcome === 'ok' ? 'success' : 'error');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, live.isCalibrating, live.outcome]);

    if (!visible) return null;

    const phase = live.phase;
    const count = live.phase === 'open' ? live.openCount : live.closedCount;

    const beginCalibration = () => {
        setStep('calibrating');
        if (mode === 'remote') {
            requestRemoteCalibration('start');
        } else {
            calibrationManager.startCalibration();
        }
    };

    const skipWithDefault = () => {
        calibrationManager.skipWithDefault();
        onFinish();
    };

    const headerIcon = mode === 'remote'
        ? <MonitorSmartphone size={36} color="var(--primary)" style={{ margin: '0 auto' }} />
        : <Camera size={36} color="var(--primary)" style={{ margin: '0 auto' }} />;

    const remoteNote = mode === 'remote'
        ? ' A calibração será executada no dispositivo que está com a câmera aberta.'
        : '';

    return (
        <div style={{
            position: overlayStyle, inset: 0, zIndex: overlayStyle === 'fixed' ? 9990 : 50,
            background: 'rgba(10,12,16,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem', overflowY: 'auto',
        }}>
            <style>{`@keyframes wiz-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }`}</style>

            <div style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 16,
                padding: '1.5rem',
                width: '100%',
                maxWidth: 440,
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '1rem',
                textAlign: 'center',
            }}>
                {step === 'intro' && (
                    <>
                        {headerIcon}
                        <h3 style={{ margin: 0 }}>Calibração rápida necessária</h3>
                        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                            Para detectar sua sonolência com precisão, o sistema precisa aprender
                            como são seus <strong>olhos abertos</strong> e <strong>fechados</strong>.{remoteNote}
                        </p>
                        <div style={{ textAlign: 'left', background: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.9rem' }}>
                            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>1.</span>
                                <span>Posicione seu rosto de frente para a câmera, com boa luz.</span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>2.</span>
                                <span>Mantenha os <strong>olhos abertos</strong> por ~2 segundos enquanto o sistema coleta amostras.</span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>3.</span>
                                <span><strong>Feche os olhos</strong> por ~2 segundos até a barra completar.</span>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={beginCalibration}>
                                {mode === 'remote' ? 'Pedir calibração' : 'Começar calibração'}
                            </button>
                            <button className="btn btn-secondary" onClick={skipWithDefault}>
                                Pular (precisão reduzida)
                            </button>
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            Leva menos de 10 segundos. Sem calibrar, os alertas usam um limite genérico.
                        </span>
                    </>
                )}

                {step === 'stale-prompt' && (
                    <>
                        <Timer size={36} color="var(--warning)" style={{ margin: '0 auto' }} />
                        <h3 style={{ margin: 0 }}>Recalibrar?</h3>
                        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                            Sua calibração tem mais de 6 horas. Condições de luz e posicionamento
                            mudam — recalibrar melhora a precisão dos alertas.{remoteNote}
                        </p>
                        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={beginCalibration}>
                                <RefreshCw size={16} /> Recalibrar agora
                            </button>
                            <button className="btn btn-secondary" onClick={onFinish}>
                                Usar calibração atual
                            </button>
                        </div>
                    </>
                )}

                {step === 'calibrating' && (
                    <>
                        {/* remoto: aguardando o detector iniciar a coleta */}
                        {mode === 'remote' && !live.isCalibrating && (
                            <>
                                <RefreshCw size={40} color="var(--primary)" style={{ margin: '0 auto', animation: 'wiz-pulse 1.2s infinite' }} />
                                <h3 style={{ margin: 0 }}>Aguardando o detector...</h3>
                                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                    O pedido foi enviado. Mantenha o dispositivo com a câmera aberto.
                                </p>
                                <button className="btn btn-secondary" onClick={() => { requestRemoteCalibration('cancel'); onFinish(); }}>
                                    Cancelar pedido
                                </button>
                            </>
                        )}

                        {(mode === 'local' || live.isCalibrating) && (
                            <>
                                <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center', fontSize: '0.8rem' }}>
                                    <span style={{
                                        padding: '0.2rem 0.7rem', borderRadius: 999,
                                        background: phase === 'open' ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.08)',
                                        color: phase === 'open' ? 'var(--primary)' : 'var(--text-muted)',
                                        fontWeight: 600,
                                    }}>
                                        1. Olhos abertos
                                    </span>
                                    <span style={{
                                        padding: '0.2rem 0.7rem', borderRadius: 999,
                                        background: phase === 'closed' ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.08)',
                                        color: phase === 'closed' ? 'var(--primary)' : 'var(--text-muted)',
                                        fontWeight: 600,
                                    }}>
                                        2. Olhos fechados
                                    </span>
                                </div>

                                {phase === 'open' ? (
                                    <>
                                        <Eye size={44} color="var(--primary)" style={{ margin: '0 auto', animation: 'wiz-pulse 1.6s infinite' }} />
                                        <h3 style={{ margin: 0 }}>Mantenha os OLHOS ABERTOS</h3>
                                        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                                            Olhe para a câmera com a cabeça parada.
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <EyeClosed size={44} color="var(--primary)" style={{ margin: '0 auto', animation: 'wiz-pulse 1.6s infinite' }} />
                                        <h3 style={{ margin: 0 }}>Agora FECHE os olhos</h3>
                                        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                                            Mantenha os olhos fechados até a barra completar.
                                        </p>
                                    </>
                                )}

                                {mode === 'local' && !metrics.facePresent && (
                                    <div style={{
                                        padding: '0.5rem 0.8rem', borderRadius: 8,
                                        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                                        fontSize: '0.85rem', color: 'var(--alarm)',
                                    }}>
                                        Rosto não detectado — fique de frente para a câmera.
                                    </div>
                                )}
                                {mode === 'local' && calibrationManager.isSettling() && metrics.facePresent && (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                        Estabilizando câmera...
                                    </div>
                                )}
                                {mode === 'remote' && (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                        Coletando amostras no dispositivo com a câmera...
                                    </div>
                                )}

                                <PhaseProgress count={count} />
                                {mode === 'local' && <SecondsLeft />}
                                {mode === 'local' && <EarBar ear={metrics.ear} threshold={metrics.threshold} />}
                            </>
                        )}
                    </>
                )}

                {step === 'success' && (
                    <>
                        <CheckCircle2 size={44} color="var(--primary)" style={{ margin: '0 auto' }} />
                        <h3 style={{ margin: 0 }}>Calibração concluída!</h3>
                        <div style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.35)', borderRadius: 10, padding: '0.8rem 1rem', fontSize: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                            <div>Abertura média dos seus olhos: <strong>{calibrationManager.getBaseline()?.toFixed(3) ?? '—'}</strong></div>
                            <div>Limite de fechamento calculado: <strong>{calibrationManager.getThreshold().toFixed(3)}</strong></div>
                        </div>
                        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            O sistema agora alerta com base no SEU padrão de olhos.
                        </p>
                        <button className="btn btn-primary" onClick={onFinish}>
                            Iniciar monitoramento
                        </button>
                    </>
                )}

                {step === 'error' && (
                    <>
                        <AlertTriangle size={44} color="var(--warning)" style={{ margin: '0 auto' }} />
                        <h3 style={{ margin: 0 }}>Calibração falhou</h3>
                        <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                            {live.outcome ? outcomeMessage[live.outcome] ?? 'Tente novamente.' : 'Tente novamente.'}
                        </p>
                        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={beginCalibration}>
                                <RefreshCw size={16} /> Tentar novamente
                            </button>
                            <button className="btn btn-secondary" onClick={skipWithDefault}>
                                Pular (precisão reduzida)
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
