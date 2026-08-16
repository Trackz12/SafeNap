import React, { useState, useEffect } from 'react';
import { calibrationManager, MIN_CALIBRATION_SAMPLES } from '../safety/calibrationManager';
import { detectionEngine, type PresetName } from '../detection/detectionEngine';
import { cameraStatusStore } from '../camera/cameraStatusStore';
import { SlidersHorizontal, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';

const phaseInstruction: Record<string, string> = {
    idle: '',
    open: 'Olhe para a câmera com os OLHOS ABERTOS e cabeça neutra.',
    closed: 'Agora FECHE os olhos e mantenha até a barra completar.',
};

export const CalibrationPanel: React.FC = () => {
    const [isCalibrating, setIsCalibrating] = useState(calibrationManager.isCalibrating);
    const [phase, setPhase] = useState(calibrationManager.phase);
    const [baseline, setBaseline] = useState<number | null>(calibrationManager.getBaseline());
    const [closedBaseline, setClosedBaseline] = useState<number | null>(calibrationManager.getClosedBaseline());
    const [threshold, setThreshold] = useState<number>(calibrationManager.getThreshold());
    const [calibratedAt, setCalibratedAt] = useState<number | null>(calibrationManager.getCalibratedAt());
    const [openCount, setOpenCount] = useState(calibrationManager.getOpenSampleCount());
    const [closedCount, setClosedCount] = useState(calibrationManager.getClosedSampleCount());
    const [cameraOn, setCameraOn] = useState(cameraStatusStore.isActive());
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [preset, setPreset] = useState<PresetName>(detectionEngine.getPreset());

    useEffect(() => {
        const unsubCal = calibrationManager.subscribe(() => {
            setIsCalibrating(calibrationManager.isCalibrating);
            setPhase(calibrationManager.phase);
            setBaseline(calibrationManager.getBaseline());
            setClosedBaseline(calibrationManager.getClosedBaseline());
            setThreshold(calibrationManager.getThreshold());
            setCalibratedAt(calibrationManager.getCalibratedAt());
            setOpenCount(calibrationManager.getOpenSampleCount());
            setClosedCount(calibrationManager.getClosedSampleCount());

            // Mensagem de erro do último resultado (o wizard já exibe; aqui
            // é só um lembrete caso o usuário acompanhe pelo painel lateral).
            const outcome = calibrationManager.getOutcome();
            if (!calibrationManager.isCalibrating && outcome && outcome !== 'ok') {
                setErrorMsg('A última calibração não foi concluída. Abra a câmera para calibrar.');
            }
        });
        const unsubCam = cameraStatusStore.subscribe(() => {
            setCameraOn(cameraStatusStore.isActive());
        });
        return () => { unsubCal(); unsubCam(); };
    }, []);

    const phaseCount = isCalibrating ? (phase === 'open' ? openCount : closedCount) : 0;
    const progressPct = Math.min(100, Math.round((phaseCount / MIN_CALIBRATION_SAMPLES) * 100));
    const calDate = calibratedAt ? new Date(calibratedAt).toLocaleString('pt-BR') : null;

    const startCalibration = () => {
        setErrorMsg(null);
        calibrationManager.startCalibration();
    };

    const clearCalibration = () => {
        calibrationManager.clearCalibration();
        setErrorMsg(null);
    };

    const changePreset = (name: PresetName) => {
        setPreset(name);
        detectionEngine.setPreset(name);
    };

    return (
        <div className="glass-panel" style={{ marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 1rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <SlidersHorizontal size={18} color="var(--primary)" /> Calibração & Sensibilidade
            </h3>
            {!isCalibrating && (
                <p style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                    A calibração guiada abre automaticamente ao ligar a câmera. Você também pode
                    recalibrar pelo botão abaixo (apenas com a câmera ligada).
                </p>
            )}

            {isCalibrating && (
                <div style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
                    <div style={{ marginBottom: '0.5rem', color: 'var(--primary)' }}>
                        {phaseInstruction[phase]}
                    </div>
                    <div style={{ height: 8, background: 'rgba(255,255,255,0.15)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                            width: `${progressPct}%`,
                            height: '100%',
                            background: 'var(--primary)',
                            transition: 'width 0.2s linear',
                            borderRadius: 4,
                        }} />
                    </div>
                    <div style={{ marginTop: '0.3rem', color: 'var(--text-muted)' }}>
                        {phaseCount} / {MIN_CALIBRATION_SAMPLES} amostras — fase {phase === 'open' ? '1 (olhos abertos)' : '2 (olhos fechados)'}
                    </div>
                </div>
            )}

            {errorMsg && (
                <div style={{
                    marginBottom: '1rem', padding: '0.6rem 0.8rem', borderRadius: 8,
                    background: 'rgba(220,38,38,0.15)', border: '1px solid rgba(220,38,38,0.4)',
                    display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem',
                }}>
                    <AlertTriangle size={16} color="var(--alarm)" /> {errorMsg}
                </div>
            )}

            {!isCalibrating && calibratedAt && (
                <div style={{
                    marginBottom: '1rem', padding: '0.5rem 0.8rem', borderRadius: 8,
                    background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)',
                    display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', flexWrap: 'wrap',
                }}>
                    <CheckCircle2 size={16} color="var(--primary)" />
                    <span>Calibrado em <strong>{calDate}</strong></span>
                    {calibrationManager.isStale() && (
                        <span style={{ color: 'var(--warning)' }}>— recalibração sugerida</span>
                    )}
                    <button
                        className="btn btn-secondary"
                        onClick={clearCalibration}
                        style={{ marginLeft: 'auto', padding: '0.25rem 0.6rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                    >
                        <Trash2 size={14} /> Limpar
                    </button>
                </div>
            )}

            {!isCalibrating && !calibratedAt && calibrationManager.isSkipped() && (
                <div style={{
                    marginBottom: '1rem', padding: '0.5rem 0.8rem', borderRadius: 8,
                    background: 'rgba(250,204,21,0.12)', border: '1px solid rgba(250,204,21,0.35)',
                    display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem',
                }}>
                    <AlertTriangle size={16} color="var(--warning)" />
                    Monitorando sem calibração (precisão reduzida). Ligue a câmera para calibrar.
                </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <button
                        className="btn"
                        onClick={startCalibration}
                        disabled={isCalibrating || !cameraOn}
                        style={{
                            backgroundColor: isCalibrating || !cameraOn ? '#666' : '#4CAF50',
                            cursor: isCalibrating || !cameraOn ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {isCalibrating
                            ? `Calibrando... fase ${phase === 'open' ? '1' : '2'}`
                            : 'Calibrar'}
                    </button>
                    {!cameraOn && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            Ligue a câmera para calibrar
                        </span>
                    )}
                </div>

                <div style={{ fontSize: '0.9rem' }}>
                    <div>Baseline (aberto): <strong>{baseline ? baseline.toFixed(3) : 'N/A'}</strong></div>
                    {closedBaseline !== null && (
                        <div>Baseline (fechado): <strong>{closedBaseline.toFixed(3)}</strong></div>
                    )}
                    <div>Limite de fechamento: <strong>{threshold.toFixed(3)}</strong></div>
                </div>
            </div>

            <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Sensibilidade da detecção
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {([
                        ['lenient', 'Leve'],
                        ['standard', 'Padrão'],
                        ['strict', 'Alta'],
                    ] as Array<[PresetName, string]>).map(([name, label]) => (
                        <button
                            key={name}
                            className={`btn ${preset === name ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => changePreset(name)}
                            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};
