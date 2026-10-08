import { api } from './api.js';
import { ago, download, h, pickFile, toast } from './ui.js';

export async function showProjects(app) {
  const grid = h('div', { class: 'cards' });
  const importFile = async (file) => {
    if (!file) return;
    try {
      const p = await api.importText(await file.text());
      toast(`Imported “${p.name}”`);
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      toast('Import failed: ' + e.message, true);
    }
  };

  const root = h('div', { class: 'home' },
    h('header', { class: 'home-head' },
      h('h1', null, 'figmore'),
      h('span', { class: 'muted' }, 'Design HTML & CSS visually'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: async () => importFile(await pickFile('.json,application/json')) }, 'Import project…'),
      h('button', { class: 'btn primary', onclick: newProject }, '+ New project')),
    grid);

  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    importFile(e.dataTransfer.files[0]);
  });

  async function newProject() {
    const name = prompt('Project name', 'Untitled project');
    if (name === null) return;
    try {
      const p = await api.create(name);
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function reload() {
    let list;
    try {
      list = await api.list();
    } catch (e) {
      grid.replaceChildren(h('p', { class: 'muted' }, 'Could not load projects: ' + e.message));
      return;
    }
    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        h('p', null, 'No projects yet.'),
        h('p', { class: 'muted' }, 'Create one, or drop a .figmore.json file here to import it.')));
      return;
    }
    grid.replaceChildren(...list.map(card));
  }

  const act = (fn) => async () => {
    try {
      await fn();
      await reload();
    } catch (e) {
      toast(e.message, true);
    }
  };

  function card(p) {
    return h('div', { class: 'card' },
      h('a', { class: 'card-main', href: `#/p/${p.id}` },
        h('div', { class: 'card-name' }, p.name),
        h('div', { class: 'muted' }, 'Edited ' + ago(p.updatedAt))),
      h('div', { class: 'card-actions' },
        h('button', { class: 'link', onclick: act(async () => {
          const n = prompt('Rename project', p.name);
          if (n && n.trim()) await api.save(p.id, { name: n });
        }) }, 'Rename'),
        h('button', { class: 'link', onclick: act(() => api.duplicate(p.id)) }, 'Duplicate'),
        h('button', { class: 'link', onclick: () => download(api.exportUrl(p.id)) }, 'Export'),
        h('button', { class: 'link danger', onclick: act(async () => {
          if (confirm(`Delete “${p.name}”? This cannot be undone.`)) await api.remove(p.id);
        }) }, 'Delete')));
  }

  app.replaceChildren(root);
  await reload();
}
