import React, { useState, useEffect } from 'react';
import { calibrationManager, MIN_CALIBRATION_SAMPLES } from '../safety/calibrationManager';
import { detectionEngine, type PresetName } from '../detection/detectionEngine';
import { cameraStatusStore } from '../camera/cameraStatusStore';
import { SlidersHorizontal, Trash2, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';

const PHASE_INSTRUCTION: Record<string, string> = {
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
            const outcome = calibrationManager.getOutcome();
            if (!calibrationManager.isCalibrating && outcome && outcome !== 'ok') {
                setErrorMsg('A última calibração não foi concluída. Abra a câmera para calibrar.');
            }
        });
        const unsubCam = cameraStatusStore.subscribe(() => setCameraOn(cameraStatusStore.isActive()));
        return () => { unsubCal(); unsubCam(); };
    }, []);

    const phaseCount = isCalibrating ? (phase === 'open' ? openCount : closedCount) : 0;
    const progressPct = Math.min(100, Math.round((phaseCount / MIN_CALIBRATION_SAMPLES) * 100));
    const calDate = calibratedAt ? new Date(calibratedAt).toLocaleString('pt-BR') : null;

    const startCalibration = () => {
        setErrorMsg(null);
        calibrationManager.startCalibration();
    };

    const PRESETS: Array<[PresetName, string]> = [
        ['lenient', 'Leve'],
        ['standard', 'Padrão'],
        ['strict', 'Alta'],
    ];

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            <div className="glass-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <SlidersHorizontal size={14} color="var(--primary)" />
                    <span className="glass-panel-title">Calibração</span>
                </div>
            </div>

            {/* Description — only when not calibrating */}
            {!isCalibrating && (
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '0 0 var(--space-3) 0', lineHeight: 1.5 }}>
                    A calibração guiada abre ao ligar a câmera. Você pode recalibrar pelo botão abaixo.
                </p>
            )}

            {/* Active calibration */}
            {isCalibrating && (
                <div style={{ marginBottom: 'var(--space-3)' }}>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--primary)', marginBottom: 'var(--space-2)' }}>
                        {PHASE_INSTRUCTION[phase]}
                    </div>
                    <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                        <div style={{
                            width: `${progressPct}%`,
                            height: '100%',
                            background: 'var(--primary)',
                            transition: 'width 0.2s linear',
                        }} />
                    </div>
                    <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                        {phaseCount} / {MIN_CALIBRATION_SAMPLES} — fase {phase === 'open' ? '1 (olhos abertos)' : '2 (olhos fechados)'}
                    </div>
                </div>
            )}

            {/* Error */}
            {errorMsg && (
                <div className="badge badge-red" style={{ padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', width: '100%', justifyContent: 'flex-start' }}>
                    <AlertTriangle size={14} />
                    {errorMsg}
                </div>
            )}

            {/* Calibrated status */}
            {!isCalibrating && calibratedAt && (
                <div className="badge badge-green" style={{ padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', width: '100%', justifyContent: 'flex-start' }}>
                    <CheckCircle2 size={14} />
                    <span>Calibrado em {calDate}</span>
                    {calibrationManager.isStale() && (
                        <span style={{ color: 'var(--warning)' }}> — recalibração sugerida</span>
                    )}
                    <button
                        className="btn"
                        onClick={() => { calibrationManager.clearCalibration(); setErrorMsg(null); }}
                        style={{ marginLeft: 'auto', padding: '2px 6px', fontSize: 'var(--text-xs)' }}
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            )}

            {/* Skipped warning */}
            {!isCalibrating && !calibratedAt && calibrationManager.isSkipped() && (
                <div className="badge badge-yellow" style={{ padding: 'var(--space-2) var(--space-3)', marginBottom: 'var(--space-3)', width: '100%', justifyContent: 'flex-start' }}>
                    <AlertTriangle size={14} />
                    Sem calibração (precisão reduzida)
                </div>
            )}

            {/* Action + baselines */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
                <button
                    className="btn btn-primary"
                    onClick={startCalibration}
                    disabled={isCalibrating || !cameraOn}
                    style={{ fontSize: 'var(--text-xs)' }}
                >
                    {isCalibrating
                        ? <><Loader2 size={14} className="spin" /> Calibrando…</>
                        : 'Calibrar'
                    }
                </button>

                {!cameraOn && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                        Ligue a câmera
                    </span>
                )}

                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' }}>
                    <span>aberto: <strong>{baseline ? baseline.toFixed(3) : '—'}</strong></span>
                    {closedBaseline !== null && (
                        <span> · fechado: <strong>{closedBaseline.toFixed(3)}</strong></span>
                    )}
                    <span> · limite: <strong>{threshold.toFixed(3)}</strong></span>
                </div>
            </div>

            {/* Sensitivity presets */}
            <div>
                <div className="metric-label" style={{ marginBottom: 'var(--space-2)' }}>
                    Sensibilidade
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    {PRESETS.map(([name, label]) => (
                        <button
                            key={name}
                            className={`btn ${preset === name ? 'btn-primary' : ''}`}
                            onClick={() => { setPreset(name); detectionEngine.setPreset(name); }}
                            style={{ flex: 1, fontSize: 'var(--text-xs)', padding: 'var(--space-2)' }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};
