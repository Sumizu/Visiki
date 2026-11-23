import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
const root = createRoot(document.getElementById('root')!);
if (new URLSearchParams(window.location.search).get('visikiEffect') === '1') {
  void import('./daw/effect-window').then(({ DawEffectWindow }) => root.render(<DawEffectWindow />));
} else {
  void import('./workspace-shell').then(({ WorkspaceShell }) => {
    root.render(<React.StrictMode><WorkspaceShell /></React.StrictMode>);
  });
}
