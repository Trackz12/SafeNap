import { calibrationManager } from '../safety/calibrationManager';
import { detectionEngine } from '../detection/detectionEngine';
import { userModelStore } from './userModel/userModelStore';
import { drowsinessModel } from './drowsinessModel';
import type { FeatureVector } from '../detection/featureExtractor';
import { FEATURE_ORDER } from './featureOrder';
import { modelStatusStore } from './modelStatusStore';
import { ML_STALE_MS } from './thresholds';

const AUTO_TRAIN_INTERVAL_MS = 30_000;
const MAX_SAMPLES_PER_CLASS = 500;

/** Confiança mínima do ONNX para gerar pseudo-label (0-1). */
const PSEUDO_LABEL_CONFIDENCE = 0.65;

function fvToArray(fv: FeatureVector): number[] {
    return FEATURE_ORDER.map((k) => {
        const val = (fv as unknown as Record<string, number>)[k];
        return typeof val === 'number' && Number.isFinite(val) ? val : 0;
    });
}

class MlDataCollector {
    private autoTrainTimer: ReturnType<typeof setInterval> | null = null;
    private lastAutoTrainAt = 0;
    private training = false;

    public start(): void {
        if (this.autoTrainTimer) return;
        this.autoTrainTimer = setInterval(
            () => this.autoTrainCheck(),
            AUTO_TRAIN_INTERVAL_MS,
        );
        console.log('[MlDataCollector] Coleta autônoma com distilação ONNX iniciada');
    }

    public stop(): void {
        if (this.autoTrainTimer) {
            clearInterval(this.autoTrainTimer);
            this.autoTrainTimer = null;
        }
    }

    /**
     * Chamado a cada frame processado. Coleta features com label
     * determinada pelo estado do sistema e distilação do ONNX:
     *
     *  CALIBRAÇÃO (labels explícitos):
     *    - fase "open"  → label 0 (alerta)
     *    - fase "closed" → label 1 (sonolento)
     *
     *  MONITORAMENTO (distilação ONNX → pseudo-labels):
     *    - ONNX score > 0.5 + confiança alta → label 1
     *    - ONNX score < 0.5 + confiança alta → label 0
     *    - ONNX score ambíguo → não coleta
     *    - Estado ALARM sem ONNX → label 1 (fallback)
     *    - Estado NORMAL sem ONNX → label 0 (fallback)
     */
    public collectFrame(fv: FeatureVector): void {
        const label = this.resolveLabel();
        if (label === null) return;

        const arr = fvToArray(fv);
        const alertCount = userModelStore.getAlertCount();
        const drowsyCount = userModelStore.getDrowsyCount();

        if (label === 0 && alertCount >= MAX_SAMPLES_PER_CLASS) return;
        if (label === 1 && drowsyCount >= MAX_SAMPLES_PER_CLASS) return;

        userModelStore.addSample(arr, label);
    }

    private resolveLabel(): 0 | 1 | null {
        if (calibrationManager.isCalibrating) {
            if (calibrationManager.phase === 'open') return 0;
            if (calibrationManager.phase === 'closed') return 1;
            return null;
        }

        // Sem calibração válida (nem optado pelo threshold padrão) o estado
        // do sistema não é confiável — não coleta para não contaminar o modelo.
        if (!calibrationManager.canEvaluate()) return null;

        const mlResult = drowsinessModel.getLastScore();
        const mlFresh = mlResult.at !== null && (Date.now() - mlResult.at) <= ML_STALE_MS;

        if (mlFresh && mlResult.score !== null) {
            const confidence = Math.abs(mlResult.score - 0.5) * 2;
            if (confidence >= PSEUDO_LABEL_CONFIDENCE) {
                return mlResult.score > 0.5 ? 1 : 0;
            }
            return null;
        }

        const state = detectionEngine.getState();
        if (state === 'ALARM') return 1;
        if (state === 'NORMAL') return 0;

        return null;
    }

    private async autoTrainCheck(): Promise<void> {
        if (this.training) return;
        if (!userModelStore.canTrain()) return;
        if (Date.now() - this.lastAutoTrainAt < AUTO_TRAIN_INTERVAL_MS * 2) return;

        this.training = true;
        modelStatusStore.setStatus('loading');

        try {
            await new Promise((r) => setTimeout(r, 0));
            const result = userModelStore.train();
            if (result) {
                this.lastAutoTrainAt = Date.now();
                modelStatusStore.setStatus('ready');
                console.log(
                    `[MlDataCollector] Modelo treinado via distilação! ${userModelStore.getSampleCount()} amostras`,
                );
            } else {
                modelStatusStore.setStatus('error', 'Treino falhou');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            modelStatusStore.setStatus('error', msg);
            console.warn('[MlDataCollector] Falha no treino:', msg);
        } finally {
            this.training = false;
        }
    }

    public manualTrain(): void {
        void this.autoTrainCheck();
    }

    public isTraining(): boolean {
        return this.training;
    }
}

export const mlDataCollector = new MlDataCollector();
