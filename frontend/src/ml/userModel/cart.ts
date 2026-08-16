import { NUM_FEATURES } from '../featureOrder';

export interface CARTNode {
    featureIndex?: number;
    threshold?: number;
    left?: CARTNode;
    right?: CARTNode;
    prediction?: number;
    count?: number;
}

interface SplitCandidate {
    gain: number;
    featureIndex: number;
    threshold: number;
    leftMask: boolean[];
    rightMask: boolean[];
}

const MAX_DEPTH = 6;
const MIN_SAMPLES_LEAF = 3;

function gini(labels: number[]): number {
    if (labels.length === 0) return 0;
    const n = labels.length;
    let p0 = 0;
    for (const l of labels) if (l === 0) p0++;
    const p1 = 1 - p0 / n;
    const p0n = p0 / n;
    return 1 - p0n * p0n - p1 * p1;
}

function findBestSplit(
    X: number[][],
    y: number[],
    featureIndices: number[],
): SplitCandidate | null {
    const n = y.length;
    const parentGini = gini(y);
    if (parentGini <= 0) return null;

    let best: SplitCandidate | null = null;

    for (const fi of featureIndices) {
        const values = X.map((row) => row[fi]);
        const unique = [...new Set(values)].sort((a, b) => a - b);
        if (unique.length < 2) continue;

        for (let i = 0; i < unique.length - 1; i++) {
            const threshold = (unique[i] + unique[i + 1]) / 2;
            let leftCount = 0;
            let leftPos = 0;
            for (let j = 0; j < n; j++) {
                if (values[j] <= threshold) {
                    leftCount++;
                    if (y[j] === 1) leftPos++;
                }
            }
            const rightCount = n - leftCount;
            if (leftCount < MIN_SAMPLES_LEAF || rightCount < MIN_SAMPLES_LEAF) continue;

            const leftPosRate = leftPos / leftCount;
            const rightPos = (y.reduce((s, v) => s + v, 0) - leftPos);
            const rightPosRate = rightPos / rightCount;

            const leftGini = 1 - leftPosRate * leftPosRate - (1 - leftPosRate) * (1 - leftPosRate);
            const rightGini = 1 - rightPosRate * rightPosRate - (1 - rightPosRate) * (1 - rightPosRate);
            const gain = parentGini - (leftCount / n) * leftGini - (rightCount / n) * rightGini;

            if (gain > 0 && (!best || gain > best.gain)) {
                best = {
                    gain,
                    featureIndex: fi,
                    threshold,
                    leftMask: values.map((v) => v <= threshold),
                    rightMask: values.map((v) => v > threshold),
                };
            }
        }
    }
    return best;
}

function buildTree(
    X: number[][],
    y: number[],
    depth: number,
    featureIndices: number[],
): CARTNode {
    const count = y.length;
    const posCount = y.reduce((s, v) => s + v, 0);
    const prediction = posCount / count;

    if (depth >= MAX_DEPTH || count < MIN_SAMPLES_LEAF * 2 || gini(y) <= 0) {
        return { prediction, count };
    }

    const split = findBestSplit(X, y, featureIndices);
    if (!split) return { prediction, count };

    const leftX: number[][] = [];
    const leftY: number[] = [];
    const rightX: number[][] = [];
    const rightY: number[] = [];
    for (let j = 0; j < count; j++) {
        if (split.leftMask[j]) {
            leftX.push(X[j]);
            leftY.push(y[j]);
        } else {
            rightX.push(X[j]);
            rightY.push(y[j]);
        }
    }

    return {
        featureIndex: split.featureIndex,
        threshold: split.threshold,
        left: buildTree(leftX, leftY, depth + 1, featureIndices),
        right: buildTree(rightX, rightY, depth + 1, featureIndices),
        prediction,
        count,
    };
}

export function trainCART(X: number[][], y: number[], featureIndices?: number[]): CARTNode {
    const fi = featureIndices ?? Array.from({ length: NUM_FEATURES }, (_, i) => i);
    return buildTree(X, y, 0, fi);
}

export function predictCART(tree: CARTNode, features: number[]): number {
    if (tree.prediction !== undefined && !tree.featureIndex) {
        return tree.prediction;
    }
    if (tree.featureIndex === undefined || tree.threshold === undefined || !tree.left || !tree.right) {
        return tree.prediction ?? 0.5;
    }
    if (features[tree.featureIndex] <= tree.threshold) {
        return predictCART(tree.left, features);
    }
    return predictCART(tree.right, features);
}
