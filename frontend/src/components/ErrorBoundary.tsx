import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../logging/errorReporter';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

const IS_DEV = import.meta.env?.DEV === true;

export class ErrorBoundary extends Component<Props, State> {
    private componentStack: string | null = null;

    public state: State = {
        hasError: false,
        error: null
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        this.componentStack = errorInfo.componentStack ?? null;
        console.error("ErrorBoundary capturou um erro:", error, errorInfo);
        reportClientError('react-errorboundary', error);
        reportClientError('react-component-stack', new Error(errorInfo.componentStack ?? 'sem stack'));
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="glass-panel" style={{ padding: '2rem', color: 'var(--alarm)' }}>
                    <h2 style={{ textAlign: 'center' }}>Ops! Algo deu errado</h2>
                    <p style={{ color: 'var(--text-muted)', marginBottom: '1rem', textAlign: 'center' }}>
                        Não foi possível carregar este componente. Tente recarregar a página.
                    </p>

                    {IS_DEV && this.state.error && (
                        <pre style={{
                            color: '#e2e8f0',
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid var(--border-default)',
                            borderRadius: '8px',
                            padding: '1rem',
                            fontSize: '0.7rem',
                            lineHeight: 1.4,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: '40vh',
                            overflowY: 'auto'
                        }}>
                            {this.state.error.message}
                            {'\n\n'}
                            {this.componentStack ?? ''}
                        </pre>
                    )}

                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '1rem' }}>
                        <button
                            className="btn btn-primary"
                            onClick={() => {
                                this.setState({ hasError: false, error: null });
                                window.location.reload();
                            }}
                        >
                            Recarregar Aplicação
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}