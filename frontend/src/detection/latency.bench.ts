import { bench, describe } from 'vitest';
import { DetectionEngine } from './detectionEngine';
import { analyzeFrame, type FrameAnalysis } from '../vision/frameAnalyzer';
import { featureExtractor } from './featureExtractor';
import { calibrationManager } from '../safety/calibrationManager';

/**
 * Mede o custo REAL de computação (JS, em Node) das etapas do pipeline de
 * detecção que rodam no navegador do usuário — EXCETO a extração de
 * landmarks pelo MediaPipe em si, que é WASM/nativo, roda fora do nosso
 * código e depende do hardware/browser do usuário (não é algo que
 * medimos ou controlamos).
 *
 * Rodar: `npx vitest bench src/detection/latency.bench.ts`
 * Ver reports/latency/ para os números consolidados.
 */

calibrationManager.clearCalibration();
calibrationManager.skipWithDefault();

const engine = new DetectionEngine();
const steadyFrame: FrameAnalysis = {
    ear: 0.35,
    earL: 0.35,
    earR: 0.35,
    mouthAspect: 0.2,
    noseDropRatio: 0.3,
    yawRatio: 0,
};

describe('DetectionEngine.processFrame (regime normal, sem transição de estado)', () => {
    bench('processFrame', () => {
        engine.processFrame(steadyFrame);
    });
});

describe('FeatureExtractor.extract (18 features, janela de 10 frames)', () => {
    featureExtractor.reset();
    bench('extract', () => {
        featureExtractor.extract(steadyFrame, Date.now(), {
            perclos: 0.1,
            blinkRate: 12,
            lastBlinkAt: Date.now() - 2000,
        });
    });
});

// 478 landmarks sintéticos (formato real do MediaPipe FaceLandmarker) —
// só os índices realmente usados por analyzeFrame têm coordenadas
// realistas; os demais são preenchimento neutro para atingir o
// comprimento mínimo (>=300) exigido pela função.
function makeSyntheticLandmarks(): Array<{ x: number; y: number; z: number }> {
    const pts: Array<{ x: number; y: number; z: number }> = Array.from({ length: 478 }, () => ({
        x: 0.5,
        y: 0.5,
        z: 0,
    }));
    const set = (i: number, x: number, y: number, z = 0) => {
        pts[i] = { x, y, z };
    };
    // Olho esquerdo
    set(33, 0.35, 0.45); set(133, 0.42, 0.45);
    set(158, 0.37, 0.435); set(153, 0.37, 0.465);
    set(160, 0.385, 0.43); set(144, 0.385, 0.47);
    set(159, 0.40, 0.435); set(145, 0.40, 0.465);
    set(157, 0.415, 0.44); set(154, 0.415, 0.46);
    // Olho direito (espelhado)
    set(263, 0.65, 0.45); set(362, 0.58, 0.45);
    set(387, 0.63, 0.435); set(373, 0.63, 0.465);
    set(385, 0.615, 0.43); set(380, 0.615, 0.47);
    set(386, 0.60, 0.435); set(374, 0.60, 0.465);
    set(388, 0.585, 0.44); set(390, 0.585, 0.46);
    // Nariz, queixo, boca
    set(1, 0.5, 0.55);
    set(152, 0.5, 0.85);
    set(13, 0.48, 0.65); set(14, 0.48, 0.68);
    set(61, 0.42, 0.665); set(291, 0.58, 0.665);
    return pts;
}

const landmarks = makeSyntheticLandmarks();

describe('analyzeFrame (geometria EAR/boca/nariz a partir de 478 landmarks)', () => {
    bench('analyzeFrame', () => {
        analyzeFrame(landmarks);
    });
});
