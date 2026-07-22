import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {EditorView} from '@codemirror/view';
import {Sliders, NodesRight} from '@gravity-ui/icons';

import {Mermaid} from '@gravity-ui/markdown-editor/extensions/additional/Mermaid/index.js';
import {LatexExtension} from '@gravity-ui/markdown-editor-latex-extension';
import {
  wLatexBlockItemData,
  wLatexInlineItemData,
  latexInlineItemView,
  latexInlineItemWysiwyg,
  latexInlineItemMarkup,
  latexBlockItemView,
  latexBlockItemWysiwyg,
  latexBlockItemMarkup,
  latexListItemView,
} from '@gravity-ui/markdown-editor-latex-extension/configs';
import {Drawio, WYSIWYG_RESUMED_EVENT} from './DrawioExtension';
import {MdTableDnd} from './MdTableDnd';
import {MarkdownEditorView, useMarkdownEditor, wysiwygToolbarConfigs} from '@gravity-ui/markdown-editor';
import type {ToolbarsPreset} from '@gravity-ui/markdown-editor';
// The _/* wildcard export is the library's documented pattern for toolbar customisation —
// the library's own demo (demo/src/stories/presets/presets.ts) uses these same paths.
import {ActionName as Action} from '@gravity-ui/markdown-editor/_/bundle/config/action-names.js';
import {ListName as List} from '@gravity-ui/markdown-editor/_/modules/toolbars/constants.js';
import {full as fullPreset} from '@gravity-ui/markdown-editor/_/modules/toolbars/presets.js';
import {mermaidItemView, mermaidItemWysiwyg, mermaidItemMarkup} from '@gravity-ui/markdown-editor/_/modules/toolbars/items.js';
import {ToolbarDataType} from '@gravity-ui/markdown-editor/_/bundle/toolbar/types.js';
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

// The library's own default "Table" entry (toolbar button and `/` slash-menu, both driven by
// this same object) inserts a YFM table (`e.actions.createYfmTable`). We offer a GFM (standard
// pipe-table) alternative and keep both surfaces in sync with whichever the user configures.
const tableWysiwygHandlers = {
  gfm: {
    exec: (e) => e.actions.createTable.run(),
    isActive: (e) => e.actions.createTable.isActive(),
    isEnable: (e) => e.actions.createTable.isEnable(),
  },
  yfm: {
    exec: (e) => e.actions.createYfmTable.run(),
    isActive: (e) => e.actions.createYfmTable.isActive(),
    isEnable: (e) => e.actions.createYfmTable.isEnable(),
  },
} satisfies Record<'gfm' | 'yfm', Pick<typeof wysiwygToolbarConfigs.wTableItemData, 'exec' | 'isActive' | 'isEnable'>>;

// EditorView.theme() has higher priority than baseTheme() in CM6 — overrides the library's gravityTheme.
const vscodeFontTheme = EditorView.theme({
  '.cm-content': {
    fontFamily: 'var(--vscode-editor-font-family) !important',
    fontSize: 'var(--vscode-editor-font-size) !important',
  },
});

type EditorConfig = Extract<ExtensionMessage, {type: 'config'}>;

function buildFontCss(cfg: EditorConfig): string {
  const gRoot: string[] = [];
  const prose: string[] = [];
  const code: string[] = [];
  if (cfg.fontFamily) {
    gRoot.push(`--g-font-family-sans: ${cfg.fontFamily};`);
    prose.push(`font-family: ${cfg.fontFamily};`);
  }
  if (cfg.monospaceFontFamily) {
    gRoot.push(`--g-font-family-monospace: ${cfg.monospaceFontFamily};`);
    gRoot.push(`--yfm-font-family-monospace: ${cfg.monospaceFontFamily};`);
  }
  if (cfg.fontSize > 0) prose.push(`font-size: ${cfg.fontSize}px;`);
  if (cfg.monospaceFontSize > 0) {
    gRoot.push(`--g-text-code-2-font-size: ${cfg.monospaceFontSize}px;`);
    code.push(`font-size: ${cfg.monospaceFontSize}px;`);
  }
  const parts: string[] = [];
  if (gRoot.length) parts.push(`.g-root { ${gRoot.join(' ')} }`);
  if (prose.length) parts.push(`.ProseMirror { ${prose.join(' ')} }`);
  if (code.length) parts.push(`.g-root .g-md-editor.ProseMirror pre > code { ${code.join(' ')} }`);
  return parts.join('\n');
}

// The library emits `change` synchronously inside every ProseMirror transaction dispatch
// (i.e. per key-repeat), and serializing the whole document to markdown there blocks the
// webview UI thread — on large documents held-Backspace visibly stalled the cursor.
// Edits are therefore posted on a pure trailing debounce: nothing is serialized while
// typing is continuous (a periodic mid-typing flush caused visible frame drops), and the
// TextDocument catches up shortly after the user pauses. Correctness at the moments that
// matter is covered by forced flushes: save (`requestFlush` from onWillSaveTextDocument),
// window blur, tab hidden, and editor mode switch.
const EDIT_DEBOUNCE_MS = 300;

const IMAGE_EXTS = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?)$/i;
const DRAWIO_EXT = /\.drawio$/i;

const MD_TABLE =
  '\n| Heading | Heading |\n| ------- | ------- |\n| Text    | Text    |\n| Text    | Text    |\n';


function isAbsolutePath(s: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(s) || s.startsWith('/');
}

// Percent-encode a relative path for use as a markdown link destination.
// CommonMark forbids raw spaces in destinations, and unbalanced ()/# also break
// or truncate the link in strict parsers, even though the gravity editor's
// lenient markdown-it accepts them.
function encodeMdPath(p: string): string {
  return encodeURI(p).replace(/[()#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
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
  const [theme, setTheme] = useState<'light' | 'dark' | 'light-hc' | 'dark-hc'>('light');
  const [config, setConfig] = useState<EditorConfig | null>(null);
  const docDirRef = useRef('');
  const styleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    const style = document.createElement('style');
    document.head.appendChild(style);
    styleRef.current = style;
    return () => { style.remove(); styleRef.current = null; };
  }, []);

  useEffect(() => {
    if (styleRef.current) styleRef.current.textContent = config ? buildFontCss(config) : '';
  }, [config]);

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
    function onConfig(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      if (msg.type !== 'config') return;
      setTheme(msg.theme);
      setConfig(msg);
    }
    window.addEventListener('message', onConfig);
    return () => window.removeEventListener('message', onConfig);
  }, []);

  useEffect(() => {
    vscode.postMessage({type: 'ready'});
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <ToasterProvider toaster={toaster}>
        <ToasterComponent />
        <div style={{height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative'}}>
          {initialMarkup === null || config === null ? (
            <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'var(--g-color-base-background, #fff)',
              color: 'var(--g-color-text-secondary, #9d9d9d)', fontSize: 13}}>
              Loading editor…
            </div>
          ) : (
            <LoadedEditor initialMarkup={initialMarkup} docDirRef={docDirRef} config={config} />
          )}
        </div>
      </ToasterProvider>
    </ThemeProvider>
  );
}

const execOpenSettings = () => vscode.postMessage({type: 'openSettings'});

const openSettingsItem = {
  view: {type: ToolbarDataType.SingleButton, icon: {data: Sliders}, title: 'Editor Settings'},
  wysiwyg: {isActive: () => false, isEnable: () => true, exec: execOpenSettings},
  markup:  {isActive: () => false, isEnable: () => true, exec: execOpenSettings},
} as const;

// Drawio insertion is async (a native VS Code save dialog + file write), so the button just
// requests it; the resulting node is inserted once 'drawioFileCreated' comes back (see
// LoadedEditor's message listener below).
const execInsertDrawio = () => vscode.postMessage({type: 'insertDrawio'});

const drawioWysiwygHandlers = {
  isActive: () => false,
  isEnable: (e) => e.actions.insertDrawio.isEnable(),
  exec: execInsertDrawio,
} satisfies Pick<typeof wysiwygToolbarConfigs.wTableItemData, 'exec' | 'isActive' | 'isEnable'>;

const drawioItem = {
  view: {type: ToolbarDataType.SingleButton, icon: {data: NodesRight}, title: 'Draw.io Diagram'},
  wysiwyg: drawioWysiwygHandlers,
  markup:  {isActive: () => false, isEnable: () => true, exec: execInsertDrawio},
} as const;

function LoadedEditor({initialMarkup, docDirRef, config}: {initialMarkup: string; docDirRef: React.RefObject<string>; config: EditorConfig}) {
  // The library's `change` event fires synchronously inside the currentMode setter (via
  // replace() → onDocChange) which is BEFORE `change-editor-mode` is emitted.  We therefore
  // cannot use `change-editor-mode` to set the suppression flag in time.  The only hook that
  // fires before the setter — and thus before the spurious `change` — is
  // `experimental.beforeEditorModeChange`.
  const modeChangingRef = useRef(false);

  // Set after flushEdit is defined below (it needs the editor instance this hook returns);
  // beforeEditorModeChange only fires on user interaction, long after the first render.
  const flushEditRef = useRef<() => void>(() => {});

  // Slash-menu entries for extensions that aren't in the library's default command-menu list,
  // plus the library's default Table entry patched to match the configured table format.
  // An empty actions array makes the library's CommandMenu extension skip wiring the `/`
  // trigger entirely (see extensions/behavior/CommandMenu/index.js), which is how the
  // enableSlashCommands setting turns the menu off.
  const commandMenuActions = useMemo(() => {
    if (!config.enableSlashCommands) return [];
    return wysiwygToolbarConfigs.wCommandMenuConfig.map((item) =>
      item.id === Action.table ? {...item, ...tableWysiwygHandlers[config.newTableFormat]} : item,
    ).concat(
      wysiwygToolbarConfigs.wMermaidItemData,
      wLatexInlineItemData,
      wLatexBlockItemData,
    );
  }, [config.newTableFormat, config.enableSlashCommands]);

  const mdEditor = useMarkdownEditor({
    initial: {markup: initialMarkup, mode: config.defaultMode},
    preset: 'full',
    md: {html: true},
    experimental: {
      preserveEmptyRows: config.preserveEmptyLines,
      preserveMarkupFormatting: config.preserveMarkupFormatting,
      beforeEditorModeChange: () => {
        // Post any pending debounced edit before mode-switch change events are suppressed.
        flushEditRef.current();
        modeChangingRef.current = true;
        setTimeout(() => { modeChangingRef.current = false; }, 0);
        // Returning undefined (not false) lets the mode change proceed.
        return undefined;
      },
    },
    markupConfig: {
      extensions: [vscodeFontTheme],
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

        builder.use(LatexExtension, {
          loadRuntimeScript: () => {
            import('@diplodoc/latex-extension/runtime');
            import('@diplodoc/latex-extension/runtime/styles');
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
                      view.state.tr.insert(insertPos, imgType.create({src: encodeMdPath(relPath), alt: filename})).scrollIntoView(),
                    );
                  } else {
                    const linkMark = schema.marks['link'];
                    if (!linkMark) return false;
                    const textNode = schema.text(filename, [linkMark.create({href: encodeMdPath(relPath)})]);
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
      extensionOptions: {
        // Without these, a literal `|` inside math (e.g. `$|x|$`, matrix/determinant
        // notation) on a table line gets misread as a column separator by the table parser.
        yfmTable: {
          table_ignoreSplittersInBlockMath: true,
          table_ignoreSplittersInInlineMath: true,
        },
        commandMenu: {
          actions: commandMenuActions,
        },
      },
    },
  });

  const customPreset = useMemo<ToolbarsPreset>(() => ({
    ...fullPreset,
    items: {
      ...fullPreset.items,
      [Action.table]: {
        ...fullPreset.items[Action.table],
        wysiwyg: tableWysiwygHandlers[config.newTableFormat],
        markup: {
          exec: (e) => e.cm.dispatch(e.cm.state.replaceSelection(MD_TABLE)),
          isActive: () => false,
          isEnable: () => true,
        },
      },
      [Action.mermaid]: {
        view: mermaidItemView,
        wysiwyg: mermaidItemWysiwyg,
        markup: mermaidItemMarkup,
      },
      [Action.mathInline]: {
        view: latexInlineItemView,
        wysiwyg: latexInlineItemWysiwyg,
        markup: latexInlineItemMarkup,
      },
      [Action.mathBlock]: {
        view: latexBlockItemView,
        wysiwyg: latexBlockItemWysiwyg,
        markup: latexBlockItemMarkup,
      },
      [List.math]: {
        view: latexListItemView,
      },
      drawio: drawioItem,
      openSettings: openSettingsItem,
    },
    orders: {
      ...fullPreset.orders,
      wysiwygMain: [
        ...fullPreset.orders.wysiwygMain,
        [Action.mermaid, {id: List.math, items: [Action.mathInline, Action.mathBlock]}, 'drawio'],
        ['openSettings'],
      ],
      markupMain: [
        ...fullPreset.orders.markupMain,
        [Action.mermaid, {id: List.math, items: [Action.mathInline, Action.mathBlock]}, 'drawio'],
        ['openSettings'],
      ],
    },
  }), [config.newTableFormat]);

  const applyingExternal = useRef(false);
  const editTimerRef = useRef<number | undefined>(undefined);
  const editPendingRef = useRef(false);

  const cancelPendingEdit = useCallback(() => {
    window.clearTimeout(editTimerRef.current);
    editTimerRef.current = undefined;
    editPendingRef.current = false;
  }, []);

  const flushEdit = useCallback(() => {
    if (!editPendingRef.current) return;
    cancelPendingEdit();
    vscode.postMessage({type: 'edit', text: mdEditor.getValue()});
  }, [mdEditor, cancelPendingEdit]);

  useEffect(() => {
    flushEditRef.current = flushEdit;
  }, [flushEdit]);

  useEffect(() => {
    function onChange() {
      if (applyingExternal.current || modeChangingRef.current) return;
      editPendingRef.current = true;
      window.clearTimeout(editTimerRef.current);
      editTimerRef.current = window.setTimeout(flushEdit, EDIT_DEBOUNCE_MS);
    }
    mdEditor.on('change', onChange);
    return () => mdEditor.off('change', onChange);
  }, [mdEditor, flushEdit]);

  // Push out pending edits when focus/visibility is lost, and best-effort on unmount,
  // so the TextDocument catches up before the user interacts with anything else.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') flushEdit();
    }
    window.addEventListener('blur', flushEdit);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', flushEdit);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushEdit();
    };
  }, [flushEdit]);

  // Save-time flush: the extension's onWillSaveTextDocument participant asks for the
  // current content and applies any difference as part of the save itself.
  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      if (msg.type !== 'requestFlush') return;
      // Hand the content over via flushResponse instead of a separate 'edit' message —
      // applyEdit is not reliable inside the willSave window, waitUntil TextEdits are.
      cancelPendingEdit();
      vscode.postMessage({type: 'flushResponse', id: msg.id, text: mdEditor.getValue()});
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mdEditor, cancelPendingEdit]);

  // Insert the drawio node once the extension has created the file (see drawioItem above).
  // mdEditor.insert() parses the given markup with the same md-it pipeline used for
  // paste/prepend/append, so a ```drawio fence is recognised via the Drawio extension's
  // drawioMarkdownPlugin and turned into a proper drawio node - in either editor mode.
  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      if (msg.type !== 'drawioFileCreated') return;
      mdEditor.insert('```drawio\n' + msg.src + '\n```\n');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mdEditor]);

  // Handle subsequent external updates (e.g. git checkout, tab visibility refresh)
  useEffect(() => {
    function onMessage(event: MessageEvent<ExtensionMessage>) {
      const msg = event.data;
      if (msg.type !== 'update') return;
      // The document is authoritative here; a pending debounced edit is stale.
      cancelPendingEdit();
      // Skip the cursor-resetting replace() when content already matches — e.g. the
      // onDidChangeTextDocument echo of a save-flush TextEdit we produced ourselves.
      if (msg.text === mdEditor.getValue()) return;
      applyingExternal.current = true;
      mdEditor.replace(msg.text);
      // Reset after a tick so async change events fired by replace() are also suppressed.
      setTimeout(() => { applyingExternal.current = false; }, 0);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mdEditor, cancelPendingEdit]);

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

  // Clicking a link inside the editor content area positions the cursor there (default
  // ProseMirror behaviour) instead of navigating - the library's own link tooltip then
  // appears with a dedicated "follow link" button. Scoped to .ProseMirror so gravity-ui
  // popup buttons (which also render as <a href>) are unaffected.
  useEffect(() => {
    function onLinkClick(e: MouseEvent) {
      const anchor = (e.target as Element).closest('a[href]');
      if (!anchor) return;
      if (anchor.getAttribute('target') === '_blank') {
        // target="_blank" (e.g. the library's built-in Documentation and follow-link
        // buttons) tries to open a new browsing context, which the webview iframe's
        // sandbox silently blocks (no allow-popups) - forward it to the extension host.
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({type: 'openExternal', url: (anchor as HTMLAnchorElement).href});
        return;
      }
      if (!anchor.closest('.ProseMirror')) return;
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener('click', onLinkClick, true);
    return () => document.removeEventListener('click', onLinkClick, true);
  }, []);

  return <MarkdownEditorView editor={mdEditor} autofocus stickyToolbar toolbarsPreset={customPreset} />;
}
