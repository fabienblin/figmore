import { showProjects } from './projects.js';
import { openEditor } from './editor.js';

const app = document.getElementById('app');
let current = null;

async function route() {
  if (current) {
    await current.close?.();
    current = null;
  }
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) current = await openEditor(app, m[1]);
  else await showProjects(app);
}

window.addEventListener('hashchange', route);
route();
