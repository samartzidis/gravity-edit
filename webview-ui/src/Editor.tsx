import {useEffect, useRef, useState} from 'react';

import {Mermaid} from '@gravity-ui/markdown-editor/extensions/additional/Mermaid/index.js';
import {Drawio, WYSIWYG_RESUMED_EVENT} from './DrawioExtension';
import {MdTableDnd} from './MdTableDnd';
import {MarkdownEditorView, useMarkdownEditor} from '@gravity-ui/markdown-editor';
import type {ToolbarsPreset} from '@gravity-ui/markdown-editor';
// The _/* wildcard export is the library's documented pattern for toolbar customisation —
// the library's own demo (demo/src/stories/presets/presets.ts) uses these same paths.
import {ActionName as Action} from '@gravity-ui/markdown-editor/_/bundle/config/action-names.js';
import {full as fullPreset} from '@gravity-ui/markdown-editor/_/modules/toolbars/presets.js';
import type {MarkdownEditorMode} from '@gravity-ui/markdown-editor';
import {Toaster, ThemeProvider, ToasterComponent, ToasterProvider} from '@gravity-ui/uikit';
import '@gravity-ui/uikit/styles/fonts.css';
import '@gravity-ui/uikit/styles/styles.css';
import {Plugin} from 'prosemirror-state';
import {dropPoint} from 'prosemirror-transform';
import {Fragment, Slice} from 'prosemirror-model';

// Single shared Toaster instance for the lifetime of this webview.
const toaster = new Toaster();

import {vscode} from './vscode';
import type {ExtensionMessage} from './vscode';

const IMAGE_EXTS = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?)$/i;
const DRAWIO_EXT = /\.drawio$/i;

const MD_TABLE =
  '\n| Heading | Heading |\n| ------- | ------- |\n| Text    | Text    |\n| Text    | Text    |\n';

// Extend the full preset, replacing only the table item's handlers so the button
// inserts standard markdown tables instead of YFM tables.
const customPreset: ToolbarsPreset = {
  ...fullPreset,
  items: {
    ...fullPreset.items,
    [Action.table]: {
      ...fullPreset.items[Action.table],
      wysiwyg: {
        exec: (e) => e.actions.createTable.run(),
        isActive: (e) => e.actions.createTable.isActive(),
        isEnable: (e) => e.actions.createTable.isEnable(),
      },
      markup: {
        exec: (e) => e.cm.dispatch(e.cm.state.replaceSelection(MD_TABLE)),
        isActive: () => false,
        isEnable: () => true,
      },
    },
  },
};

function isAbsolutePath(s: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(s) || s.startsWith('/');
}

function computeRelativePath(fromDir: string, toFile: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const a = norm(fromDir).split('/');
  const b = norm(toFile).split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  const ups = Array(a.length - i).fill('..');
  return [...ups, ...b.slice(i)].join('/') || '.';
}

export function Editor() {
  const [initialMarkup, setInitialMarkup] = useState<string | null>(null);
  const docDirRef = useRef('');

  // Wait for the first content message before mounting the editor so ProseMirror's
  // undo history never contains an empty-document state.
  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      if (msg.type !== 'update') return;
      if (msg.docDir) docDirRef.current = msg.docDir;
      setInitialMarkup((prev) => {
        // Only use this path for the very first message; subsequent updates go to
        // the mounted editor instance via the inner component.
        if (prev === null) return msg.text;
        return prev;
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    vscode.postMessage({type: 'ready'});
  }, []);

  return (
    <ThemeProvider theme="light">
      <ToasterProvider toaster={toaster}>
        <ToasterComponent />
        <div style={{height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative'}}>
          {initialMarkup === null ? (
            <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'var(--g-color-base-background, #fff)',
              color: 'var(--g-color-text-secondary, #9d9d9d)', fontSize: 13}}>
              Loading editor…
            </div>
          ) : (
            <LoadedEditor initialMarkup={initialMarkup} docDirRef={docDirRef} />
          )}
        </div>
      </ToasterProvider>
    </ThemeProvider>
  );
}

function LoadedEditor({initialMarkup, docDirRef}: {initialMarkup: string; docDirRef: React.RefObject<string>}) {
  const mdEditor = useMarkdownEditor({
    initial: {markup: initialMarkup},
    preset: 'full',
    md: {html: true},
    experimental: {
      preserveEmptyRows: true,
    },
    wysiwygConfig: {
      // The default serializer escape regex includes [ and ], causing wiki-style directives
      // like [[_TOC_]] to be serialized as \[\[_TOC_\]\].
      escapeConfig: {
        commonEscape: /[`\^+*\\|~{}<>$]|(?<!\[)\[(?!\[)|(?<!\])\](?!\])/g,
        //commonEscape: /[`\^+*\\|~{}<>$]/g,
      },
      extensions: (builder) => {
        builder.use(Mermaid, {
          loadRuntimeScript: () => {
            import('@diplodoc/mermaid-extension/runtime');
          },
        });

        builder.use(Drawio);
        builder.use(MdTableDnd);

        // Table extension maps Shift-Enter to moveToNextRowCommand, shadowing Breaks; restore hard-break in cells.
        // hard_break normally serializes as '\\\n' which breaks table row syntax; use <br> inside td/th instead.
        builder.use((b) => {
          b.addKeymap(({schema}) => ({
            'Shift-Enter': (state, dispatch) => {
              const {$head} = state.selection;
              for (let d = $head.depth; d >= 0; d--) {
                const name = $head.node(d).type.name;
                if (name === 'td' || name === 'th') {
                  const hb = schema.nodes['hard_break'];
                  if (!hb) return false;
                  if (dispatch) dispatch(state.tr.replaceSelectionWith(hb.create()).scrollIntoView());
                  return true;
                }
              }
              return false;
            },
          }), b.Priority.VeryHigh);

          b.overrideNodeSerializerSpec('hard_break', (prev) => (state, node, parent, index) => {
            if (parent.type.name === 'td' || parent.type.name === 'th') {
              state.write('<br>');
              return;
            }
            prev(state, node, parent, index);
          });

          // Round-trip: <br> in markup → hardbreak token → hard_break node (html_inline renders as text, not a break).
          b.configureMd((md) => {
            md.core.ruler.push('html_br_to_hardbreak', (state) => {
              for (const token of state.tokens) {
                if (token.type !== 'inline' || !token.children) continue;
                for (const child of token.children) {
                  if (child.type === 'html_inline' && /^<br\s*\/?>$/i.test(child.content)) {
                    child.type = 'hardbreak';
                    child.tag = 'br';
                    child.content = '';
                  }
                }
              }
              return false;
            });
            return md;
          });
        });

        // Intercept VS Code Explorer Shift+drag-drop: insert image, drawio, or file link.
        builder.use((b) => {
          b.addPlugin(() => new Plugin({
            props: {
              handleDOMEvents: {
                drop(view, e) {
                  const text = (e.dataTransfer?.getData('text/plain') ?? '').trim();
                  if (!text || !isAbsolutePath(text) || !docDirRef.current) return false;

                  const relPath = computeRelativePath(docDirRef.current, text);
                  const filename = text.split(/[\\/]/).pop() ?? text;
                  const dropPos = view.posAtCoords({left: e.clientX, top: e.clientY})?.pos ?? -1;
                  if (dropPos < 0) return false;

                  const {schema} = view.state;

                  if (DRAWIO_EXT.test(text)) {
                    const drawioType = schema.nodes['drawio'];
                    if (!drawioType) return false;
                    const fakeSlice = new Slice(Fragment.from(drawioType.create({src: 'x'})), 0, 0);
                    const insertPos = dropPoint(view.state.doc, dropPos, fakeSlice) ?? dropPos;
                    view.dispatch(
                      view.state.tr.insert(insertPos, drawioType.create({src: relPath})).scrollIntoView(),
                    );
                  } else if (IMAGE_EXTS.test(text)) {
                    const imgType = schema.nodes['image'];
                    if (!imgType) return false;
                    const fakeSlice = new Slice(Fragment.from(imgType.create({src: 'x'})), 0, 0);
                    const insertPos = dropPoint(view.state.doc, dropPos, fakeSlice) ?? dropPos;
                    view.dispatch(
                      view.state.tr.insert(insertPos, imgType.create({src: relPath, alt: filename})).scrollIntoView(),
                    );
                  } else {
                    const linkMark = schema.marks['link'];
                    if (!linkMark) return false;
                    const textNode = schema.text(filename, [linkMark.create({href: relPath})]);
                    view.dispatch(view.state.tr.insert(dropPos, textNode).scrollIntoView());
                  }

                  e.preventDefault();
                  return true;
                },
              },
            },
          }), b.Priority.VeryHigh);
        });
      },
    },
  });

  const applyingExternal = useRef(false);

  useEffect(() => {
    function onChange() {
      if (applyingExternal.current) return;
      vscode.postMessage({type: 'edit', text: mdEditor.getValue()});
    }
    mdEditor.on('change', onChange);
    return () => mdEditor.off('change', onChange);
  }, [mdEditor]);

  // Handle subsequent external updates (e.g. git checkout, tab visibility refresh)
  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      if (msg.type !== 'update') return;
      applyingExternal.current = true;
      mdEditor.replace(msg.text);
      // Reset after a tick so async change events fired by replace() are also suppressed.
      setTimeout(() => { applyingExternal.current = false; }, 0);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mdEditor]);

  // Notify NodeViews (e.g. drawio) when WYSIWYG mode is resumed so they can re-render.
  // ProseMirror NodeViews are created via replace() while the PM DOM may still be detached
  // from the document (React hasn't re-mounted WysiwygEditorComponent yet), so any
  // synchronous rendering (inline XML) or size-dependent rendering (mxGraph auto-fit) done
  // at NodeView construction time may produce incorrect results. Re-rendering after React
  // has mounted fixes this.
  useEffect(() => {
    function onModeChange({mode}: {mode: MarkdownEditorMode}) {
      if (mode === 'wysiwyg') {
        // Defer until after React has committed and useEffect has attached the PM DOM.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            window.dispatchEvent(new CustomEvent(WYSIWYG_RESUMED_EVENT)),
          ),
        );
      }
    }
    mdEditor.on('change-editor-mode', onModeChange);
    return () => mdEditor.off('change-editor-mode', onModeChange);
  }, [mdEditor]);

  // Re-fetch all images in the editor when the tab becomes visible (handles externally edited images).
  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionMessage>) {
      if (event.data?.type !== 'reloadImages') return;
      const ts = Date.now();
      document.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
        const src = img.src;
        if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
        try {
          const url = new URL(src);
          url.searchParams.set('_t', String(ts));
          img.src = url.toString();
        } catch {
          // non-parseable src - skip
        }
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Require Ctrl+click (or Cmd+click) to follow links inside the editor content area.
  // Scoped to .ProseMirror so gravity-ui popup buttons (which also render as <a href>) are unaffected.
  useEffect(() => {
    function onLinkClick(e: MouseEvent) {
      const anchor = (e.target as Element).closest('a[href]');
      if (!anchor) return;
      if (!anchor.closest('.ProseMirror')) return;
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener('click', onLinkClick, true);
    return () => document.removeEventListener('click', onLinkClick, true);
  }, []);

  return <MarkdownEditorView editor={mdEditor} autofocus stickyToolbar toolbarsPreset={customPreset} />;
}
