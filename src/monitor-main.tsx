import React from 'react';
import { createRoot } from 'react-dom/client';
import MonitorApp from './MonitorApp';
import './index.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <MonitorApp />
    </React.StrictMode>
  );
}
