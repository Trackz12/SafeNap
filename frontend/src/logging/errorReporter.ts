import { getApiUrl } from '../config/api';

const reportedKeys = new Set<string>();

export function reportClientError(context: string, error: unknown): void {
    try {
        const err = error instanceof Error ? error : new Error(String(error));
        const key = `${context}::${err.name}::${err.message}`;
        if (reportedKeys.has(key)) return;
        reportedKeys.add(key);

        const payload = {
            context,
            message: `${err.name}: ${err.message}`,
            stack: err.stack ?? '',
            userAgent: navigator.userAgent
        };

        const send = () => {
            fetch(`${getApiUrl()}/client-error`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true
            }).catch(() => { });
        };

        if (document.visibilityState === 'hidden') {
            send();
        } else {
            setTimeout(send, 0);
        }
    } catch {
        // Nunca deixar o reporter quebrar o app
    }
}
