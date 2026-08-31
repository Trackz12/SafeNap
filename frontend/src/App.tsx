
import { CameraView } from './components/CameraView';
import { StatusGauge } from './components/StatusGauge';
import { LiveChart } from './components/LiveChart';
import { SessionStatsPanel } from './components/SessionStatsPanel';
import { StatusDashboard } from './components/StatusDashboard';
import { Controls } from './components/Controls';
import { CalibrationPanel } from './components/CalibrationPanel';
import { AlertOverlay } from './components/AlertOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MlStatusCard } from './components/MlStatusCard';
import { MlTrainingCard } from './components/MlTrainingCard';
import { ToastContainer } from './components/ToastContainer';
import { Shield } from 'lucide-react';

function App() {
  return (
    <ErrorBoundary>
      <AlertOverlay />
      <ToastContainer />
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header-inner">
            <div className="app-header-left">
              <div style={{
                width: 32,
                height: 32,
                borderRadius: 'var(--radius-md)',
                background: 'var(--primary-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Shield size={18} color="var(--primary)" />
              </div>
              <div>
                <h1 style={{
                  margin: 0,
                  fontSize: 'var(--text-md)',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: 'var(--text-primary)',
                }}>SafeNap</h1>
                <p style={{
                  margin: 0,
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)',
                  letterSpacing: '0.02em',
                }}>Sistema Inteligente de Detecção de Fadiga</p>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <StatusDashboard />
            </div>
          </div>
        </header>

        <main className="app-container">
          <div className="app-main stagger">
            <ErrorBoundary>
              <StatusGauge />
            </ErrorBoundary>
            <ErrorBoundary>
              <CameraView />
            </ErrorBoundary>
            <ErrorBoundary>
              <LiveChart />
            </ErrorBoundary>
            <ErrorBoundary>
              <SessionStatsPanel />
            </ErrorBoundary>
          </div>

          <div className="app-sidebar stagger">
            <ErrorBoundary>
              <CalibrationPanel />
            </ErrorBoundary>
            <ErrorBoundary>
              <Controls />
            </ErrorBoundary>
            <ErrorBoundary>
              <MlStatusCard />
            </ErrorBoundary>
            <ErrorBoundary>
              <MlTrainingCard />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}

export default App;
