import React, { useEffect, useState } from 'react';
import { userModelStore } from '../ml/userModel/userModelStore';
import { mlDataCollector } from '../ml/mlDataCollector';
import { modelStatusStore } from '../ml/modelStatusStore';
import { roleStore } from '../sync/roleStore';
import { Brain, Loader2, Trash2, RefreshCw, Eye } from 'lucide-react';

const MIN_SAMPLES = 50;

export const MlTrainingCard: React.FC = () => {
    const [alertCount, setAlertCount] = useState(userModelStore.getAlertCount());
    const [drowsyCount, setDrowsyCount] = useState(userModelStore.getDrowsyCount());
    const [hasModel, setHasModel] = useState(userModelStore.getModel() !== null);
    const [training, setTraining] = useState(false);
    const [modelStatus, setModelStatus] = useState(modelStatusStore.getStatus());
    const [role, setRole] = useState(roleStore.getRole());

    useEffect(() => {
        const unsubUser = userModelStore.subscribe(() => {
            setAlertCount(userModelStore.getAlertCount());
            setDrowsyCount(userModelStore.getDrowsyCount());
            setHasModel(userModelStore.getModel() !== null);
        });
        const unsubModel = modelStatusStore.subscribe(() => {
            setModelStatus(modelStatusStore.getStatus());
        });
        const unsubRole = roleStore.subscribe(() => {
            setRole(roleStore.getRole());
        });

        return () => {
            unsubUser();
            unsubModel();
            unsubRole();
        };
    }, []);

    const canTrain = alertCount >= MIN_SAMPLES && drowsyCount >= MIN_SAMPLES;
    const progress = Math.min(100, Math.round(((Math.min(alertCount, MIN_SAMPLES) + Math.min(drowsyCount, MIN_SAMPLES)) / (MIN_SAMPLES * 2)) * 100));
    const model = userModelStore.getModel();
    const isViewer = role === 'viewer';

    const handleTrain = () => {
        setTraining(true);
        setTimeout(() => {
            mlDataCollector.manualTrain();
            setTimeout(() => setTraining(false), 1500);
        }, 100);
    };

    const handleClear = () => {
        userModelStore.clearAll();
    };

    return (
        <div className="glass-panel" style={{ padding: '0.75rem 1rem' }}>
            <h3 style={{ margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
                <Brain size={16} color="var(--primary)" /> Treinamento ML
                {isViewer && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.65rem', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--muted)' }}>
                        <Eye size={12} /> Espelhando detector
                    </span>
                )}
            </h3>

            {isViewer ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                    {model ? (
                        <>
                            <div>Modelo sincronizado do detector ({model.sampleCount} amostras)</div>
                            {model.trainedAt > 0 && (
                                <div style={{ fontSize: '0.7rem', marginTop: 4 }}>
                                    Treinado em {new Date(model.trainedAt).toLocaleString('pt-BR')}
                                </div>
                            )}
                        </>
                    ) : (
                        <div>Aguardando modelo do detector…</div>
                    )}
                </div>
            ) : (
                <>
                    <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.5rem' }}>
                        <div style={{ flex: 1, textAlign: 'center', padding: '6px', borderRadius: 6, background: 'rgba(0,200,120,0.08)' }}>
                            <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>Alertas</div>
                            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--primary)' }}>{alertCount}</div>
                        </div>
                        <div style={{ flex: 1, textAlign: 'center', padding: '6px', borderRadius: 6, background: 'rgba(255,80,80,0.08)' }}>
                            <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>Sonolento</div>
                            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--alarm)' }}>{drowsyCount}</div>
                        </div>
                    </div>

                    <div style={{ width: '100%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden', marginBottom: '0.5rem' }}>
                        <div style={{
                            width: `${progress}%`,
                            height: '100%',
                            borderRadius: 2,
                            background: canTrain ? 'var(--primary)' : 'var(--warning)',
                            transition: 'width 0.3s',
                        }} />
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                            className="btn btn-primary"
                            onClick={handleTrain}
                            disabled={!canTrain || training}
                            style={{ flex: 1, fontSize: '0.75rem', padding: '6px 10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                        >
                            {training ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                            {hasModel ? 'Re-treinar' : 'Treinar'}
                        </button>
                        <button
                            className="btn"
                            onClick={handleClear}
                            disabled={alertCount === 0 && drowsyCount === 0}
                            style={{ fontSize: '0.75rem', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}
                        >
                            <Trash2 size={14} /> Limpar
                        </button>
                    </div>

                    <div style={{ fontSize: '0.65rem', color: 'var(--muted)', marginTop: '0.4rem', textAlign: 'center' }}>
                        {!canTrain
                            ? `Distilando ONNX → RF… (${Math.min(alertCount, MIN_SAMPLES) + Math.min(drowsyCount, MIN_SAMPLES)}/${MIN_SAMPLES * 2})`
                            : modelStatus === 'ready'
                                ? `Modelo ativo (${model ? `${model.sampleCount} amostras` : '…'})`
                                : 'Modelo ainda não treinado'
                        }
                    </div>
                </>
            )}
        </div>
    );
};
