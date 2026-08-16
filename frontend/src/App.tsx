
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
import { Shield } from 'lucide-react';

function App() {
  return (
    <ErrorBoundary>
      <AlertOverlay />
      <header className="app-header">
        <div className="app-header-content">
          <Shield size={40} color="var(--primary)" />
          <div>
            <h1 style={{ margin: 0 }}>SAFENAP Web</h1>
            <p style={{ color: 'var(--text-muted)' }}>Sistema Inteligente de Detecção de Fadiga</p>
          </div>
        </div>
      </header>

      <main className="app-container">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <ErrorBoundary>
            <CalibrationPanel />
          </ErrorBoundary>
          <ErrorBoundary>
            <MlStatusCard />
          </ErrorBoundary>
          <ErrorBoundary>
            <MlTrainingCard />
          </ErrorBoundary>
          <ErrorBoundary>
            <StatusDashboard />
          </ErrorBoundary>
          <ErrorBoundary>
            <Controls />
          </ErrorBoundary>
        </div>
      </main>
    </ErrorBoundary>
  );
}

export default App;
