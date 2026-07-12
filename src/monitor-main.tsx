import React from 'react';
import { createRoot } from 'react-dom/client';
import MonitorApp from './MonitorApp';
import { disableNumberInputScroll } from './lib/disableNumberInputScroll';
import './index.css';

disableNumberInputScroll();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <MonitorApp />
    </React.StrictMode>
  );
}
