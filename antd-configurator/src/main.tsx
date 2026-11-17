import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '@dynamics/ui-shared';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders lang="ru">
      <App />
    </AppProviders>
  </StrictMode>,
);
