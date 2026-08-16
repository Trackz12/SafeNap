export function medianFilter(buffer: number[]): number {
    if (buffer.length === 0) return 0;
    const sorted = [...buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
