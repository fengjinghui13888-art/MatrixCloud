import { createRoot } from 'react-dom/client';
import { GreyApp as App } from './GreyApp';
import './styles/index.css';
import './styles/liquid-glass.css';
import './styles/reference-light.css';
import './styles/studio-layout.css';
import './styles/workspace-layout.css';
import './styles/customer-usability.css';

createRoot(document.getElementById('root')!).render(<App />);
