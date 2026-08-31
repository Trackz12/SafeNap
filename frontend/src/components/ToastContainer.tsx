import React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { toast, useToasts } from './toast';

const TYPE_STYLE: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
    success: { icon: <CheckCircle2 size={16} />, color: 'var(--primary)', bg: 'var(--primary-dim)' },
    error: { icon: <XCircle size={16} />, color: 'var(--alarm)', bg: 'var(--alarm-dim)' },
    warning: { icon: <AlertTriangle size={16} />, color: 'var(--warning)', bg: 'var(--warning-dim)' },
    info: { icon: <Info size={16} />, color: 'var(--info)', bg: 'var(--info-dim)' },
};

export const ToastContainer: React.FC = () => {
    const toasts = useToasts();

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 'var(--space-4)',
                right: 'var(--space-4)',
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                maxWidth: 360,
                pointerEvents: 'none',
            }}
        >
            {toasts.map((t) => {
                const style = TYPE_STYLE[t.type] ?? TYPE_STYLE.info;
                return (
                    <div
                        key={t.id}
                        className="animate-fade-in"
                        style={{
                            pointerEvents: 'auto',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-2)',
                            background: 'var(--bg-card)',
                            border: `1px solid ${style.color}40`,
                            borderRadius: 'var(--radius-md)',
                            padding: 'var(--space-3)',
                            fontSize: 'var(--text-sm)',
                            color: 'var(--text-primary)',
                            boxShadow: 'var(--shadow-md)',
                        }}
                    >
                        <span style={{ color: style.color }}>{style.icon}</span>
                        <span style={{ flex: 1 }}>{t.message}</span>
                        <button
                            onClick={() => { toast.__clear(); }}
                            aria-label="Fechar notificação"
                            className="btn btn-icon"
                            style={{ width: 24, height: 24, padding: 0, flexShrink: 0 }}
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
};