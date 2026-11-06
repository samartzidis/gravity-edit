import React from 'react';
import {createRoot} from 'react-dom/client';

import {Editor} from './Editor';
import {ErrorBoundary} from './ErrorBoundary';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(
  <ErrorBoundary>
    <Editor />
  </ErrorBoundary>,
);
