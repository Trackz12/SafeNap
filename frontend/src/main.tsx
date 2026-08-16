import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { reportClientError } from './logging/errorReporter';
import { installDomSafetyNet } from './dom/domSafety';

installDomSafetyNet();

window.addEventListener('error', (event) => {
  reportClientError('global-error', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportClientError('unhandled-promise', event.reason);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
