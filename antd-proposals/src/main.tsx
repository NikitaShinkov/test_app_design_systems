import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Result } from 'antd';
import { AppProviders } from '@dynamics/ui-shared';

// Placeholder until the Replacement proposals page is added.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders lang="en">
      <Result status="info" title="Replacement Register" subTitle="Page coming next." />
    </AppProviders>
  </StrictMode>,
);
