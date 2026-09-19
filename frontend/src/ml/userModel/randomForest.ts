import { NUM_FEATURES } from '../featureOrder';
import { trainCART, predictCART, type CARTNode } from './cart';

export interface UserRF {
    version: number;
    trees: CARTNode[];
    trainedAt: number;
    sampleCount: number;
}

const NUM_TREES = 40;
const SUBSAMPLE_FEATURES = Math.floor(Math.sqrt(NUM_FEATURES));

export function trainUserRF(X: number[][], y: number[]): UserRF | null {
    if (X.length < 10) return null;

    const n = X.length;
    const allFeatures = Array.from({ length: NUM_FEATURES }, (_, i) => i);
    const trees: CARTNode[] = [];

    for (let t = 0; t < NUM_TREES; t++) {
        const bootstrapX: number[][] = [];
        const bootstrapY: number[] = [];
        for (let i = 0; i < n; i++) {
            const idx = Math.floor(Math.random() * n);
            bootstrapX.push(X[idx]);
            bootstrapY.push(y[idx]);
        }
        // Subamostra de features para cada arvore (RF style)
        const shuffled = [...allFeatures].sort(() => Math.random() - 0.5);
        const featureIndices = shuffled.slice(0, Math.min(SUBSAMPLE_FEATURES, NUM_FEATURES));
        trees.push(trainCART(bootstrapX, bootstrapY, featureIndices));
    }

    return {
        version: 1,
        trees,
        trainedAt: Date.now(),
        sampleCount: n,
    };
}

export function predictUserRF(model: UserRF, features: number[]): number {
    let sum = 0;
    for (const tree of model.trees) {
        sum += predictCART(tree, features);
    }
    return sum / model.trees.length;
}

const MAX_TREES = 200;
const MAX_TREE_DEPTH = 12;
const MAX_TREE_NODES = 20_000;
const MAX_TRAINED_AT_SKEW_MS = 24 * 60 * 60 * 1000;

function validNode(node: unknown, depth: number, budget: { nodes: number }): boolean {
    if (depth > MAX_TREE_DEPTH || ++budget.nodes > MAX_TREE_NODES) return false;
    if (typeof node !== 'object' || node === null) return false;
    const n = node as CARTNode;
    if (n.featureIndex === undefined) {
        return typeof n.prediction === 'number' && Number.isFinite(n.prediction)
            && n.prediction >= 0 && n.prediction <= 1;
    }
    return Number.isInteger(n.featureIndex) && n.featureIndex >= 0 && n.featureIndex < NUM_FEATURES
        && typeof n.threshold === 'number' && Number.isFinite(n.threshold)
        && validNode(n.left, depth + 1, budget) && validNode(n.right, depth + 1, budget);
}

/**
 * Modelo vindo de localStorage ou de outro dispositivo (sync) não é confiável:
 * um modelo malformado geraria NaN, estouraria a pilha ou fixaria "alerta" para
 * sempre. Devolve o modelo se for estruturalmente seguro, senão null.
 */
export function validateUserRF(raw: unknown): UserRF | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Partial<UserRF>;
    if (!Array.isArray(m.trees) || m.trees.length < 1 || m.trees.length > MAX_TREES) return null;
    if (typeof m.trainedAt !== 'number' || !Number.isFinite(m.trainedAt)
        || m.trainedAt > Date.now() + MAX_TRAINED_AT_SKEW_MS) return null;
    if (typeof m.sampleCount !== 'number' || !Number.isFinite(m.sampleCount)) return null;
    for (const tree of m.trees) {
        if (!validNode(tree, 0, { nodes: 0 })) return null;
    }
    return m as UserRF;
}
