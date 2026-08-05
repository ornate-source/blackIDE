import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ManagerPanel from './ManagerPanel.tsx';
import FrontDesk from './FrontDesk.tsx';
import './index.css';

// The Manager panel shares nothing with App's chat/settings state (LLM config aside,
// which it fetches independently), so it's a fully separate top-level component rather
// than a third branch inside App's already-large internal view switch. The Front Desk
// (M73) is separate for a stronger reason: it is the same bundle mounted in a sidebar,
// and everything App holds — a conversation, an editor session — is state it must not
// pay for or hold a second copy of.
const isManagerPanel = (window as any).isManagerPanel;
const isOfficeSidebar = (window as any).isOfficeSidebar;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOfficeSidebar ? <FrontDesk /> : isManagerPanel ? <ManagerPanel /> : <App />}
  </React.StrictMode>,
);
