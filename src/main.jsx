/**
 * Vitro Vector Engine v3.0 — React Entry Point
 *
 * Mounts the React App component into the DOM.
 * All application logic is managed by App.jsx.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
