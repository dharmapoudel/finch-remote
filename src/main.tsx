import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { ready } from './persist';

// Give the on-device cache a moment to open so the first frame already shows
// the last screens; never wait longer than 400 ms for it.
void Promise.race([ready, new Promise(r => setTimeout(r, 400))]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
