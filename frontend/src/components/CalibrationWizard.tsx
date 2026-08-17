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
import { Eye, EyeClosed, CheckCircle2, AlertTriangle, Timer, RefreshCw, Camera, MonitorSmartphone } from 'lucide-react';

type WizardStep = 'intro' | 'stale-prompt' | 'calibrating' | 'success' | 'error';
export type WizardMode = 'local' | 'remote';

const OUTCOME_MSG: Record<string, string> = {
    timeout: 'Tempo esgotado. Fique de frente para a câmera e tente de novo.',
    gap: 'Não detectei diferença entre olhos abertos e fechados. Garanta que você fechou os olhos.',
    insufficient_samples: 'Amostras insuficientes. Fique de frente para a câmera com boa iluminação.',
};

function PhaseProgress({ count }: { count: number }) {
    const pct = Math.min(100, Math.round((count / MIN_CALIBRATION_SAMPLES) * 100));
    return (
        <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Progresso</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {Math.min(count, MIN_CALIBRATION_SAMPLES)} / {MIN_CALIBRATION_SAMPLES}
                </span>
            </div>
            <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                <div style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: 'var(--primary)',
                    transition: 'width 0.2s linear',
                }} />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 'var(--text-xs)', color: left <= 3 ? 'var(--warning)' : 'var(--text-muted)' }}>
            <Timer size={12} /> {left}s
        </div>
    );
}

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

const STEPS_LIST = [
    { num: 1, label: 'Posicione o rosto de frente para a câmera, com boa luz.' },
    { num: 2, label: 'Mantenha os olhos abertos por ~2 segundos.' },
    { num: 3, label: 'Feche os olhos por ~2 segundos até a barra completar.' },
];

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
    }, [visible, mode]);

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
        ? <MonitorSmartphone size={28} color="var(--primary)" />
        : <Camera size={28} color="var(--primary)" />;

    return (
        <div style={{
            position: overlayStyle, inset: 0,
            zIndex: overlayStyle === 'fixed' ? 9990 : 50,
            background: 'rgba(9,9,11,0.92)',
            backdropFilter: 'blur(var(--blur-lg))',
            WebkitBackdropFilter: 'blur(var(--blur-lg))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 'var(--space-4)', overflowY: 'auto',
        }}>
            <div className="animate-fade-in" style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-xl)',
                padding: 'var(--space-6)',
                width: '100%',
                maxWidth: 420,
                boxShadow: 'var(--shadow-lg)',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-4)',
                textAlign: 'center',
            }}>
                {/* ── Intro ── */}
                {step === 'intro' && (
                    <>
                        <div style={{
                            width: 56, height: 56, borderRadius: '50%',
                            background: 'var(--primary-dim)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto',
                        }}>
                            {headerIcon}
                        </div>
                        <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>
                            Calibração rápida
                        </h3>
                        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                            O sistema precisa aprender seus olhos abertos e fechados.
                            {mode === 'remote' ? ' A calibração será executada no dispositivo com a câmera.' : ''}
                        </p>
                        <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                            {STEPS_LIST.map(({ num, label }) => (
                                <div key={num} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', fontSize: 'var(--text-sm)' }}>
                                    <span style={{ color: 'var(--primary)', fontWeight: 700, minWidth: 16 }}>{num}.</span>
                                    <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={beginCalibration}>
                                {mode === 'remote' ? 'Pedir calibração' : 'Começar'}
                            </button>
                            <button className="btn" onClick={skipWithDefault}>
                                Pular
                            </button>
                        </div>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                            Leva menos de 10 segundos
                        </span>
                    </>
                )}

                {/* ── Stale prompt ── */}
                {step === 'stale-prompt' && (
                    <>
                        <div style={{
                            width: 56, height: 56, borderRadius: '50%',
                            background: 'var(--warning-dim)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto',
                        }}>
                            <Timer size={28} color="var(--warning)" />
                        </div>
                        <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>Recalibrar?</h3>
                        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                            Sua calibração tem mais de 6 horas. Condições mudam — recalibrar melhora a precisão.
                        </p>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={beginCalibration}>
                                <RefreshCw size={14} /> Recalibrar
                            </button>
                            <button className="btn" onClick={onFinish}>Usar atual</button>
                        </div>
                    </>
                )}

                {/* ── Calibrating ── */}
                {step === 'calibrating' && (
                    <>
                        {mode === 'remote' && !live.isCalibrating && (
                            <>
                                <div style={{
                                    width: 56, height: 56, borderRadius: '50%',
                                    background: 'var(--primary-dim)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    margin: '0 auto',
                                    animation: 'pulse-dot 2s ease-in-out infinite',
                                }}>
                                    <RefreshCw size={28} color="var(--primary)" className="spin" />
                                </div>
                                <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>Aguardando detector…</h3>
                                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                                    Pedido enviado. Mantenha o dispositivo com a câmera aberto.
                                </p>
                                <button className="btn" onClick={() => { requestRemoteCalibration('cancel'); onFinish(); }}>
                                    Cancelar
                                </button>
                            </>
                        )}

                        {(mode === 'local' || live.isCalibrating) && (
                            <>
                                {/* Phase tabs */}
                                <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
                                    {(['open', 'closed'] as const).map((p) => (
                                        <span key={p} className={`badge ${phase === p ? 'badge-green' : 'badge-muted'}`}>
                                            {p === 'open' ? <Eye size={12} /> : <EyeClosed size={12} />}
                                            {p === 'open' ? 'Abertos' : 'Fechados'}
                                        </span>
                                    ))}
                                </div>

                                {/* Icon + instruction */}
                                <div style={{
                                    width: 56, height: 56, borderRadius: '50%',
                                    background: 'var(--primary-dim)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    margin: '0 auto',
                                    animation: 'pulse-dot 2s ease-in-out infinite',
                                }}>
                                    {phase === 'open'
                                        ? <Eye size={28} color="var(--primary)" />
                                        : <EyeClosed size={28} color="var(--primary)" />
                                    }
                                </div>

                                <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>
                                    {phase === 'open' ? 'Mantenha os OLHOS ABERTOS' : 'Agora FECHE os olhos'}
                                </h3>
                                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                                    {phase === 'open'
                                        ? 'Olhe para a câmera com a cabeça parada.'
                                        : 'Mantenha fechado até a barra completar.'
                                    }
                                </p>

                                {mode === 'local' && !metrics.facePresent && (
                                    <div className="badge badge-red" style={{ padding: 'var(--space-2) var(--space-3)', justifyContent: 'center' }}>
                                        <AlertTriangle size={14} />
                                        Rosto não detectado
                                    </div>
                                )}

                                <PhaseProgress count={count} />

                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    {mode === 'local' && <SecondsLeft />}
                                    {mode === 'remote' && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Coletando no detector…</span>}
                                </div>

                                {mode === 'local' && <EarBar ear={metrics.ear} threshold={metrics.threshold} />}
                            </>
                        )}
                    </>
                )}

                {/* ── Success ── */}
                {step === 'success' && (
                    <>
                        <div style={{
                            width: 56, height: 56, borderRadius: '50%',
                            background: 'var(--primary-dim)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto',
                        }}>
                            <CheckCircle2 size={28} color="var(--primary)" />
                        </div>
                        <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>Calibração concluída!</h3>
                        <div className="badge badge-green" style={{ padding: 'var(--space-2) var(--space-3)', justifyContent: 'center', width: '100%', flexDirection: 'column' }}>
                            <div style={{ fontSize: 'var(--text-sm)' }}>
                                Abertura: <strong>{calibrationManager.getBaseline()?.toFixed(3) ?? '—'}</strong>
                            </div>
                            <div style={{ fontSize: 'var(--text-sm)' }}>
                                Limite: <strong>{calibrationManager.getThreshold().toFixed(3)}</strong>
                            </div>
                        </div>
                        <button className="btn btn-primary" onClick={onFinish} style={{ width: '100%' }}>
                            Iniciar monitoramento
                        </button>
                    </>
                )}

                {/* ── Error ── */}
                {step === 'error' && (
                    <>
                        <div style={{
                            width: 56, height: 56, borderRadius: '50%',
                            background: 'var(--warning-dim)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            margin: '0 auto',
                        }}>
                            <AlertTriangle size={28} color="var(--warning)" />
                        </div>
                        <h3 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600 }}>Calibração falhou</h3>
                        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                            {live.outcome ? OUTCOME_MSG[live.outcome] ?? 'Tente novamente.' : 'Tente novamente.'}
                        </p>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={beginCalibration}>
                                <RefreshCw size={14} /> Tentar
                            </button>
                            <button className="btn" onClick={skipWithDefault}>Pular</button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
