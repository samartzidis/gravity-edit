import {Plugin, PluginKey} from 'prosemirror-state';
import type {EditorState, Transaction} from 'prosemirror-state';
import {Decoration, DecorationSet} from 'prosemirror-view';
import type {EditorView} from 'prosemirror-view';
import type {Node, NodeType, Schema} from 'prosemirror-model';
import {TableNode} from '@gravity-ui/markdown-editor';
import type {ExtensionAuto} from '@gravity-ui/markdown-editor';

// ─── constants ────────────────────────────────────────────────────────────────

const pluginKey      = new PluginKey<DecorationSet>('mdTableColumnMove');
const DRAG_THRESHOLD = 4;  // px before drag activates
const SCROLL_ZONE    = 80; // px from viewport edge that triggers auto-scroll
const SCROLL_MAX     = 12; // px scrolled per frame at the edge
const CLS = {
    grip:      'md-col-grip',
    rowGrip:   'md-row-grip',
    overlay:   'md-col-dnd-overlay',
    ghost:     'md-col-dnd-ghost',
    cursor:    'md-col-dnd-cursor',
    rowCursor: 'md-row-dnd-cursor',
} as const;

// ─── styles ───────────────────────────────────────────────────────────────────

// GripHorizontal icon from @gravity-ui/icons (16×16, 3×2 dots) — for column drag.
const GRIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M3 9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6.5 1.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0m0-5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0m-5 0a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0M13 9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m1.5-3.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0" clip-rule="evenodd"/></svg>`;

// Grip icon from @gravity-ui/icons (16×16, 2×3 dots) — for row drag.
const ROW_GRIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" d="M7 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M5.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3m5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3m0-5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M7 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m3.5 1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" clip-rule="evenodd"/></svg>`;

const STYLES = `
.ProseMirror table th,
.ProseMirror table td { position: relative; }

.${CLS.grip} {
    display: none;
    position: absolute;
    top: 2px; left: 50%;
    transform: translateX(-50%);
    width: 24px; height: 24px;
    padding: 4px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--g-color-text-secondary, #888);
    cursor: grab;
    align-items: center; justify-content: center;
    z-index: 10;
    box-sizing: border-box;
    user-select: none; -webkit-user-select: none;
}
.ProseMirror table th:hover .${CLS.grip} { display: flex; }
.${CLS.grip}:hover {
    background: var(--g-color-base-simple-hover, rgba(0,0,0,0.07));
    color: var(--g-color-text-primary, #222);
}

.${CLS.rowGrip} {
    display: none;
    position: absolute;
    top: 50%; left: 2px;
    transform: translateY(-50%);
    width: 24px; height: 24px;
    padding: 4px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--g-color-text-secondary, #888);
    cursor: grab;
    align-items: center; justify-content: center;
    z-index: 10;
    box-sizing: border-box;
    user-select: none; -webkit-user-select: none;
}
.ProseMirror table td:first-child:hover .${CLS.rowGrip} { display: flex; }
.${CLS.rowGrip}:hover {
    background: var(--g-color-base-simple-hover, rgba(0,0,0,0.07));
    color: var(--g-color-text-primary, #222);
}

.${CLS.overlay} {
    position: fixed; inset: 0;
    z-index: 100500;
    cursor: grabbing;
    background: transparent;
}

.${CLS.ghost} {
    position: fixed;
    pointer-events: none;
    z-index: 100501;
    opacity: 0.9;
    will-change: transform;
    box-shadow: 0 8px 20px 1px rgba(0,0,0,0.15);
}
.${CLS.ghost} table { border-collapse: collapse; border-color: var(--g-color-line-brand, #5282ff); }
.${CLS.ghost} th,
.${CLS.ghost} td  { border: 1px solid var(--g-color-line-brand, #5282ff); }

.${CLS.cursor} {
    position: fixed;
    width: 2px;
    pointer-events: none;
    z-index: 100502;
    background: var(--g-color-line-brand, #5282ff);
    border-radius: 1px;
}

.${CLS.rowCursor} {
    position: fixed;
    height: 2px;
    pointer-events: none;
    z-index: 100502;
    background: var(--g-color-line-brand, #5282ff);
    border-radius: 1px;
}
`;

let stylesInjected = false;
function injectStyles(): void {
    if (stylesInjected) return;
    stylesInjected = true;
    const el = document.createElement('style');
    el.textContent = STYLES;
    document.head.appendChild(el);
}

// ─── grip decoration ──────────────────────────────────────────────────────────

function makeGrip(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = CLS.grip;
    btn.contentEditable = 'false';
    btn.type = 'button';
    btn.innerHTML = GRIP_SVG;
    return btn;
}

function makeRowGrip(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = CLS.rowGrip;
    btn.contentEditable = 'false';
    btn.type = 'button';
    btn.innerHTML = ROW_GRIP_SVG;
    return btn;
}

// Shared traversal: `iterate` is either `doc.descendants` (whole document, used once
// at init) or `doc.nodesBetween(from, to, ...)` (a single table's range, used on every
// edit inside a table) — both share the same visitor signature.
function collectGripDecorations(
    iterate: (visit: (node: Node, pos: number, parent: Node | null, index: number) => boolean | void) => void,
    thType: NodeType,
    tdType: NodeType,
): Decoration[] {
    const decos: Decoration[] = [];
    iterate((node, pos, _parent, index) => {
        if (node.type === thType) {
            // Column drag grip — inside every header cell.
            decos.push(Decoration.widget(pos + 1, (view) => {
                const grip = makeGrip();
                grip.addEventListener('mousedown', (e: MouseEvent) => {
                    const thDom = grip.closest('th');
                    if (!thDom) return;
                    e.preventDefault();
                    startDrag(view, thDom, e);
                });
                return grip;
            }, {side: -1, stopEvent: () => true}));
            return false;
        }
        if (node.type === tdType && index === 0) {
            // Row drag grip — inside the first data cell of each body row.
            decos.push(Decoration.widget(pos + 1, (view) => {
                const grip = makeRowGrip();
                grip.addEventListener('mousedown', (e: MouseEvent) => {
                    const trDom = grip.closest('tr');
                    if (!trDom) return;
                    e.preventDefault();
                    startRowDrag(view, trDom, e);
                });
                return grip;
            }, {side: -1, stopEvent: () => true}));
            return false;
        }
        return true;
    });
    return decos;
}

function buildDecorations(state: EditorState, thType: NodeType, tdType: NodeType): DecorationSet {
    const decos = collectGripDecorations((visit) => state.doc.descendants(visit), thType, tdType);
    return DecorationSet.create(state.doc, decos);
}

// Rebuild grips only within [from, to) — used to refresh a single edited table
// without re-walking the rest of the document.
function buildDecorationsInRange(
    doc: Node,
    from: number,
    to: number,
    thType: NodeType,
    tdType: NodeType,
): Decoration[] {
    return collectGripDecorations((visit) => doc.nodesBetween(from, to, visit), thType, tdType);
}

// Cheap count (no DOM/widget allocation) of grip-eligible cells within [from, to) —
// used to detect whether a table's row/column count actually changed, so plain text
// edits inside a cell don't force grip decorations to be torn down and recreated.
function countGripTargets(doc: Node, from: number, to: number, thType: NodeType, tdType: NodeType): number {
    let count = 0;
    doc.nodesBetween(from, to, (node, _pos, _parent, index) => {
        if (node.type === thType) {
            count++;
            return false;
        }
        if (node.type === tdType && index === 0) {
            count++;
            return false;
        }
        return true;
    });
    return count;
}

// ─── drag session ─────────────────────────────────────────────────────────────

function startDrag(view: EditorView, thDom: Element, e: MouseEvent): void {
    const trDom    = thDom.parentElement;
    const theadDom = trDom?.parentElement;
    const tableDom = theadDom?.parentElement;
    if (!trDom || !theadDom || !tableDom) return;

    const thCells = Array.from(trDom.children);
    const fromIdx = thCells.indexOf(thDom as HTMLElement);
    if (fromIdx < 0 || thCells.length < 2) return;

    const tablePos  = view.posAtDOM(tableDom, 0) - 1;
    const thRects   = thCells.map(th => (th as HTMLElement).getBoundingClientRect());
    const tableRect = (tableDom as HTMLElement).getBoundingClientRect();
    const startX    = e.clientX;
    const startY    = e.clientY;
    // Shift so the ghost column stays under the grab point.
    const shiftX    = thRects[fromIdx].left - startX;

    const overlay    = document.createElement('div');
    overlay.className = CLS.overlay;

    const ghost      = buildGhost(tableDom, fromIdx, thRects, tableRect);
    ghost.style.display = 'none';

    const dropCursor = document.createElement('div');
    dropCursor.className = CLS.cursor;
    dropCursor.style.display = 'none';

    document.body.append(overlay, ghost, dropCursor);

    let active   = false;
    let dropZone = fromIdx;

    function onMove(ev: MouseEvent): void {
        if (!active) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            active = true;
            ghost.style.display      = '';
            dropCursor.style.display = '';
        }

        // Follow cursor horizontally; pin to table top/height.
        ghost.style.left = (ev.clientX + shiftX) + 'px';
        ghost.style.top  = tableRect.top + 'px';

        dropZone = computeDropZone(ev.clientX, thRects);

        if (dropZone !== fromIdx && dropZone !== fromIdx + 1) {
            positionDropCursor(dropCursor, dropZone, thRects, tableRect);
            dropCursor.style.display = '';
        } else {
            dropCursor.style.display = 'none';
        }
    }

    function cancel(): void {
        overlay.remove();
        ghost.remove();
        dropCursor.remove();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('keydown',   onKey);
        view.focus();
    }

    function onUp(): void {
        if (active && dropZone !== fromIdx && dropZone !== fromIdx + 1) {
            moveColumnToZone(view, tablePos, fromIdx, dropZone);
        }
        cancel();
    }

    function onKey(ev: KeyboardEvent): void {
        if (ev.key === 'Escape') cancel();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('keydown',   onKey);
}

// ─── ghost element ────────────────────────────────────────────────────────────

function buildGhost(
    tableDom: Element,
    fromIdx:  number,
    thRects:  DOMRect[],
    tableRect: DOMRect,
): HTMLDivElement {
    const container = document.createElement('div');
    container.className    = CLS.ghost;
    container.style.width  = thRects[fromIdx].width  + 'px';
    container.style.height = tableRect.height         + 'px';

    const table = container.appendChild(document.createElement('table'));
    const tbody = table.appendChild(document.createElement('tbody'));

    const allRows = [
        ...tableDom.querySelectorAll('thead > tr'),
        ...tableDom.querySelectorAll('tbody > tr'),
    ];

    for (const row of allRows) {
        const cell = row.children[fromIdx] as HTMLElement | undefined;
        if (!cell) continue;
        const tr     = tbody.appendChild(document.createElement('tr'));
        const cloned = tr.appendChild(cell.cloneNode(true)) as HTMLElement;
        const r      = cell.getBoundingClientRect();
        cloned.style.width  = r.width  + 'px';
        cloned.style.height = r.height + 'px';
    }

    // Strip id attributes to avoid duplicate-id warnings.
    table.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));

    return container;
}

// ─── drop-zone logic ──────────────────────────────────────────────────────────

// Returns the insertion zone: 0 = before col 0, k = before col k, n = after last col.
function computeDropZone(cursorX: number, thRects: DOMRect[]): number {
    const n = thRects.length;
    if (cursorX <= thRects[0].left) return 0;
    if (cursorX >= thRects[n - 1].right) return n;
    for (let i = 0; i < n; i++) {
        const {left, right} = thRects[i];
        if (cursorX >= left && cursorX <= right) {
            return cursorX < (left + right) / 2 ? i : i + 1;
        }
    }
    return 0;
}

function positionDropCursor(
    el:        HTMLDivElement,
    zone:      number,
    thRects:   DOMRect[],
    tableRect: DOMRect,
): void {
    const n = thRects.length;
    const x = zone === 0 ? thRects[0].left
            : zone <  n  ? thRects[zone].left
                         : thRects[n - 1].right;
    el.style.left   = (x - 1)            + 'px';
    el.style.top    = tableRect.top       + 'px';
    el.style.height = tableRect.height    + 'px';
}

// ─── column-move transaction ──────────────────────────────────────────────────

function moveColumnToZone(
    view:     EditorView,
    tablePos: number,
    fromIdx:  number,
    toZone:   number,
): void {
    const {state} = view;
    const tableNode = state.doc.nodeAt(tablePos);
    if (!tableNode) return;

    const tr = state.tr;

    // Collect sections (thead, tbody) then process bottom-up so earlier
    // positions aren't disturbed by later inserts/deletes.
    const sections: Array<{pos: number; node: Node}> = [];
    tableNode.forEach((sec, secOff) => {
        sections.push({pos: tablePos + 1 + secOff, node: sec});
    });

    for (let si = sections.length - 1; si >= 0; si--) {
        const {pos: secPos, node: sec} = sections[si];
        const rows: Array<{pos: number; node: Node}> = [];
        sec.forEach((row, rowOff) => rows.push({pos: secPos + 1 + rowOff, node: row}));

        for (let ri = rows.length - 1; ri >= 0; ri--) {
            const {pos: rowPos, node: row} = rows[ri];
            const cells: Array<{pos: number; node: Node}> = [];
            row.forEach((cell, cellOff) => cells.push({pos: rowPos + 1 + cellOff, node: cell}));
            if (fromIdx >= cells.length) continue;

            const cellFrom = cells[fromIdx].pos;
            const cellTo   = cellFrom + cells[fromIdx].node.nodeSize;

            // Where to insert: before column toZone (clamped to row ends).
            const targetPos =
                toZone === 0             ? rowPos + 1
              : toZone < cells.length   ? cells[toZone].pos
                                        : rowPos + row.nodeSize - 1;

            // Insert a copy of the dragged cell at the target, then delete the original.
            // tr.mapping tracks the position shifts caused by the insert so the delete lands correctly.
            const content = state.doc.slice(cellFrom, cellTo, false).content;
            tr.insert(tr.mapping.map(targetPos), content);
            tr.delete(tr.mapping.map(cellFrom), tr.mapping.map(cellTo));
        }
    }

    if (tr.docChanged) view.dispatch(tr.scrollIntoView());
}

// ─── scroll helper ────────────────────────────────────────────────────────────

function findScrollParent(el: HTMLElement): HTMLElement {
    let cur: HTMLElement | null = el.parentElement;
    while (cur && cur !== document.documentElement) {
        const {overflow, overflowY} = getComputedStyle(cur);
        if (/auto|scroll/.test(overflow + overflowY)) return cur;
        cur = cur.parentElement;
    }
    return document.documentElement as HTMLElement;
}

// ─── row-drag session ─────────────────────────────────────────────────────────

function startRowDrag(view: EditorView, trDom: Element, e: MouseEvent): void {
    const tbodyDom = trDom.parentElement;
    const tableDom = tbodyDom?.parentElement;
    if (!tbodyDom || !tableDom) return;

    const trRows  = Array.from(tbodyDom.children);
    const fromIdx = trRows.indexOf(trDom as HTMLElement);
    if (fromIdx < 0 || trRows.length < 2) return;

    const bodyPos  = view.posAtDOM(tbodyDom, 0) - 1;
    const startX   = e.clientX;
    const startY   = e.clientY;
    const scrollEl = findScrollParent(tableDom as HTMLElement);

    // Mutable rects — refreshed after each auto-scroll tick.
    let trRects   = trRows.map(tr => (tr as HTMLElement).getBoundingClientRect());
    let tableRect = (tableDom as HTMLElement).getBoundingClientRect();

    const shiftY = trRects[fromIdx].top - startY;

    const overlay = document.createElement('div');
    overlay.className = CLS.overlay;

    const ghost = buildRowGhost(trDom, trRects[fromIdx], tableRect);
    ghost.style.display = 'none';

    const dropCursor = document.createElement('div');
    dropCursor.className = CLS.rowCursor;
    dropCursor.style.display = 'none';

    document.body.append(overlay, ghost, dropCursor);

    let active   = false;
    let dropZone = fromIdx;
    let cursorY  = startY;
    let rafId    = 0;

    function readRects(): void {
        trRects   = trRows.map(tr => (tr as HTMLElement).getBoundingClientRect());
        tableRect = (tableDom as HTMLElement).getBoundingClientRect();
    }

    function updateUI(): void {
        ghost.style.top  = (cursorY + shiftY) + 'px';
        ghost.style.left = tableRect.left + 'px';
        dropZone = computeRowDropZone(cursorY, trRects);
        if (dropZone !== fromIdx && dropZone !== fromIdx + 1) {
            positionRowDropCursor(dropCursor, dropZone, trRects, tableRect);
            dropCursor.style.display = '';
        } else {
            dropCursor.style.display = 'none';
        }
    }

    function autoScrollTick(): void {
        if (!active) { rafId = 0; return; }
        const vpH = window.innerHeight;
        let delta = 0;
        if (cursorY < SCROLL_ZONE) {
            delta = -SCROLL_MAX * (1 - cursorY / SCROLL_ZONE);
        } else if (cursorY > vpH - SCROLL_ZONE) {
            delta = SCROLL_MAX * (1 - (vpH - cursorY) / SCROLL_ZONE);
        }
        if (delta !== 0) {
            scrollEl.scrollBy(0, delta);
            readRects();
            updateUI();
        }
        rafId = requestAnimationFrame(autoScrollTick);
    }

    function onMove(ev: MouseEvent): void {
        cursorY = ev.clientY;
        if (!active) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            active = true;
            ghost.style.display      = '';
            dropCursor.style.display = '';
            rafId = requestAnimationFrame(autoScrollTick);
        }
        updateUI();
    }

    function cancel(): void {
        cancelAnimationFrame(rafId);
        overlay.remove();
        ghost.remove();
        dropCursor.remove();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('keydown',   onKey);
        view.focus();
    }

    function onUp(): void {
        if (active && dropZone !== fromIdx && dropZone !== fromIdx + 1) {
            moveRowToZone(view, bodyPos, fromIdx, dropZone);
        }
        cancel();
    }

    function onKey(ev: KeyboardEvent): void {
        if (ev.key === 'Escape') cancel();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('keydown',   onKey);
}

// ─── row ghost ────────────────────────────────────────────────────────────────

function buildRowGhost(trDom: Element, trRect: DOMRect, tableRect: DOMRect): HTMLDivElement {
    const container = document.createElement('div');
    container.className   = CLS.ghost;
    container.style.width = tableRect.width + 'px';
    container.style.height = trRect.height  + 'px';

    const table = container.appendChild(document.createElement('table'));
    const tbody = table.appendChild(document.createElement('tbody'));
    const tr    = tbody.appendChild(document.createElement('tr'));

    Array.from(trDom.children).forEach(cell => {
        const cloned = tr.appendChild(cell.cloneNode(true)) as HTMLElement;
        const r = cell.getBoundingClientRect();
        cloned.style.width  = r.width  + 'px';
        cloned.style.height = r.height + 'px';
    });

    table.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    return container;
}

// ─── row drop-zone logic ──────────────────────────────────────────────────────

// Returns insertion zone: 0 = before row 0, k = before row k, n = after last row.
function computeRowDropZone(cursorY: number, trRects: DOMRect[]): number {
    const n = trRects.length;
    if (cursorY <= trRects[0].top) return 0;
    if (cursorY >= trRects[n - 1].bottom) return n;
    for (let i = 0; i < n; i++) {
        const {top, bottom} = trRects[i];
        if (cursorY >= top && cursorY <= bottom) {
            return cursorY < (top + bottom) / 2 ? i : i + 1;
        }
    }
    return 0;
}

function positionRowDropCursor(
    el:        HTMLDivElement,
    zone:      number,
    trRects:   DOMRect[],
    tableRect: DOMRect,
): void {
    const n = trRects.length;
    const y = zone === 0 ? trRects[0].top
            : zone <  n  ? trRects[zone].top
                         : trRects[n - 1].bottom;
    el.style.top   = (y - 1)          + 'px';
    el.style.left  = tableRect.left    + 'px';
    el.style.width = tableRect.width   + 'px';
}

// ─── row-move transaction ─────────────────────────────────────────────────────

function moveRowToZone(
    view:    EditorView,
    bodyPos: number,
    fromIdx: number,
    toZone:  number,
): void {
    const {state} = view;
    const bodyNode = state.doc.nodeAt(bodyPos);
    if (!bodyNode) return;

    const rows: Array<{pos: number; node: Node}> = [];
    bodyNode.forEach((row, rowOff) => rows.push({pos: bodyPos + 1 + rowOff, node: row}));
    if (fromIdx >= rows.length) return;

    const tr      = state.tr;
    const rowFrom = rows[fromIdx].pos;
    const rowTo   = rowFrom + rows[fromIdx].node.nodeSize;

    const targetPos =
        toZone === 0         ? bodyPos + 1
      : toZone < rows.length ? rows[toZone].pos
                             : bodyPos + bodyNode.nodeSize - 1;

    const content = state.doc.slice(rowFrom, rowTo, false).content;
    tr.insert(tr.mapping.map(targetPos), content);
    tr.delete(tr.mapping.map(rowFrom), tr.mapping.map(rowTo));

    if (tr.docChanged) view.dispatch(tr.scrollIntoView());
}

// ─── plugin ───────────────────────────────────────────────────────────────────

// If `pos` in `doc` falls inside a table, returns that table's own [from, to) range
// (checked via the resolved ancestor chain — O(tree depth), not a document walk).
function tableRangeAt(doc: Node, tableType: NodeType, pos: number): {from: number; to: number} | null {
    const clamped = Math.max(0, Math.min(pos, doc.content.size));
    const $pos = doc.resolve(clamped);
    for (let d = $pos.depth; d >= 1; d--) {
        if ($pos.node(d).type === tableType) {
            return {from: $pos.before(d), to: $pos.after(d)};
        }
    }
    return null;
}

function createPlugin(schema: Schema): Plugin {
    const thType = schema.nodes[TableNode.HeaderCell];
    const tdType = schema.nodes[TableNode.DataCell];
    const tableType = schema.nodes[TableNode.Table];
    if (!thType || !tdType || !tableType) return new Plugin({key: pluginKey});

    return new Plugin<DecorationSet>({
        key: pluginKey,

        state: {
            init(_cfg, editorState) {
                return buildDecorations(editorState, thType, tdType);
            },
            apply(tr: Transaction, old: DecorationSet, _prev: EditorState, next: EditorState) {
                if (!tr.docChanged) return old;

                // Cheap position remap for the common case (typing anywhere outside a
                // table): shift existing grip decorations through the transaction
                // instead of re-walking any part of the document.
                let mapped = old.map(tr.mapping, tr.doc);

                // For steps that touched inside (or created) a table, collect that
                // table's node range, mapped forward to `next.doc` coordinates, so we
                // only re-walk the touched table's own subtree — not the rest of the
                // document — to refresh its grips.
                const touchedRanges: {from: number; to: number}[] = [];
                for (let i = 0; i < tr.steps.length; i++) {
                    const step = tr.steps[i] as unknown as {from?: number; to?: number};
                    if (typeof step.from !== 'number' || typeof step.to !== 'number') continue;

                    const before = tr.docs[i];
                    const beforeRange =
                        tableRangeAt(before, tableType, step.from) ??
                        tableRangeAt(before, tableType, step.to);
                    if (beforeRange) {
                        touchedRanges.push({
                            from: tr.mapping.slice(i).map(beforeRange.from, -1),
                            to: tr.mapping.slice(i).map(beforeRange.to, 1),
                        });
                    }

                    // Also check the position just after this step, in case the step
                    // created a table where there wasn't one before (e.g. paste).
                    const after = i + 1 < tr.docs.length ? tr.docs[i + 1] : tr.doc;
                    const afterPos = tr.mapping.maps[i].map(step.from);
                    const afterRange = tableRangeAt(after, tableType, afterPos);
                    if (afterRange) {
                        touchedRanges.push({
                            from: tr.mapping.slice(i + 1).map(afterRange.from, -1),
                            to: tr.mapping.slice(i + 1).map(afterRange.to, 1),
                        });
                    }
                }

                if (!touchedRanges.length) return mapped;

                // Existing grip decorations already have correct positions and DOM
                // nodes courtesy of `.map()` above. Only rebuild (tear down + recreate
                // the DOM widgets) a table's grips when its cell count actually
                // changed — a row/column insert or delete — not for a plain text edit
                // inside an existing cell, which is the overwhelming majority of
                // keystrokes typed "inside a table".
                const docSize = next.doc.content.size;
                const newDecos: Decoration[] = [];
                for (const range of touchedRanges) {
                    const from = Math.max(0, Math.min(range.from, docSize));
                    const to = Math.max(from, Math.min(range.to, docSize));
                    const existingCount = mapped.find(from, to).length;
                    const actualCount = countGripTargets(next.doc, from, to, thType, tdType);
                    if (existingCount === actualCount) continue;
                    mapped = mapped.remove(mapped.find(from, to));
                    newDecos.push(...buildDecorationsInRange(next.doc, from, to, thType, tdType));
                }

                return newDecos.length ? mapped.add(next.doc, newDecos) : mapped;
            },
        },

        props: {
            decorations(state) {
                return pluginKey.getState(state);
            },
        },

        view() {
            injectStyles();
            return {};
        },
    });
}

// ─── extension ────────────────────────────────────────────────────────────────

export const MdTableDnd: ExtensionAuto = (builder) => {
    builder.addPlugin(({schema}) => createPlugin(schema));
};
