import type { Page } from '@playwright/test';

/**
 * Mocka getUserMedia com um stream sintético (canvas animado).
 * Permite testar o fluxo da câmera em CI sem webcam.
 */
export async function mockCamera(page: Page): Promise<void> {
    await page.addInitScript(() => {
        // Canvas que gera frames continuamente (vídeo fake 640x480)
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d')!;
        let t = 0;
        setInterval(() => {
            t += 0.1;
            ctx.fillStyle = `hsl(${t % 360}, 40%, 50%)`;
            ctx.fillRect(0, 0, 640, 480);
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(320, 240, 80, 0, Math.PI * 2);
            ctx.fill();
        }, 33);

        const stream = (canvas as HTMLCanvasElement).captureStream(30);

        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
            value: async () => stream,
            configurable: true,
        });
    });
}
