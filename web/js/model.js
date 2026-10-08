// Document model: a tree of nodes {id, tag, text, attrs, style, hover, children}.

export const VOID = new Set(['img', 'input', 'hr']);
const PHRASING = new Set(['span', 'a', 'img', 'input', 'button', 'label', 'textarea']);
const TEXT_PARENTS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'button']);

export function canContain(parentTag, childTag) {
  if (VOID.has(parentTag) || parentTag === 'textarea') return false;
  if (parentTag === 'ul' || parentTag === 'ol') return childTag === 'li';
  if (childTag === 'li') return false;
  if (TEXT_PARENTS.has(parentTag)) return PHRASING.has(childTag);
  return true;
}

const PLACEHOLDER_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140">' +
      '<rect width="240" height="140" fill="#e5e7eb"/><path d="M60 100l40-45 30 30 20-20 40 35z" fill="#9ca3af"/>' +
      '<circle cx="80" cy="45" r="12" fill="#9ca3af"/></svg>'
  );

const btn = { padding: '8px 16px', cursor: 'pointer' };

// Palette entries: group, tag, label and default content/styles.
export const PALETTE = [
  { group: 'Containers', key: 'row', tag: 'div', label: 'Row', style: { display: 'flex', 'flex-direction': 'row', gap: '8px' } },
  { group: 'Containers', key: 'column', tag: 'div', label: 'Column', style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } },
  { group: 'Containers', tag: 'div', label: 'div' },
  { group: 'Containers', tag: 'section', label: 'section' },
  { group: 'Containers', tag: 'header', label: 'header' },
  { group: 'Containers', tag: 'nav', label: 'nav' },
  { group: 'Containers', tag: 'main', label: 'main' },
  { group: 'Containers', tag: 'article', label: 'article' },
  { group: 'Containers', tag: 'aside', label: 'aside' },
  { group: 'Containers', tag: 'footer', label: 'footer' },
  { group: 'Containers', tag: 'form', label: 'form' },
  { group: 'Text', tag: 'h1', label: 'h1', text: 'Heading 1' },
  { group: 'Text', tag: 'h2', label: 'h2', text: 'Heading 2' },
  { group: 'Text', tag: 'h3', label: 'h3', text: 'Heading 3' },
  { group: 'Text', tag: 'h4', label: 'h4', text: 'Heading 4' },
  { group: 'Text', tag: 'h5', label: 'h5', text: 'Heading 5' },
  { group: 'Text', tag: 'h6', label: 'h6', text: 'Heading 6' },
  { group: 'Text', tag: 'p', label: 'p', text: 'Paragraph text' },
  { group: 'Text', tag: 'span', label: 'span', text: 'Text' },
  { group: 'Text', tag: 'a', label: 'a', text: 'Link', attrs: { href: '#' } },
  { group: 'Text', tag: 'ul', label: 'ul', items: 3 },
  { group: 'Text', tag: 'ol', label: 'ol', items: 3 },
  { group: 'Text', tag: 'li', label: 'li', text: 'Item' },
  { group: 'Media & forms', tag: 'img', label: 'img', attrs: { src: PLACEHOLDER_IMG, alt: '' } },
  { group: 'Media & forms', tag: 'button', label: 'button', text: 'Button', style: btn },
  { group: 'Media & forms', tag: 'input', label: 'input', attrs: { type: 'text', placeholder: 'Placeholder' } },
  { group: 'Media & forms', tag: 'textarea', label: 'textarea', attrs: { placeholder: 'Placeholder' } },
  { group: 'Media & forms', tag: 'label', label: 'label', text: 'Label' },
  { group: 'Media & forms', tag: 'hr', label: 'hr' },
];

export const KNOWN_TAGS = new Set(PALETTE.map((p) => p.tag));
KNOWN_TAGS.add('body');

export function uid() {
  return 'n' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

export function makeNode(entry) {
  const n = {
    id: uid(),
    tag: entry.tag,
    attrs: { ...(entry.attrs || {}) },
    style: { ...(entry.style || {}) },
    hover: {},
    children: [],
  };
  if (entry.text) n.text = entry.text;
  for (let i = 0; i < (entry.items || 0); i++) {
    n.children.push(makeNode({ tag: 'li', text: 'Item ' + (i + 1) }));
  }
  return n;
}

export function cloneWithNewIds(node) {
  const c = JSON.parse(JSON.stringify(node));
  (function walk(n) {
    n.id = uid();
    (n.children || []).forEach(walk);
  })(c);
  return c;
}

// Fills in missing fields so imported/older documents never break the editor.
export function normalizeDoc(doc) {
  (function walk(n) {
    n.attrs = n.attrs && typeof n.attrs === 'object' ? n.attrs : {};
    n.style = n.style && typeof n.style === 'object' ? n.style : {};
    n.hover = n.hover && typeof n.hover === 'object' ? n.hover : {};
    n.children = Array.isArray(n.children) ? n.children : [];
    n.id = String(n.id || uid());
    n.children.forEach(walk);
  })(doc.root);
  doc.root.id = 'root';
  doc.root.tag = 'body';
  return doc;
}

// Returns {node, parent, index} or null.
export function find(root, id, parent = null, index = 0) {
  if (root.id === id) return { node: root, parent, index };
  for (let i = 0; i < root.children.length; i++) {
    const r = find(root.children[i], id, root, i);
    if (r) return r;
  }
  return null;
}

export function contains(node, id) {
  return node.id === id || node.children.some((c) => contains(c, id));
}

export function ancestors(root, id) {
  const out = [];
  let cur = find(root, id);
  while (cur && cur.parent) {
    out.push(cur.parent);
    cur = find(root, cur.parent.id);
  }
  return out;
}

// Finds where a new node with `tag` should go when "add" is clicked while `selId` is selected.
// Returns {parent, index}.
export function insertionPoint(root, selId, tag) {
  let cur = find(root, selId) || find(root, 'root');
  let child = null;
  while (cur) {
    if (canContain(cur.node.tag, tag)) {
      const index = child ? child.index + 1 : cur.node.children.length;
      return { parent: cur.node, index };
    }
    child = cur;
    cur = cur.parent ? find(root, cur.parent.id) : null;
  }
  return null;
}

export function expandBox(v) {
  const p = String(v).trim().split(/\s+/);
  const [t, r = t, b = t, l = r] = p;
  return { top: t, right: r, bottom: b, left: l };
}
