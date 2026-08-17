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
        const unsubModel = modelStatusStore.subscribe(() => setModelStatus(modelStatusStore.getStatus()));
        const unsubRole = roleStore.subscribe(() => setRole(roleStore.getRole()));
        return () => { unsubUser(); unsubModel(); unsubRole(); };
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

    return (
        <div className="glass-panel" style={{ padding: 'var(--space-4)' }}>
            <div className="glass-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <Brain size={14} color="var(--primary)" />
                    <span className="glass-panel-title">Treinamento ML</span>
                </div>
                {isViewer && (
                    <span className="badge badge-muted">
                        <Eye size={12} />
                        Espelhando
                    </span>
                )}
            </div>

            {isViewer ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {model ? (
                        <>
                            <div>Modelo sincronizado ({model.sampleCount} amostras)</div>
                            {model.trainedAt > 0 && (
                                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 'var(--space-1)' }}>
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
                    {/* Sample counts */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
                        <div className="metric-card" style={{ textAlign: 'center', padding: 'var(--space-2)' }}>
                            <div className="metric-label">Alertas</div>
                            <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--primary)', fontVariantNumeric: 'tabular-nums' }}>
                                {alertCount}
                            </div>
                        </div>
                        <div className="metric-card" style={{ textAlign: 'center', padding: 'var(--space-2)' }}>
                            <div className="metric-label">Sonolento</div>
                            <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--alarm)', fontVariantNumeric: 'tabular-nums' }}>
                                {drowsyCount}
                            </div>
                        </div>
                    </div>

                    {/* Progress bar */}
                    <div style={{ marginBottom: 'var(--space-3)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Progresso</span>
                            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{progress}%</span>
                        </div>
                        <div style={{ width: '100%', height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                            <div style={{
                                width: `${progress}%`,
                                height: '100%',
                                borderRadius: 2,
                                background: canTrain ? 'var(--primary)' : 'var(--warning)',
                                transition: 'width 0.3s var(--ease-out)',
                            }} />
                        </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                        <button
                            className="btn btn-primary"
                            onClick={handleTrain}
                            disabled={!canTrain || training}
                            style={{ flex: 1, fontSize: 'var(--text-xs)' }}
                        >
                            {training ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                            {hasModel ? 'Re-treinar' : 'Treinar'}
                        </button>
                        <button
                            className="btn"
                            onClick={() => userModelStore.clearAll()}
                            disabled={alertCount === 0 && drowsyCount === 0}
                            style={{ fontSize: 'var(--text-xs)' }}
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>

                    {/* Status */}
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', textAlign: 'center', marginTop: 'var(--space-2)' }}>
                        {!canTrain
                            ? `Coletando dados… (${Math.min(alertCount, MIN_SAMPLES) + Math.min(drowsyCount, MIN_SAMPLES)}/${MIN_SAMPLES * 2})`
                            : modelStatus === 'ready'
                                ? `Modelo ativo (${model?.sampleCount ?? '…'} amostras)`
                                : 'Modelo ainda não treinado'
                        }
                    </div>
                </>
            )}
        </div>
    );
};
