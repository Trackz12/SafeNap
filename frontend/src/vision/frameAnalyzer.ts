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

// Distância em 3D quando o eixo z está disponível (MediaPipe fornece).
// O EAR 3D é invariante à pose da cabeça: inclinar a cabeça encolhe a
// projeção 2D do olho, mas a abertura real em 3D permanece constante.
const dist = (a: Point, b: Point): number =>
    Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z ?? 0) - (b.z ?? 0)) ** 2);

interface EyePoints {
    h1: number;
    h2: number;
    verticals: ReadonlyArray<readonly [number, number]>;
}

// EAR estendido com 4 pares verticais por olho (em vez de 2): um reflexo de
// óculos costuma deslocar 1 ou 2 landmarks; amostrar mais pontos dilui o erro.
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

// Rosto muito pequeno (longe demais) gera landmarks instáveis → descarta.
const MIN_FACE_WIDTH = 0.15;
// Rosto cortado pelas bordas → landmarks parciais/ruidosos → descarta.
const EDGE_MARGIN = 0.03;

// Quando os olhos discordam fortemente (um parece fechado e o outro claramente
// aberto), o motivo provável é reflexo de óculos/oclusão num olho — sonolência
// real fecha os DOIS olhos. Nesse caso, confia no olho mais aberto.
const EYE_DISAGREEMENT_RATIO = 0.55;

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
 * Combina o EAR dos dois olhos de forma robusta a óculos/reflexos/oclusão.
 * Exportada para permitir teste unitário isolado.
 */
export function combineEyes(earL: number, earR: number): number {
    const lo = Math.min(earL, earR);
    const hi = Math.max(earL, earR);
    if (hi > 1e-6 && lo / hi < EYE_DISAGREEMENT_RATIO) return hi;
    return (earL + earR) / 2;
}

export function analyzeFrame(landmarks: Point[]): FrameAnalysis | null {
    if (!landmarks || landmarks.length < 300) return null;

    const faceWidth = dist(landmarks[EYE_OUTER_LEFT], landmarks[EYE_OUTER_RIGHT]);
    if (faceWidth < MIN_FACE_WIDTH) return null;

    // Verifica se pontos-chave estão dentro do frame (rosto não cortado)
    if (
        nearEdge(landmarks[EYE_OUTER_LEFT], EDGE_MARGIN) ||
        nearEdge(landmarks[EYE_OUTER_RIGHT], EDGE_MARGIN) ||
        nearEdge(landmarks[CHIN], EDGE_MARGIN) ||
        nearEdge(landmarks[NOSE_TIP], EDGE_MARGIN) ||
        nearEdge(landmarks[MOUTH_LEFT], EDGE_MARGIN) ||
        nearEdge(landmarks[MOUTH_RIGHT], EDGE_MARGIN)
    ) {
        return null;
    }

    const earL = eyeEAR(landmarks, LEFT_EYE);
    const earR = eyeEAR(landmarks, RIGHT_EYE);
    const ear = combineEyes(earL, earR);

    const midEyes = {
        x: (landmarks[EYE_OUTER_LEFT].x + landmarks[EYE_OUTER_RIGHT].x) / 2,
        y: (landmarks[EYE_OUTER_LEFT].y + landmarks[EYE_OUTER_RIGHT].y) / 2,
    };
    const faceHeight = dist(midEyes, landmarks[CHIN]);

    const noseDropRatio = faceHeight > 1e-6 ? (landmarks[NOSE_TIP].y - midEyes.y) / faceHeight : 0;
    const yawRatio = faceWidth > 1e-6 ? (landmarks[NOSE_TIP].x - midEyes.x) / faceWidth : 0;

    const mouthWidth = dist(landmarks[MOUTH_LEFT], landmarks[MOUTH_RIGHT]);
    const mouthAspect = mouthWidth > 1e-6
        ? dist(landmarks[MOUTH_TOP], landmarks[MOUTH_BOTTOM]) / mouthWidth
        : 0;

    if (!Number.isFinite(ear) || !Number.isFinite(mouthAspect) || !Number.isFinite(noseDropRatio)) {
        return null;
    }

    return { ear, earL, earR, mouthAspect, noseDropRatio, yawRatio };
}
