import type Token from 'markdown-it/lib/token';
import type {Node as PmNode} from 'prosemirror-model';
import type {EditorView} from 'prosemirror-view';

import type {ExtensionAuto} from '@gravity-ui/markdown-editor';

import {vscode} from './vscode';
import type {ExtensionMessage} from './vscode';

export const WYSIWYG_RESUMED_EVENT = 'gravity-wysiwyg-resumed' as const;

type GraphViewerGlobal = {
  createViewerForElement(el: HTMLElement): void;
};

declare global {
  interface Window {
    GraphViewer?: GraphViewerGlobal;
  }
  interface WindowEventMap {
    [WYSIWYG_RESUMED_EVENT]: CustomEvent;
  }
}

function drawioMarkdownPlugin(md: {core: {ruler: {push(name: string, fn: (state: {tokens: Token[]}) => void): void}}}): void {
  md.core.ruler.push('drawio', (state) => {
    for (const t of state.tokens) {
      if (t.type === 'fence' && t.info.trim() === 'drawio') {
        t.type = 'drawio';
      }
    }
  });
}

export const Drawio: ExtensionAuto = (builder) => {
  builder
    .configureMd((md) => md.use(drawioMarkdownPlugin))
    .addNode('drawio', () => ({
      fromMd: {
        tokenSpec: {
          name: 'drawio',
          type: 'node',
          getAttrs: ({content}: Token) => ({src: content.trim()}),
        },
      },
      spec: {
        selectable: true,
        atom: true,
        group: 'block',
        attrs: {src: {default: ''}},
        parseDOM: [],
        toDOM(node: PmNode) {
          return ['div', {'data-drawio-src': String(node.attrs.src)}];
        },
        dnd: {props: {offset: [8, 1]}},
      },
      toMd: (state, node) => {
        state.write('```drawio');
        state.ensureNewLine();
        state.text(String(node.attrs.src).trim(), false);
        state.ensureNewLine();
        state.write('```');
        state.ensureNewLine();
      },
      view: () => (node: PmNode, view: EditorView, getPos: () => number | undefined) =>
        new WDrawioNodeView(node, view, getPos),
    }));
};

function hashXml(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++)
    hash = (hash * 33) ^ str.charCodeAt(i);
  return hash >>> 0;
}

export class WDrawioNodeView {
  dom: HTMLElement;
  private container: HTMLElement;
  private renderId: string;
  private currentSrc: string;
  private lastRenderedHash: number | null = null;
  private node: PmNode;

  private onWindowMessage = (e: MessageEvent<ExtensionMessage>) => {
    const msg = e.data;
    if (!msg?.type) return;

    if (msg.type === 'reloadImages') {
      this.rerender();
    } else if (msg.type === 'drawioFileContent' && msg.id === this.renderId) {
      this.renderXml(msg.xml);
    } else if (msg.type === 'drawioFileError' && msg.id === this.renderId) {
      this.showError(msg.error);
    }
  };

  private onWysiwygResumed = () => {
    this.rerender();
  };

  private onDblClick = () => {
    const src = this.currentSrc.trim();
    if (src.startsWith('<')) return;
    try {
      new URL(src);
      return;
    } catch {
      // not a URL - treat as local file path
    }
    vscode.postMessage({type: 'openFile', src});
  };

  constructor(node: PmNode, _view: EditorView, _getPos: () => number | undefined) {
    this.node = node;
    this.currentSrc = String(node.attrs.src);
    this.renderId = crypto.randomUUID();

    this.dom = document.createElement('div');
    this.dom.style.cssText = 'display:block;padding:4px 0;';

    this.container = document.createElement('div');
    this.container.style.cssText = 'max-width:100%;';
    this.dom.appendChild(this.container);

    this.dom.addEventListener('dblclick', this.onDblClick, true);
    window.addEventListener('message', this.onWindowMessage);
    window.addEventListener(WYSIWYG_RESUMED_EVENT, this.onWysiwygResumed);
    this.requestFile();
  }

  private rerender(): void {
    this.renderId = crypto.randomUUID();
    this.requestFile();
  }

  private requestFile(): void {
    if (this.currentSrc.trimStart().startsWith('<')) {
      this.renderXml(this.currentSrc);
    } else {
      vscode.postMessage({type: 'readDrawioFile', src: this.currentSrc, id: this.renderId});
    }
  }

  private renderXml(xml: string): void {
    const hash = hashXml(xml);
    if (hash === this.lastRenderedHash) return;
    this.lastRenderedHash = hash;
    const gv = window.GraphViewer;
    if (!gv) {
      this.showError('GraphViewer not loaded');
      return;
    }
    this.container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'mxgraph';
    div.setAttribute('data-mxgraph', JSON.stringify({
      xml,
      lightbox: false,
      nav: false,
      'toolbar-nohide': false,
      'auto-fit': true,
    }));
    this.container.appendChild(div);
    try {
      gv.createViewerForElement(div);
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private showError(msg: string): void {
    this.container.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.style.cssText = 'color:#c00;font-family:monospace;font-size:12px;padding:4px;border:1px solid #fcc;background:#fff5f5;';
    errEl.textContent = `Draw.io error: ${msg}`;
    this.container.appendChild(errEl);
  }

  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const newSrc = String(node.attrs.src);
    if (newSrc !== this.currentSrc) {
      this.currentSrc = newSrc;
      this.renderId = crypto.randomUUID();
      this.requestFile();
    }
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener('dblclick', this.onDblClick, true);
    window.removeEventListener('message', this.onWindowMessage);
    window.removeEventListener(WYSIWYG_RESUMED_EVENT, this.onWysiwygResumed);
  }

  ignoreMutation(): boolean {
    return true;
  }
}
