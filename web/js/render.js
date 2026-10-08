import { KNOWN_TAGS, VOID, canContain, find } from './model.js';

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster']);
const BAD_URL = /^\s*(javascript|vbscript|data:text\/html)/i;
const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PROP_NAME = /^(--)?[a-zA-Z][a-zA-Z0-9-]*$/;
const SKIP_ATTRS = new Set(['style', 'srcdoc', 'id', 'class']);

const cls = (id) => 'n-' + String(id).replace(/[^\w-]/g, '_');

const CHROME_CSS = `
:host { all: initial; display: block; height: 100%; }
.frame { color: #000; font: 16px/normal Times, 'Times New Roman', serif; display: flex; flex-direction: column; min-height: 100%; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.18); }
[data-root] { flex: 1 0 auto; margin: 0; }
.edit [data-empty] { min-height: 24px; outline: 1px dashed #c5c9d0; outline-offset: -1px; }
.edit [data-hl] { outline: 1px solid #7cc4ff !important; outline-offset: -1px; }
.edit [data-sel] { outline: 2px solid #0d99ff !important; outline-offset: -2px; }
.edit [data-drop="inside"] { outline: 2px solid #16a34a !important; outline-offset: -2px; }
.edit [data-drop="before"] { box-shadow: 0 -3px 0 #16a34a; }
.edit [data-drop="after"] { box-shadow: 0 3px 0 #16a34a; }
.edit img { -webkit-user-drag: element; }
`;

// Renders documents into a shadow root so app CSS and document CSS never mix.
export class Canvas {
  constructor(host, handlers) {
    this.h = handlers;
    this.shadow = host.attachShadow({ mode: 'open' });
    this.mode = 'edit';
    this.selId = null;
    this.drag = null;
    this.#bind();
  }

  render(doc, { mode, selId, forceHoverId }) {
    this.mode = mode;
    this.selId = selId;
    const chrome = document.createElement('style');
    chrome.textContent = CHROME_CSS;
    const sheetEl = document.createElement('style');
    const frame = document.createElement('div');
    frame.className = 'frame' + (mode === 'edit' ? ' edit' : '');
    this.shadow.replaceChildren(chrome, sheetEl, frame);
    const sheet = sheetEl.sheet;
    const rule = (selector, decls) => {
      const entries = Object.entries(decls || {});
      if (!entries.length) return;
      const idx = sheet.insertRule(`${selector} {}`, sheet.cssRules.length);
      for (const [p, v] of entries) {
        if (PROP_NAME.test(p)) sheet.cssRules[idx].style.setProperty(p, String(v));
      }
    };
    const build = (node, isRoot) => {
      const tag = isRoot ? 'div' : KNOWN_TAGS.has(node.tag) ? node.tag : 'div';
      const el = document.createElement(tag);
      const c = cls(node.id);
      el.classList.add(c);
      el.dataset.id = node.id;
      if (isRoot) el.dataset.root = '';
      for (const [k, v] of Object.entries(node.attrs || {})) {
        if (!ATTR_NAME.test(k) || /^on/i.test(k) || SKIP_ATTRS.has(k.toLowerCase())) continue;
        if (URL_ATTRS.has(k.toLowerCase()) && BAD_URL.test(String(v))) continue;
        el.setAttribute(k, String(v));
      }
      if (node.attrs?.id) el.id = String(node.attrs.id);
      if (node.attrs?.class) {
        for (const extra of String(node.attrs.class).split(/\s+/)) if (extra) el.classList.add(extra);
      }
      if (node.id === forceHoverId) el.classList.add('__hover');
      rule('.' + c, node.style);
      rule(node.id === forceHoverId ? `.${c}:hover, .${c}.__hover` : `.${c}:hover`, node.hover);
      if (node.text && !VOID.has(tag)) el.append(document.createTextNode(node.text));
      for (const ch of node.children) el.append(build(ch, false));
      if (mode === 'edit') {
        if (!VOID.has(tag) && !node.text && !node.children.length) el.dataset.empty = '';
        if (node.id === selId) el.dataset.sel = '';
        if (!isRoot) el.draggable = true;
      }
      return el;
    };
    frame.append(build(doc.root, true));
  }

  setHover(id) {
    this.shadow.querySelectorAll('[data-hl]').forEach((e) => e.removeAttribute('data-hl'));
    if (id) this.#el(id)?.setAttribute('data-hl', '');
  }

  clearDrop() {
    this.shadow.querySelectorAll('[data-drop]').forEach((e) => e.removeAttribute('data-drop'));
  }

  #el(id) {
    return [...this.shadow.querySelectorAll('[data-id]')].find((e) => e.dataset.id === id);
  }

  #target(e) {
    const t = e.target;
    return t.closest ? t.closest('[data-id]') : null;
  }

  #bind() {
    const s = this.shadow;
    const stopNative = (e) => {
      if (this.mode !== 'edit') {
        // Preview: keep interactions, but never navigate away from the editor.
        if (e.target.closest?.('a[href]')) e.preventDefault();
        return;
      }
      e.preventDefault();
    };
    s.addEventListener('mousedown', (e) => {
      if (this.mode === 'edit' && e.target.closest?.('input,textarea,button')) e.preventDefault();
    });
    s.addEventListener('click', (e) => {
      stopNative(e);
      if (this.mode !== 'edit') return;
      const el = this.#target(e);
      if (el) this.h.select(el.dataset.id);
    });
    s.addEventListener('submit', (e) => e.preventDefault());
    s.addEventListener('mouseover', (e) => {
      if (this.mode !== 'edit') return;
      const el = this.#target(e);
      this.setHover(el ? el.dataset.id : null);
      this.h.hover?.(el ? el.dataset.id : null);
    });
    s.addEventListener('mouseleave', () => {
      this.setHover(null);
      this.h.hover?.(null);
    });
    s.addEventListener('dragstart', (e) => {
      const el = this.#target(e);
      if (!el || el.dataset.root !== undefined) return e.preventDefault();
      e.dataTransfer.setData('text/figmore-node', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      this.h.dragStart(el.dataset.id);
    });
    s.addEventListener('dragover', (e) => {
      const el = this.#target(e);
      this.clearDrop();
      if (!el) return;
      const zone = this.h.dropZone(el.dataset.id, this.#zone(el, e));
      if (!zone) return;
      e.preventDefault();
      el.dataset.drop = zone;
    });
    s.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) this.clearDrop();
    });
    s.addEventListener('drop', (e) => {
      const el = this.#target(e);
      this.clearDrop();
      if (!el) return;
      const zone = this.h.dropZone(el.dataset.id, this.#zone(el, e));
      if (!zone) return;
      e.preventDefault();
      this.h.drop(el.dataset.id, zone, e.dataTransfer);
    });
    s.addEventListener('dragend', () => this.clearDrop());
  }

  // Raw zone from pointer position: 'before' | 'inside' | 'after'.
  #zone(el, e) {
    const r = el.getBoundingClientRect();
    const parent = el.parentElement;
    let horizontal = false;
    if (parent) {
      const cs = getComputedStyle(parent);
      horizontal = cs.display.includes('flex') && cs.flexDirection.startsWith('row');
    }
    const pos = horizontal ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    return pos < 0.25 ? 'before' : pos > 0.75 ? 'after' : 'inside';
  }
}

// Shared drop-zone resolution used by both the canvas and the layer tree.
// Returns the effective zone for dropping `payloadTag` on target `id`, or null.
export function resolveZone(doc, targetId, zone, payloadTag, movingId) {
  const t = find(doc.root, targetId);
  if (!t) return null;
  if (movingId) {
    const m = find(doc.root, movingId);
    if (!m) return null;
    // cannot drop a node into itself or its descendants
    const inside = (n) => n.id === targetId || n.children.some(inside);
    if (inside(m.node)) return null;
  }
  const order = zone === 'inside' ? ['inside', 'after'] : [zone];
  for (const z of order) {
    if (z === 'inside') {
      if (canContain(t.node.tag, payloadTag)) return 'inside';
    } else if (t.parent && canContain(t.parent.tag, payloadTag)) {
      return z;
    }
  }
  return null;
}
