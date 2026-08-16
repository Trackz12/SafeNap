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
