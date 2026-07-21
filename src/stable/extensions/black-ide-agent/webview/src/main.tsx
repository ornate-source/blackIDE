import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ManagerPanel from './ManagerPanel.tsx';
import './index.css';

// The Manager panel shares nothing with App's chat/settings state (LLM config aside,
// which it fetches independently), so it's a fully separate top-level component rather
// than a third branch inside App's already-large internal view switch.
const isManagerPanel = (window as any).isManagerPanel;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isManagerPanel ? <ManagerPanel /> : <App />}
  </React.StrictMode>,
);
