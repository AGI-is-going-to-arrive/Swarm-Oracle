import { createRoot } from 'react-dom/client';
import { GalleryApp } from './GalleryApp';

const container = document.getElementById('gallery-root');
if (container) {
  const root = createRoot(container);
  root.render(<GalleryApp />);
}
