import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.tsx';
import Dashboard from './Dashboard.tsx';
import PriceChecker from './PriceChecker.tsx';
import { disableNumberInputScroll } from './lib/disableNumberInputScroll';
import { getTerminalId } from './lib/terminal';
import './index.css';

getTerminalId(); // capture ?terminalId before any in-app navigation drops the query string
disableNumberInputScroll();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/lock" element={<App />} />
        <Route path="/dashboard/*" element={<Dashboard />} />
        <Route path="/price-checker" element={<PriceChecker />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
