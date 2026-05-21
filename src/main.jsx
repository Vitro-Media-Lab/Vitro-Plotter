import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Gatekeeper from './components/Gatekeeper.jsx';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <Gatekeeper>
      <App />
    </Gatekeeper>
  );
}
