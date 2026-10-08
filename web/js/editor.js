import { api } from './api.js';
import { Canvas, resolveZone } from './render.js';
import {
  PALETTE, VOID, cloneWithNewIds, expandBox, find, insertionPoint, makeNode, normalizeDoc,
} from './model.js';
import { download, h, pickFile, toast } from './ui.js';

const VIEWPORTS = [['Fit', ''], ['Desktop 1280', '1280'], ['Tablet 768', '768'], ['Mobile 375', '375'], ['Small 320', '320']];
const FONTS = [
  ['System', 'system-ui, sans-serif'], ['Serif', 'Georgia, serif'], ['Monospace', 'ui-monospace, Menlo, monospace'],
  ['Arial', 'Arial, Helvetica, sans-serif'], ['Times', '"Times New Roman", serif'],
];
const SIZE_OPTS = ['auto', '100%', '50%', 'fit-content', 'min-content', 'max-content', '100vh', '100vw'];
const LEN_OPTS = ['0', '4px', '8px', '16px', '24px', '32px', 'auto'];

export async function openEditor(app, projectId) {
  let loaded;
  try {
    loaded = await api.get(projectId);
  } catch (e) {
    toast('Cannot open project: ' + e.message, true);
    location.hash = '';
    return null;
  }

  const S = {
    project: loaded.project,
    doc: normalizeDoc(loaded.doc),
    selId: 'root',
    state: 'normal', // 'normal' | 'hover': which style set the panel edits
    mode: 'edit',
    collapsed: new Set(),
    clip: null,
    drag: null,
  };
  const history = { undo: [], redo: [], key: null, t: 0 };
  const sel = () => find(S.doc.root, S.selId)?.node || S.doc.root;
  const snapshot = () => JSON.stringify(S.doc);

  // ---------- persistence ----------
  let dirty = false;
  let saveTimer = null;
  let saving = Promise.resolve();
  const status = h('span', { class: 'muted status' }, 'Saved');
  const setStatus = (t, err) => {
    status.textContent = t;
    status.classList.toggle('err', !!err);
  };
  function scheduleSave() {
    dirty = true;
    setStatus('Unsaved changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }
  function flush() {
    clearTimeout(saveTimer);
    if (!dirty) return saving;
    dirty = false;
    setStatus('Saving…');
    const body = { doc: S.doc };
    saving = saving.then(() => api.save(projectId, body)).then(
      (p) => { S.project = p; if (!dirty) setStatus('Saved'); },
      (e) => { dirty = true; setStatus('Save failed: ' + e.message, true); saveTimer = setTimeout(flush, 5000); });
    return saving;
  }
  const onUnload = () => {
    if (dirty) api.save(projectId, { doc: S.doc }, { keepalive: true }).catch(() => {});
  };
  window.addEventListener('beforeunload', onUnload);

  // ---------- mutations & history ----------
  function mutate(fn, key) {
    const now = Date.now();
    if (!(key && key === history.key && now - history.t < 1000)) {
      history.undo.push(snapshot());
      if (history.undo.length > 100) history.undo.shift();
    }
    history.key = key || null;
    history.t = now;
    history.redo = [];
    fn();
    changed();
  }
  function changed() {
    renderCanvas();
    renderTree();
    updateTopbar();
    scheduleSave();
  }
  function restore(snap) {
    S.doc = normalizeDoc(JSON.parse(snap));
    if (!find(S.doc.root, S.selId)) S.selId = 'root';
    history.key = null;
    changed();
    buildPanel();
  }
  function undo() {
    if (!history.undo.length) return;
    history.redo.push(snapshot());
    restore(history.undo.pop());
  }
  function redo() {
    if (!history.redo.length) return;
    history.undo.push(snapshot());
    restore(history.redo.pop());
  }

  // ---------- tree operations ----------
  function select(id) {
    S.selId = id;
    renderCanvas();
    renderTree();
    buildPanel();
  }
  function place(target, zone, node) {
    if (zone === 'inside') return void target.node.children.push(node);
    const { parent, index } = target;
    parent.children.splice(zone === 'before' ? index : index + 1, 0, node);
  }
  function insertNode(node, parent, index) {
    mutate(() => parent.children.splice(index, 0, node));
    S.selId = node.id;
    S.collapsed.delete(parent.id);
    renderCanvas();
    renderTree();
    buildPanel();
  }
  function addFromPalette(entry) {
    const node = makeNode(entry);
    let pt = insertionPoint(S.doc.root, S.selId, entry.tag);
    let toInsert = node;
    if (!pt) { // e.g. <li> with no list around: wrap it in a <ul>
      pt = insertionPoint(S.doc.root, S.selId, 'ul');
      toInsert = makeNode({ tag: 'ul' });
      toInsert.children.push(node);
    }
    if (pt) insertNode(toInsert, pt.parent, pt.index);
  }
  function moveTo(id, targetId, zone) {
    const m = find(S.doc.root, id);
    mutate(() => {
      m.parent.children.splice(m.index, 1);
      const t = find(S.doc.root, targetId); // re-resolve: indices shifted after removal
      place(t, zone, m.node);
    });
    S.selId = id;
    renderCanvas();
    renderTree();
    buildPanel();
  }
  function deleteSel() {
    const f = find(S.doc.root, S.selId);
    if (!f || !f.parent) return;
    const next = f.parent.children[f.index + 1] || f.parent.children[f.index - 1] || f.parent;
    mutate(() => f.parent.children.splice(f.index, 1));
    select(next.id);
  }
  function duplicateSel() {
    const f = find(S.doc.root, S.selId);
    if (!f || !f.parent) return;
    const c = cloneWithNewIds(f.node);
    insertNode(c, f.parent, f.index + 1);
  }
  function shiftSel(d) {
    const f = find(S.doc.root, S.selId);
    if (!f || !f.parent) return;
    const j = f.index + d;
    if (j < 0 || j >= f.parent.children.length) return;
    mutate(() => {
      const a = f.parent.children;
      [a[f.index], a[j]] = [a[j], a[f.index]];
    });
    renderTree();
  }
  function wrapSel() {
    const f = find(S.doc.root, S.selId);
    if (!f || !f.parent) return;
    const w = makeNode({ tag: 'div', style: { display: 'flex', 'flex-direction': 'row', gap: '8px' } });
    mutate(() => {
      w.children.push(f.node);
      f.parent.children[f.index] = w;
    });
    select(w.id);
  }
  function paste() {
    if (!S.clip) return;
    const node = cloneWithNewIds(S.clip);
    const pt = insertionPoint(S.doc.root, S.selId, node.tag);
    if (pt) insertNode(node, pt.parent, pt.index);
  }

  // ---------- drag & drop (shared by palette, tree and canvas) ----------
  const dragTag = () => S.drag?.entry?.tag || (S.drag?.nodeId && find(S.doc.root, S.drag.nodeId)?.node.tag);
  function dropZone(targetId, raw) {
    const tag = dragTag();
    return tag ? resolveZone(S.doc, targetId, raw, tag, S.drag.nodeId) : null;
  }
  function drop(targetId, zone) {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (d.nodeId) return moveTo(d.nodeId, targetId, zone);
    const node = makeNode(d.entry);
    mutate(() => place(find(S.doc.root, targetId), zone, node));
    S.selId = node.id;
    renderCanvas();
    renderTree();
    buildPanel();
  }

  // ---------- canvas ----------
  const host = h('div', { class: 'page-host' });
  const scroller = h('div', { class: 'canvas-scroll' }, host);
  const canvas = new Canvas(host, {
    select,
    hover: (id) => hoverTree(id),
    dragStart: (id) => { S.drag = { nodeId: id }; },
    dropZone,
    drop: (id, zone) => drop(id, zone),
  });
  function renderCanvas() {
    canvas.render(S.doc, {
      mode: S.mode,
      selId: S.selId,
      forceHoverId: S.state === 'hover' ? S.selId : null,
    });
  }
  function setWidth(w) {
    host.style.width = w ? w + 'px' : '100%';
  }

  // ---------- layers ----------
  const treeEl = h('div', { class: 'tree' });
  function hoverTree(id) {
    treeEl.querySelectorAll('.hl').forEach((r) => r.classList.remove('hl'));
    if (id) [...treeEl.children].find((r) => r.dataset.id === id)?.classList.add('hl');
  }
  function label(n) {
    if (n.text) return n.text.length > 24 ? n.text.slice(0, 24) + '…' : n.text;
    if (n.attrs.id) return '#' + n.attrs.id;
    if (n.attrs.class) return '.' + n.attrs.class.split(/\s+/)[0];
    return '';
  }
  function renderTree() {
    const rows = [];
    (function walk(n, depth) {
      const isRoot = n.id === 'root';
      const caret = n.children.length
        ? h('span', {
          class: 'caret',
          onclick: (e) => {
            e.stopPropagation();
            S.collapsed.has(n.id) ? S.collapsed.delete(n.id) : S.collapsed.add(n.id);
            renderTree();
          },
        }, S.collapsed.has(n.id) ? '▸' : '▾')
        : h('span', { class: 'caret' });
      const row = h('div', {
        class: 'tree-row' + (n.id === S.selId ? ' sel' : ''),
        'data-id': n.id,
        draggable: !isRoot,
        style: { paddingLeft: 6 + depth * 14 + 'px' },
        onclick: () => select(n.id),
        onmouseenter: () => canvas.setHover(n.id),
        onmouseleave: () => canvas.setHover(null),
        ondragstart: (e) => {
          S.drag = { nodeId: n.id };
          e.dataTransfer.setData('text/figmore-node', n.id);
          e.dataTransfer.effectAllowed = 'move';
        },
        ondragover: (e) => {
          const z = dropZone(n.id, rowZone(row, e));
          clearDrop();
          if (!z) return;
          e.preventDefault();
          row.dataset.drop = z;
        },
        ondragleave: () => delete row.dataset.drop,
        ondrop: (e) => {
          const z = dropZone(n.id, rowZone(row, e));
          clearDrop();
          if (!z) return;
          e.preventDefault();
          drop(n.id, z);
        },
        ondragend: () => { S.drag = null; clearDrop(); },
      }, caret, h('span', { class: 'tag' }, isRoot ? 'body' : n.tag), h('span', { class: 'lbl' }, label(n)));
      rows.push(row);
      if (!S.collapsed.has(n.id)) n.children.forEach((c) => walk(c, depth + 1));
    })(S.doc.root, 0);
    treeEl.replaceChildren(...rows);
  }
  const clearDrop = () => treeEl.querySelectorAll('[data-drop]').forEach((r) => delete r.dataset.drop);
  function rowZone(row, e) {
    const r = row.getBoundingClientRect();
    const p = (e.clientY - r.top) / r.height;
    return p < 0.25 ? 'before' : p > 0.75 ? 'after' : 'inside';
  }

  // ---------- palette ----------
  const paletteEl = h('div', { class: 'palette' });
  let lastGroup = '';
  for (const entry of PALETTE) {
    if (entry.group !== lastGroup) {
      paletteEl.append(h('div', { class: 'pgroup' }, entry.group));
      lastGroup = entry.group;
    }
    paletteEl.append(h('button', {
      class: 'pitem',
      draggable: true,
      title: `Add <${entry.tag}> — click or drag onto the canvas / layers`,
      onclick: () => addFromPalette(entry),
      ondragstart: (e) => {
        S.drag = { entry };
        e.dataTransfer.setData('text/figmore-tag', entry.tag);
        e.dataTransfer.effectAllowed = 'copy';
      },
      ondragend: () => { S.drag = null; },
    }, entry.label));
  }

  // ---------- properties panel ----------
  const panelEl = h('div', { class: 'panel' });
  const curStyle = () => (S.state === 'hover' ? sel().hover : sel().style);

  function setProp(prop, val, key) {
    mutate(() => {
      const o = curStyle();
      if (val === '' || val == null) delete o[prop];
      else o[prop] = val;
    }, key ? 'p:' + S.selId + S.state + prop : null);
  }
  function setAttr(name, val, key) {
    mutate(() => {
      const a = sel().attrs;
      if (val === '' || val == null) delete a[name];
      else a[name] = val;
    }, key ? 'a:' + S.selId + name : null);
  }

  let handled;
  const prow = (name, ...ctl) => h('div', { class: 'prow' }, h('label', null, name), h('div', { class: 'ctl' }, ...ctl));
  const baseVal = (prop) => (S.state === 'hover' ? sel().style[prop] : undefined);

  function textCtl(prop, opts) {
    handled.add(prop);
    const inp = h('input', {
      type: 'text',
      value: curStyle()[prop] ?? '',
      placeholder: baseVal(prop) ?? '',
      oninput: () => setProp(prop, inp.value.trim(), true),
    });
    const out = [inp];
    if (opts) {
      const id = 'dl-' + prop;
      inp.setAttribute('list', id);
      out.push(h('datalist', { id }, opts.map((o) => h('option', { value: o }))));
    }
    return out;
  }
  function selectCtl(prop, opts, rebuild) {
    handled.add(prop);
    const v = curStyle()[prop] ?? '';
    const known = opts.some((o) => o[0] === v);
    const s = h('select', {
      onchange: () => {
        setProp(prop, s.value);
        if (rebuild) buildPanel();
      },
    }, h('option', { value: '' }, baseVal(prop) ? `(${baseVal(prop)})` : '—'),
    !known && v ? h('option', { value: v, selected: true }, v) : null,
    opts.map(([val, name]) => h('option', { value: val, selected: val === v }, name || val)));
    return [s];
  }
  function segCtl(prop, items, rebuild) {
    handled.add(prop);
    const wrap = h('div', { class: 'seg' });
    const paint = () => [...wrap.children].forEach((b, i) => b.classList.toggle('on', curStyle()[prop] === items[i][0]));
    items.forEach(([val, text, title]) => wrap.append(h('button', {
      title: title || val,
      onclick: () => {
        setProp(prop, curStyle()[prop] === val ? '' : val);
        if (rebuild) buildPanel();
        else paint();
      },
    }, text || val)));
    paint();
    return [wrap];
  }
  const HEX = /^#[0-9a-f]{6}$/i;
  function colorCtl(prop) {
    handled.add(prop);
    const v = curStyle()[prop] ?? '';
    const txt = h('input', { type: 'text', value: v, placeholder: baseVal(prop) ?? '', oninput: () => {
      setProp(prop, txt.value.trim(), true);
      if (HEX.test(txt.value.trim())) pick.value = txt.value.trim();
    } });
    const pick = h('input', { type: 'color', value: HEX.test(v) ? v : '#000000', oninput: () => {
      txt.value = pick.value;
      setProp(prop, pick.value, true);
    } });
    return [pick, txt];
  }
  function sidesCtl(prop) {
    handled.add(prop);
    const sides = ['top', 'right', 'bottom', 'left'];
    sides.forEach((s) => handled.add(`${prop}-${s}`));
    const o = curStyle();
    const short = o[prop] ? expandBox(o[prop]) : null;
    const all = h('input', { type: 'text', class: 'all', value: o[prop] ?? '', placeholder: 'all',
      oninput: () => mutate(() => {
        const st = curStyle();
        sides.forEach((s) => delete st[`${prop}-${s}`]);
        if (all.value.trim()) st[prop] = all.value.trim();
        else delete st[prop];
        sideInputs.forEach((i) => { i.value = ''; });
      }, 'b:' + prop) });
    const sideInputs = sides.map((s) => {
      const inp = h('input', { type: 'text', value: o[`${prop}-${s}`] ?? (short ? short[s] : ''), placeholder: s[0].toUpperCase(), title: `${prop}-${s}`,
        oninput: () => mutate(() => {
          const st = curStyle();
          if (st[prop]) { // expand shorthand into longhands before editing a single side
            const e = expandBox(st[prop]);
            sides.forEach((x) => { st[`${prop}-${x}`] = e[x]; });
            delete st[prop];
            all.value = '';
          }
          if (inp.value.trim()) st[`${prop}-${s}`] = inp.value.trim();
          else delete st[`${prop}-${s}`];
        }, 'b:' + prop + s) });
      return inp;
    });
    return [h('div', { class: 'sides' }, all, h('div', { class: 'four' }, sideInputs))];
  }

  function section(title, ...rows) {
    const body = rows.flat().filter(Boolean);
    return h('details', { class: 'sect', open: true }, h('summary', null, title), h('div', { class: 'sect-body' }, body));
  }

  function attrRow(name, label, opts = {}) {
    const n = sel();
    const make = () => {
      if (opts.options) {
        const s = h('select', { onchange: () => setAttr(name, s.value) },
          h('option', { value: '' }, '—'),
          opts.options.map((o) => h('option', { value: o, selected: n.attrs[name] === o }, o)));
        return s;
      }
      const inp = h('input', { type: 'text', value: n.attrs[name] ?? '', placeholder: opts.placeholder || '',
        oninput: () => setAttr(name, inp.value, true) });
      return inp;
    };
    return prow(label || name, make());
  }

  function buildPanel() {
    handled = new Set();
    const n = sel();
    const isRoot = n.id === 'root';
    const parent = find(S.doc.root, n.id)?.parent;
    const parentFlex = parent && /flex/.test(parent.style.display || '');
    const disp = curStyle().display || (S.state === 'hover' ? sel().style.display : '') || '';
    const isFlex = /flex/.test(disp);

    const head = h('div', { class: 'phead' },
      h('div', { class: 'ptitle' }, isRoot ? 'Page (body)' : `<${n.tag}>`),
      h('div', { class: 'tools' },
        h('button', { title: 'Move up (Alt+↑)', disabled: isRoot, onclick: () => shiftSel(-1) }, '↑'),
        h('button', { title: 'Move down (Alt+↓)', disabled: isRoot, onclick: () => shiftSel(1) }, '↓'),
        h('button', { title: 'Wrap in a flex row (Ctrl+G)', disabled: isRoot, onclick: wrapSel }, '⧉'),
        h('button', { title: 'Duplicate (Ctrl+D)', disabled: isRoot, onclick: duplicateSel }, '⎘'),
        h('button', { title: 'Delete (Del)', class: 'danger', disabled: isRoot, onclick: deleteSel }, '🗑')),
      h('div', { class: 'state' },
        ['normal', 'hover'].map((s) => h('button', {
          class: S.state === s ? 'on' : '',
          title: s === 'hover' ? 'Edit the :hover style (forces the hover look on the canvas)' : 'Edit the base style',
          onclick: () => { S.state = s; renderCanvas(); buildPanel(); },
        }, s === 'hover' ? ':hover' : 'Normal'))),
      S.state === 'hover' ? h('div', { class: 'hint' }, 'Editing :hover — only the properties you set here override the normal style on hover.') : null);

    const sections = [head];

    // Content & attributes (only in the normal state)
    if (S.state === 'normal') {
      const rows = [];
      if (!isRoot) {
        const tags = VOID.has(n.tag) ? PALETTE.filter((p) => VOID.has(p.tag)) : PALETTE.filter((p) => !VOID.has(p.tag) && p.tag !== 'li' && p.tag !== 'ul' && p.tag !== 'ol');
        const keepTags = ['li', 'ul', 'ol'].includes(n.tag) ? [] : [...new Set(tags.map((p) => p.tag))];
        if (keepTags.length) {
          rows.push(prow('Tag', h('select', { onchange: (e) => mutate(() => { n.tag = e.target.value; }) },
            keepTags.map((t) => h('option', { value: t, selected: t === n.tag }, t)))));
        }
      }
      if (!VOID.has(n.tag) && !isRoot) {
        const ta = h('textarea', { rows: 2, value: n.text || '', placeholder: 'Text content',
          oninput: () => mutate(() => { if (ta.value) n.text = ta.value; else delete n.text; }, 't:' + n.id) });
        rows.push(prow('Text', ta));
      }
      if (n.tag === 'a') rows.push(attrRow('href'), attrRow('target', 'target', { options: ['_blank', '_self'] }));
      if (n.tag === 'img') {
        rows.push(attrRow('src', 'src', { placeholder: 'URL or upload' }), attrRow('alt'));
        rows.push(prow('', h('button', { class: 'btn small', onclick: async () => {
          const f = await pickFile('image/*');
          if (!f) return;
          if (f.size > 3 * 1024 * 1024) return toast('Image too large (max 3 MB)', true);
          const r = new FileReader();
          r.onload = () => { setAttr('src', r.result); buildPanel(); };
          r.readAsDataURL(f);
        } }, 'Upload image…')));
      }
      if (n.tag === 'input') {
        rows.push(attrRow('type', 'type', { options: ['text', 'email', 'password', 'number', 'search', 'tel', 'url', 'date', 'checkbox', 'radio', 'submit'] }),
          attrRow('placeholder'), attrRow('value'), attrRow('name'));
      }
      if (n.tag === 'textarea') rows.push(attrRow('placeholder'), attrRow('name'));
      if (n.tag === 'button') rows.push(attrRow('type', 'type', { options: ['button', 'submit', 'reset'] }));
      if (n.tag === 'label') rows.push(attrRow('for'));
      if (n.tag === 'form') rows.push(attrRow('action'), attrRow('method', 'method', { options: ['get', 'post'] }));
      if (!isRoot) rows.push(attrRow('id'), attrRow('class'), attrRow('title'));
      if (rows.length) sections.push(section('Content & attributes', rows));
    }

    sections.push(section('Layout',
      prow('Display', segCtl('display', [['block', 'block'], ['flex', 'flex'], ['inline', 'inline'], ['inline-flex', 'i-flex'], ['grid', 'grid'], ['none', 'none']], true)),
      isFlex ? [
        prow('Direction', segCtl('flex-direction', [['row', '→', 'row'], ['column', '↓', 'column'], ['row-reverse', '←', 'row-reverse'], ['column-reverse', '↑', 'column-reverse']])),
        prow('Wrap', segCtl('flex-wrap', [['nowrap', 'no wrap'], ['wrap', 'wrap'], ['wrap-reverse', 'reverse']])),
        prow('Justify', selectCtl('justify-content', ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'].map((v) => [v]))),
        prow('Align', selectCtl('align-items', ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'].map((v) => [v]))),
        prow('Align lines', selectCtl('align-content', ['stretch', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around'].map((v) => [v]))),
      ] : null,
      /flex|grid/.test(disp) ? [prow('Gap', textCtl('gap', LEN_OPTS)), prow('Row gap', textCtl('row-gap')), prow('Col gap', textCtl('column-gap'))] : null,
      /grid/.test(disp) ? [prow('Columns', textCtl('grid-template-columns', ['repeat(3, 1fr)', '1fr 1fr', '200px 1fr'])), prow('Rows', textCtl('grid-template-rows'))] : null));

    if (parentFlex && !isRoot) {
      sections.push(section('Flex item',
        prow('Grow', textCtl('flex-grow', ['0', '1'])),
        prow('Shrink', textCtl('flex-shrink', ['0', '1'])),
        prow('Basis', textCtl('flex-basis', ['auto', '0', '50%', '200px'])),
        prow('Align self', selectCtl('align-self', ['auto', 'flex-start', 'center', 'flex-end', 'stretch', 'baseline'].map((v) => [v]))),
        prow('Order', textCtl('order'))));
    }

    sections.push(section('Size',
      prow('Width', textCtl('width', SIZE_OPTS)), prow('Height', textCtl('height', SIZE_OPTS)),
      prow('Min W', textCtl('min-width')), prow('Max W', textCtl('max-width')),
      prow('Min H', textCtl('min-height')), prow('Max H', textCtl('max-height')),
      prow('Box sizing', selectCtl('box-sizing', [['border-box'], ['content-box']])),
      prow('Overflow', selectCtl('overflow', ['visible', 'hidden', 'auto', 'scroll'].map((v) => [v])))));

    sections.push(section('Spacing', prow('Margin', sidesCtl('margin')), prow('Padding', sidesCtl('padding'))));

    sections.push(section('Position',
      prow('Position', selectCtl('position', ['static', 'relative', 'absolute', 'fixed', 'sticky'].map((v) => [v]))),
      prow('Top', textCtl('top')), prow('Right', textCtl('right')), prow('Bottom', textCtl('bottom')), prow('Left', textCtl('left')),
      prow('Z-index', textCtl('z-index'))));

    sections.push(section('Typography',
      prow('Font', selectCtl('font-family', FONTS.map(([name, v]) => [v, name]))),
      prow('Size', textCtl('font-size', ['12px', '14px', '16px', '20px', '24px', '32px', '48px'])),
      prow('Weight', selectCtl('font-weight', [['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['900', 'Black']])),
      prow('Line height', textCtl('line-height', ['1', '1.2', '1.5', '1.8'])),
      prow('Spacing', textCtl('letter-spacing')),
      prow('Align', segCtl('text-align', [['left', '⇤'], ['center', '↔'], ['right', '⇥'], ['justify', '☰']])),
      prow('Decoration', selectCtl('text-decoration', ['none', 'underline', 'line-through', 'overline'].map((v) => [v]))),
      prow('Transform', selectCtl('text-transform', ['none', 'uppercase', 'lowercase', 'capitalize'].map((v) => [v]))),
      prow('Color', colorCtl('color'))));

    sections.push(section('Background',
      prow('Color', colorCtl('background-color')),
      prow('Image', textCtl('background-image', ['linear-gradient(90deg, #667eea, #764ba2)', 'url(...)'])),
      prow('Size', selectCtl('background-size', ['cover', 'contain', 'auto'].map((v) => [v]))),
      prow('Position', textCtl('background-position', ['center', 'top', 'bottom', 'left', 'right']))));

    sections.push(section('Border',
      prow('Width', textCtl('border-width', ['0', '1px', '2px', '4px'])),
      prow('Style', selectCtl('border-style', ['none', 'solid', 'dashed', 'dotted', 'double'].map((v) => [v]))),
      prow('Color', colorCtl('border-color')),
      prow('Radius', textCtl('border-radius', ['0', '4px', '8px', '16px', '9999px']))));

    sections.push(section('Effects',
      prow('Opacity', textCtl('opacity', ['1', '0.8', '0.5', '0'])),
      prow('Shadow', textCtl('box-shadow', ['0 2px 8px rgba(0,0,0,.2)', '0 8px 24px rgba(0,0,0,.25)', 'none'])),
      prow('Transform', textCtl('transform', ['scale(1.05)', 'translateY(-2px)', 'rotate(3deg)'])),
      prow('Transition', textCtl('transition', ['all .2s ease', 'background-color .2s', 'transform .15s'])),
      prow('Cursor', selectCtl('cursor', ['pointer', 'default', 'text', 'move', 'not-allowed', 'grab'].map((v) => [v])))));

    // Anything not covered by a field above: freeform property editor.
    const extras = Object.keys(curStyle()).filter((p) => !handled.has(p));
    const list = h('div', { class: 'custom' });
    const customRow = (p, v) => {
      let prop = p;
      const pi = h('input', { type: 'text', value: p, placeholder: 'property' });
      const vi = h('input', { type: 'text', value: v, placeholder: 'value' });
      const commit = (key) => {
        const np = pi.value.trim().toLowerCase();
        const nv = vi.value.trim();
        mutate(() => {
          const o = curStyle();
          if (prop && prop !== np) delete o[prop];
          if (np && nv) o[np] = nv;
          else if (np) delete o[np];
          prop = np;
        }, key);
      };
      pi.addEventListener('change', () => commit());
      vi.addEventListener('input', () => commit('c:' + S.selId + S.state + (prop || 'new')));
      return h('div', { class: 'crow' }, pi, vi, h('button', { title: 'Remove', onclick: (e) => {
        mutate(() => { delete curStyle()[prop]; });
        e.target.closest('.crow').remove();
      } }, '×'));
    };
    extras.forEach((p) => list.append(customRow(p, curStyle()[p])));
    sections.push(section('Custom CSS', list, h('button', { class: 'btn small', onclick: () => list.append(customRow('', '')) }, '+ Add property')));

    panelEl.replaceChildren(...sections);
  }

  // ---------- top bar ----------
  const undoBtn = h('button', { class: 'btn', title: 'Undo (Ctrl+Z)', onclick: undo }, '↶');
  const redoBtn = h('button', { class: 'btn', title: 'Redo (Ctrl+Shift+Z)', onclick: redo }, '↷');
  const nameInp = h('input', { class: 'name', value: S.project.name, title: 'Rename project',
    onchange: async () => {
      const name = nameInp.value.trim();
      if (!name) { nameInp.value = S.project.name; return; }
      try { S.project = await api.save(projectId, { name }); } catch (e) { toast(e.message, true); nameInp.value = S.project.name; }
    } });
  const modeBtn = h('button', { class: 'btn', title: 'Toggle preview (real hover & links, no outlines)', onclick: () => {
    S.mode = S.mode === 'edit' ? 'preview' : 'edit';
    modeBtn.classList.toggle('on', S.mode === 'preview');
    modeBtn.textContent = S.mode === 'preview' ? '✎ Edit' : '▶ Preview';
    renderCanvas();
  } }, '▶ Preview');
  function updateTopbar() {
    undoBtn.disabled = !history.undo.length;
    redoBtn.disabled = !history.redo.length;
  }

  const top = h('header', { class: 'topbar' },
    h('a', { class: 'btn', href: '#', title: 'Back to projects' }, '← Projects'),
    nameInp,
    undoBtn, redoBtn,
    h('div', { class: 'spacer' }),
    h('select', { title: 'Canvas width', onchange: (e) => setWidth(e.target.value) },
      VIEWPORTS.map(([n, v]) => h('option', { value: v }, n))),
    modeBtn,
    h('button', { class: 'btn', onclick: async () => { await flush(); download(api.exportUrl(projectId)); } }, 'Export JSON'),
    status);

  const left = h('aside', { class: 'left' },
    h('div', { class: 'ltitle' }, 'Elements'), paletteEl,
    h('div', { class: 'ltitle' }, 'Layers'), treeEl);
  const layout = h('div', { class: 'editor' }, top, h('div', { class: 'cols' }, left, scroller, h('aside', { class: 'right' }, panelEl)));
  app.replaceChildren(layout);

  // ---------- keyboard ----------
  const onKey = (e) => {
    const t = e.target;
    if (t.matches?.('input,textarea,select,[contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'd') { e.preventDefault(); duplicateSel(); }
    else if (mod && k === 'g') { e.preventDefault(); wrapSel(); }
    else if (mod && k === 'c') { const f = find(S.doc.root, S.selId); if (f?.parent) S.clip = JSON.parse(JSON.stringify(f.node)); }
    else if (mod && k === 'v') { e.preventDefault(); paste(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); shiftSel(-1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); shiftSel(1); }
    else if (e.key === 'Escape') {
      const f = find(S.doc.root, S.selId);
      if (f?.parent) select(f.parent.id);
    }
  };
  document.addEventListener('keydown', onKey);

  setWidth('');
  renderCanvas();
  renderTree();
  buildPanel();
  updateTopbar();
  document.title = 'figmore';

  return {
    async close() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
      await flush();
    },
  };
}
