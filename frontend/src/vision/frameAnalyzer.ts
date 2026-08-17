export interface FrameAnalysis {
    ear: number;
    earL: number;
    earR: number;
    mouthAspect: number;
    noseDropRatio: number;
    yawRatio: number;
}

interface Point {
    x: number;
    y: number;
    z?: number;
}

// Distancia em 3D quando o eixo z esta disponivel (MediaPipe fornece).
const dist = (a: Point, b: Point): number =>
    Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z ?? 0) - (b.z ?? 0)) ** 2);

interface EyePoints {
    h1: number;
    h2: number;
    verticals: ReadonlyArray<readonly [number, number]>;
}

// EAR estendido com 4 pares verticais por olho.
const LEFT_EYE: EyePoints = {
    h1: 33,
    h2: 133,
    verticals: [
        [158, 153],
        [160, 144],
        [159, 145],
        [157, 154],
    ],
};
const RIGHT_EYE: EyePoints = {
    h1: 263,
    h2: 362,
    verticals: [
        [387, 373],
        [385, 380],
        [386, 374],
        [388, 390],
    ],
};

const EYE_OUTER_LEFT = 33;
const EYE_OUTER_RIGHT = 263;
const NOSE_TIP = 1;
const CHIN = 152;
const MOUTH_TOP = 13;
const MOUTH_BOTTOM = 14;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;

// Reduzido de 0.15 para 0.10 — aceita faces de perfil (geometricamente menores).
const MIN_FACE_WIDTH = 0.10;
// Reduzido de 0.03 para 0.01 — em perfil, um lado fica perto da borda.
const EDGE_MARGIN = 0.01;

const EYE_DISAGREEMENT_RATIO = 0.55;

// Limiar de yaw acima do qual consideramos perfil significativo.
const YAW_PROFILE_THRESHOLD = 0.25;
// Faixa de transicao suave entre yaw 0.25 e 0.60.
const YAW_TRANSITION_RANGE = 0.35;

function nearEdge(p: Point, margin: number): boolean {
    return p.x < margin || p.x > 1 - margin || p.y < margin || p.y > 1 - margin;
}

function eyeEAR(landmarks: Point[], eye: EyePoints): number {
    const horizontal = dist(landmarks[eye.h1], landmarks[eye.h2]);
    if (horizontal <= 1e-6) return 0;
    let verticalSum = 0;
    for (const [up, lo] of eye.verticals) {
        verticalSum += dist(landmarks[up], landmarks[lo]);
    }
    return verticalSum / (eye.verticals.length * horizontal);
}

/**
 * Combina o EAR dos dois olhos de forma robusta a oculos/reflexos/oclusao
 * E a poses de perfil (yaw).
 *
 * - Em pose frontal: faz a media (com protecao contra discordancia).
 * - Em pose de perfil: confia no olho mais visivel (do lado da camera),
 *   pois o olho ocluido da EAR artificialmente baixo.
 *
 * A transicao e suave (suavizacao linear) para evitar oscilacoes.
 */
export function combineEyes(earL: number, earR: number, yawRatio: number = 0): number {
    const lo = Math.min(earL, earR);
    const hi = Math.max(earL, earR);

    const absYaw = Math.abs(yawRatio);

    // Em perfil significativo: confiar no olho mais aberto (mais visivel)
    if (absYaw > YAW_PROFILE_THRESHOLD) {
        const yawFactor = Math.min(1, (absYaw - YAW_PROFILE_THRESHOLD) / YAW_TRANSITION_RANGE);
        const frontEar = (earL + earR) / 2;
        const profileEar = hi;
        return frontEar * (1 - yawFactor) + profileEar * yawFactor;
    }

    // Pose frontal: protecao contra discordancia (reflexo/oclusao)
    if (hi > 1e-6 && lo / hi < EYE_DISAGREEMENT_RATIO) return hi;
    return (earL + earR) / 2;
}

export function analyzeFrame(landmarks: Point[]): FrameAnalysis | null {
    if (!landmarks || landmarks.length < 300) return null;

    const faceWidth = dist(landmarks[EYE_OUTER_LEFT], landmarks[EYE_OUTER_RIGHT]);
    if (faceWidth < MIN_FACE_WIDTH) return null;

    // Em perfil, apenas nariz e queixo sao confiaveis (centro do rosto).
    if (
        nearEdge(landmarks[NOSE_TIP], EDGE_MARGIN) ||
        nearEdge(landmarks[CHIN], EDGE_MARGIN)
    ) {
        return null;
    }

    // Em perfil, os olhos podem estar parcialmente fora do frame —
    // so verificamos borda se o yaw for baixo (pose mais frontal).
    const midEyesX = (landmarks[EYE_OUTER_LEFT].x + landmarks[EYE_OUTER_RIGHT].x) / 2;
    const yawEstimate = faceWidth > 1e-6
        ? Math.abs(landmarks[NOSE_TIP].x - midEyesX) / faceWidth
        : 0;

    if (yawEstimate < 0.3) {
        if (
            nearEdge(landmarks[EYE_OUTER_LEFT], EDGE_MARGIN) ||
            nearEdge(landmarks[EYE_OUTER_RIGHT], EDGE_MARGIN) ||
            nearEdge(landmarks[MOUTH_LEFT], EDGE_MARGIN) ||
            nearEdge(landmarks[MOUTH_RIGHT], EDGE_MARGIN)
        ) {
            return null;
        }
    }

    const earL = eyeEAR(landmarks, LEFT_EYE);
    const earR = eyeEAR(landmarks, RIGHT_EYE);

    const midEyes = {
        x: (landmarks[EYE_OUTER_LEFT].x + landmarks[EYE_OUTER_RIGHT].x) / 2,
        y: (landmarks[EYE_OUTER_LEFT].y + landmarks[EYE_OUTER_RIGHT].y) / 2,
    };
    const faceHeight = dist(midEyes, landmarks[CHIN]);

    const noseDropRatio = faceHeight > 1e-6 ? (landmarks[NOSE_TIP].y - midEyes.y) / faceHeight : 0;
    const yawRatio = faceWidth > 1e-6 ? (landmarks[NOSE_TIP].x - midEyes.x) / faceWidth : 0;

    // EAR compensado por yaw — em perfil, confia no olho mais visivel
    const ear = combineEyes(earL, earR, yawRatio);

    const mouthWidth = dist(landmarks[MOUTH_LEFT], landmarks[MOUTH_RIGHT]);
    const mouthAspect = mouthWidth > 1e-6
        ? dist(landmarks[MOUTH_TOP], landmarks[MOUTH_BOTTOM]) / mouthWidth
        : 0;

    if (!Number.isFinite(ear) || !Number.isFinite(mouthAspect) || !Number.isFinite(noseDropRatio)) {
        return null;
    }

    return { ear, earL, earR, mouthAspect, noseDropRatio, yawRatio };
}
