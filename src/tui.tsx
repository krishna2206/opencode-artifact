/** @jsxImportSource @opentui/solid */

// opencode-artifact: TUI side. The session's artifact in the side panel:
// rendered Markdown to read and comment, raw Markdown to edit, and the
// comments waiting to be sent. `s` sends them to the agent as one message.

import { Plugin } from "@opencode/plugin/tui";
import { RGBA, TextAttributes, type Renderable, type Selection, type TextareaRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { EMPTY_ARTIFACT, exists, locateQuote, type Artifact, type Comment } from "./artifact.js";
import { layout } from "./layout.js";
import { ArtifactRpc } from "./rpc.js";
import { buildSyntax, COMMENT_STYLE } from "./syntax.js";

type Ctx = Plugin.Context;
type PanelInput = Parameters<Extract<Parameters<Ctx["ui"]["slot"]>[0], { append: "session.panel" }>["render"]>[0];

const id = "opencode-artifact";
/** The panel name, shared by every plugin's `session.panel` claims: ours render only for this one. */
const PANEL = "opencode-artifact";
const COMMENT_TYPE = "artifact-comment";

interface Options {
  /** Open the panel when the agent writes the artifact of the session on screen. */
  autoOpen: boolean;
}

const readOptions = (options: Readonly<Record<string, unknown>>): Options => ({
  autoOpen: options.autoOpen !== false,
});

/** The session's directory: RPC calls must reach the server plugin of that location. */
function sessionLocation(ctx: Ctx, sessionID: string) {
  const directory = ctx.data.session.get(sessionID)?.location.directory ?? ctx.location?.directory;
  return directory ? { directory } : undefined;
}

const currentSession = (ctx: Ctx) => {
  const route = ctx.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
};

const truncate = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
};

function isWithin(renderable: Renderable | null | undefined, container: Renderable | undefined): boolean {
  for (let current = renderable; current && container; current = current.parent as Renderable | null) {
    if (current === container) return true;
  }
  return false;
}

/** The palette entry, the /artifact slash command, and the automatic opening. */
function Commands(props: { ctx: Ctx; options: Options }) {
  const ctx = props.ctx;
  const client = ctx.client.rpc(ArtifactRpc);
  const isOpen = () => ctx.ui.panel.current()?.name === PANEL;

  const toggle = () => {
    ctx.ui.dialog.clear();
    if (isOpen()) {
      ctx.ui.panel.close();
      return;
    }
    if (!currentSession(ctx)) {
      ctx.ui.toast.show({ message: "Open a session first: the artifact belongs to a session.", variant: "warning" });
      return;
    }
    ctx.ui.panel.open(PANEL);
  };

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "artifact.toggle",
        title: "Show Artifacts",
        group: "Artifact",
        palette: true,
        slash: { name: "artifact" },
        run: toggle,
      },
    ],
  }));

  if (props.options.autoOpen) {
    // Only for the session on screen: the panel opens in the current session.
    const unsubscribe = client.events.on("changed", (event) => {
      if (event.data.by !== "agent" || event.data.sessionID !== currentSession(ctx) || isOpen()) return;
      if (!ctx.ui.panel.open(PANEL)) return;
      // Opening a panel focuses it. Opened by the agent, it must not take the
      // keyboard from the prompt: the user may be typing the next message.
      setTimeout(() => ctx.keymap.dispatch("pane.focus.left"), 50);
    });
    onCleanup(unsubscribe);
  }

  return null;
}

type Mode = "view" | "edit";

function ArtifactPanel(props: { ctx: Ctx; input: PanelInput }) {
  const ctx = props.ctx;
  const theme = () => ctx.theme;
  const client = ctx.client.rpc(ArtifactRpc);
  const sessionID = () => props.input.sessionID;
  const location = () => ({ location: sessionLocation(ctx, sessionID()) });

  const [artifact, setArtifact] = createSignal<Artifact>(EMPTY_ARTIFACT);
  const [loaded, setLoaded] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("view");
  /** The text the edit started from: a save is refused if the document moved since. */
  const [editBase, setEditBase] = createSignal("");
  /** The last passage selected with the mouse in the rendered view. */
  const [selected, setSelected] = createSignal("");
  /** One of the panel's dialogs is open: its keys are for the dialog. */
  const [asking, setAsking] = createSignal(false);
  const ask = async <T,>(open: () => Promise<T>): Promise<T> => {
    setAsking(true);
    try {
      return await open();
    } finally {
      setAsking(false);
    }
  };

  const syntax = createMemo(() => buildSyntax(ctx.theme));
  createEffect(() => {
    const style = syntax();
    onCleanup(() => style.destroy());
  });

  let panelBox: Renderable | undefined;
  let editor: TextareaRenderable | undefined;

  let requested = 0;
  const load = async () => {
    const ticket = ++requested;
    try {
      const next = (await client.get({ sessionID: sessionID() }, location())) as Artifact;
      if (ticket !== requested) return;
      setArtifact(next);
      setLoaded(true);
    } catch {
      // Server plugin not ready or not loaded: keep what is shown.
    }
  };

  createEffect(
    on(sessionID, () => {
      setArtifact(EMPTY_ARTIFACT);
      setLoaded(false);
      setMode("view");
      setSelected("");
      void load();
      const unsubscribe = client.events.on("changed", (event) => {
        if (event.data.sessionID === sessionID()) void load();
      });
      onCleanup(unsubscribe);
    }),
  );

  // Any key press clears a mouse selection in the host (it only keeps an
  // editor's), so the selection is captured when the mouse lets go of it.
  const onSelection = (selection: Selection | null) => {
    if (!selection || mode() !== "view") return;
    const inPanel = selection.selectedRenderables.some((renderable) => isWithin(renderable, panelBox));
    setSelected(inPanel ? selection.getSelectedText().trim() : "");
  };

  // A captured passage stays until it is commented or cancelled with esc,
  // even once a key press has cleared its highlight on screen. The host takes
  // esc while a selection is on screen (to clear it) and nothing tells a
  // plugin a selection was cleared, so esc is watched ahead of the host.
  const onKey = (event: { name?: string }) => {
    if (event.name === "escape" && selected() && !asking()) setSelected("");
  };
  ctx.renderer.keyInput.prependListener("keypress", onKey);
  onCleanup(() => ctx.renderer.keyInput.off("keypress", onKey));
  ctx.renderer.on("selection", onSelection);
  onCleanup(() => ctx.renderer.off("selection", onSelection));

  // Commented passages highlighted in the editor.
  const highlight = () => {
    if (!editor || editor.isDestroyed) return;
    const typeId = editor.extmarks.getTypeId(COMMENT_TYPE) ?? editor.extmarks.registerType(COMMENT_TYPE);
    const styleId = syntax().getStyleId(COMMENT_STYLE);
    for (const mark of editor.extmarks.getAllForTypeId(typeId)) editor.extmarks.delete(mark.id);
    if (styleId === null) return;
    const text = editor.plainText;
    for (const comment of artifact().comments) {
      const range = locateQuote(text, comment.quote);
      if (range) editor.extmarks.create({ start: range.start, end: range.end, styleId, typeId, data: comment.id });
    }
  };
  createEffect(on(() => [artifact().comments, mode()] as const, () => queueMicrotask(highlight)));

  const startEdit = () => {
    if (!exists(artifact())) return;
    setEditBase(artifact().content);
    setMode("edit");
  };

  const stopEdit = () => {
    setMode("view");
    props.input.focus();
  };

  const save = async (base = editBase()) => {
    if (!editor) return;
    const content = editor.plainText;
    const result = (await client.save({ sessionID: sessionID(), content, base }, location())) as {
      saved: boolean;
      artifact: Artifact;
    };
    if (result.saved) {
      setArtifact(result.artifact);
      stopEdit();
      return;
    }
    const overwrite = await ask(() => ctx.ui.dialog.confirm({
      title: "The artifact changed",
      message: "The agent changed the document since you started editing. Replace its version with yours?",
      label: { confirm: "Replace", cancel: "Keep editing" },
    }));
    if (overwrite) await save(result.artifact.content);
  };

  const discard = async () => {
    if (editor && editor.plainText !== editBase()) {
      const ok = await ask(() => ctx.ui.dialog.confirm({
        title: "Discard your changes?",
        message: "The edits made since you entered the editor will be lost.",
        label: { confirm: "Discard", cancel: "Keep editing" },
      }));
      if (!ok) return;
    }
    stopEdit();
  };

  const comment = async () => {
    if (!exists(artifact())) return;
    const quote = mode() === "edit" ? (editor?.getSelectedText() ?? "").trim() : selected();
    // A comment is about a passage: a remark on the whole document goes in the chat.
    if (!quote) {
      if (mode() === "edit") ctx.ui.toast.show({ message: "Select a passage to comment on it.", variant: "info" });
      return;
    }
    const note = await ask(() => ctx.ui.dialog.prompt({
      title: "Comment on the selection",
      description: `“${truncate(quote, 160)}”`,
      placeholder: "Your comment",
    }));
    if (!note?.trim()) return;
    const next = (await client.comment({ sessionID: sessionID(), quote, note }, location())) as Artifact;
    setArtifact(next);
    setSelected("");
    ctx.renderer.clearSelection();
    if (mode() === "view") returnFocus();
  };

  // Back to the prompt once a comment is added or the review sent: what the
  // user types next is a message, not the panel's one-letter keys. Selecting
  // a passage with the mouse focuses the panel again.
  const returnFocus = () => setTimeout(() => ctx.keymap.dispatch("pane.focus.left"), 50);

  const uncomment = async (commentID: string): Promise<void> => {
    const next = (await client.uncomment({ sessionID: sessionID(), commentID }, location())) as Artifact;
    setArtifact(next);
  };

  const send = async () => {
    if (artifact().comments.length === 0) return;
    const { text } = (await client.submit({ sessionID: sessionID() }, location())) as { text: string };
    if (!text) return;
    try {
      // Queued: a running turn finishes before the agent reads the review.
      await ctx.client.session.prompt({ sessionID: sessionID(), text, delivery: "queue" });
      ctx.ui.toast.show({ message: "Review sent to the agent.", variant: "success" });
      returnFocus();
    } catch (error) {
      ctx.ui.toast.show({ message: `Could not send the review: ${String(error)}`, variant: "error" });
    }
  };

  const idle = () => !selected();
  // A review goes out with at least one comment; edits alone wait for one.
  const canSend = () => idle() && artifact().comments.length > 0;
  ctx.keymap.layer(() => ({
    enabled: () => props.input.focused && !asking() && mode() === "view",
    priority: 10,
    // While a passage is selected, only commenting it (or esc) is possible.
    commands: [
      { bind: "c", title: "Comment", group: "Artifact", enabled: () => !!selected(), run: () => void comment() },
      { bind: "e", title: "Edit", group: "Artifact", enabled: idle, run: startEdit },
      { bind: "s", title: "Send review", group: "Artifact", enabled: canSend, run: () => void send() },
      { bind: "f", title: "Fullscreen", group: "Artifact", enabled: idle, run: () => props.input.toggleFullscreen() },
      { bind: "q", title: "Close", group: "Artifact", enabled: idle, run: () => props.input.close() },
    ],
  }));

  ctx.keymap.layer(() => ({
    enabled: () => props.input.focused && !asking() && mode() === "edit",
    priority: 10,
    commands: [
      { bind: "ctrl+s", title: "Save", group: "Artifact", run: () => void save() },
      { bind: "ctrl+k", title: "Comment the selection", group: "Artifact", run: () => void comment() },
      { bind: "ctrl+d", title: "Discard changes", group: "Artifact", run: () => void discard() },
    ],
  }));

  const hints = () =>
    mode() === "edit"
      ? "ctrl+s save · ctrl+k comment · ctrl+d discard"
      : selected()
        ? "c comment · esc cancel"
        : `e edit${artifact().comments.length > 0 ? " · s send" : ""} · f fullscreen · q close`;

  // Each top-level block of the document, followed by the comments on it.
  const placed = createMemo(() => layout(artifact().content, artifact().comments));
  // The prompt's own background (see the host's prompt component), from the active theme.
  const commentedBackground = () => (theme() as any).decrease(theme().background.raised.base) as RGBA;
  const markdownText = () => (theme() as any).markdown?.text ?? theme().text.base;
  const reviewSummary = () => {
    const current = artifact();
    if (!exists(current) || current.comments.length === 0) return "";
    const count = current.comments.length;
    const parts = [
      ...(count > 0 ? [`${count} comment${count > 1 ? "s" : ""}`] : []),
      ...(current.editedByUser ? ["your edits"] : []),
    ];
    return `${parts.join(" + ")} ready to send to the agent`;
  };
  const commentCount = () => {
    const count = artifact().comments.length;
    return count === 0 ? "" : ` · ${count} comment${count > 1 ? "s" : ""}`;
  };

  const changedWhileEditing = () => mode() === "edit" && artifact().content !== editBase();

  return (
    <box
      ref={(value: Renderable) => (panelBox = value)}
      // The host copies a mouse selection to the clipboard when the button is
      // released over it, at the root of the screen. In the panel a selection
      // is for commenting: the release stops here, the chat keeps copying.
      onMouseUp={(event: { isDragging?: boolean; stopPropagation: () => void }) => {
        if (event.isDragging) event.stopPropagation();
      }}
      flexDirection="column"
      width="100%"
      height="100%"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <Show
        when={exists(artifact())}
        fallback={
          <box flexGrow={1}>
            <text fg={theme().text.muted}>
              {loaded()
                ? "No artifact in this session yet. Ask the agent to write one (a plan, a spec…)."
                : "Loading the artifact…"}
            </text>
          </box>
        }
      >
        <box flexDirection="row" flexShrink={0} gap={1}>
          <text fg={theme().text.base} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1} minWidth={0} truncate>
            {artifact().title}
          </text>
          <text fg={theme().text.muted} wrapMode="none" flexShrink={0}>
            {`rev ${artifact().revision}${commentCount()}${artifact().editedByUser ? " · edited" : ""}${mode() === "edit" ? " · editing" : ""}`}
          </text>
        </box>
        <Show when={changedWhileEditing()}>
          <text fg={theme().text.feedback.warning.base} flexShrink={0}>
            The agent changed the document while you edit it.
          </text>
        </Show>
        <box flexGrow={1} minHeight={0} marginTop={1}>
          <Show
            when={mode() === "edit"}
            fallback={
              <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
                <For each={placed().blocks}>
                  {(block, index) => (
                    <box flexDirection="column" flexShrink={0} marginTop={index() === 0 ? 0 : 1}>
                      {/* A commented block takes the prompt's background, to show what the comments are about. */}
                      <box
                        flexShrink={0}
                        paddingLeft={1}
                        paddingRight={1}
                        // A row above and below a commented block, like the prompt's own padding.
                        paddingTop={block.comments.length > 0 ? 1 : 0}
                        paddingBottom={block.comments.length > 0 ? 1 : 0}
                        backgroundColor={block.comments.length > 0 ? commentedBackground() : undefined}
                      >
                        <markdown
                          syntaxStyle={syntax()}
                          content={block.raw.trimEnd()}
                          conceal
                          internalBlockMode="top-level"
                          tableOptions={{ style: "grid", cellPaddingX: 1 }}
                          fg={markdownText()}
                          bg={block.comments.length > 0 ? commentedBackground() : undefined}
                        />
                      </box>
                      <For each={block.comments}>
                        {(comment, position) => (
                          <CommentCard ctx={ctx} comment={comment} onRemove={uncomment} first={position() === 0} />
                        )}
                      </For>
                    </box>
                  )}
                </For>
                <Show when={placed().trailing.length > 0}>
                  <box flexDirection="column" flexShrink={0} marginTop={1}>
                    <For each={placed().trailing}>
                      {(comment, position) => (
                        <CommentCard ctx={ctx} comment={comment} onRemove={uncomment} first={position() === 0} showQuote />
                      )}
                    </For>
                  </box>
                </Show>
              </scrollbox>
            }
          >
            <textarea
              width="100%"
              flexGrow={1}
              initialValue={editBase()}
              textColor={theme().text.base}
              focusedTextColor={theme().text.base}
              focusedBackgroundColor="transparent"
              cursorColor={theme().text.base}
              syntaxStyle={syntax()}
              ref={(value: TextareaRenderable) => {
                editor = value;
                setTimeout(() => {
                  if (!value.isDestroyed) value.focus();
                  highlight();
                }, 0);
              }}
            />
          </Show>
        </box>
        <Show when={mode() === "view" && selected()}>
          <text fg={theme().text.feedback.warning.base} wrapMode="none" truncate flexShrink={0}>
            {`Selected: “${truncate(selected(), Math.max(10, props.input.width - 14))}”`}
          </text>
        </Show>
      </Show>
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        {/* What `s` would send, always in view: no scrolling to count the comments. */}
        <Show when={reviewSummary()}>
          <text fg={theme().text.feedback.warning.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
            {reviewSummary()}
          </text>
        </Show>
        <text fg={theme().text.muted} wrapMode="none" truncate>
          {hints()}
        </text>
      </box>
    </box>
  );
}

/**
 * A comment under the block it is about, in the theme's text and background
 * colours swapped: it stands out from the document whatever the theme.
 * `showQuote`: for comments that could not be placed, the passage says what they are about.
 */
function CommentCard(props: {
  ctx: Ctx;
  comment: Comment;
  onRemove: (commentID: string) => void;
  first: boolean;
  showQuote?: boolean;
}) {
  const theme = () => props.ctx.theme;
  const background = () => theme().text.base;
  // The theme's background as text colour. A transparent theme leaves its base
  // background empty (the terminal's shows through): take the first opaque one.
  const foreground = () => {
    const candidates: RGBA[] = [theme().background.base, theme().background.raised.base];
    const opaque = candidates.find((color) => color.a > 0);
    return opaque ? RGBA.fromValues(opaque.r, opaque.g, opaque.b, 1) : RGBA.fromValues(0, 0, 0, 1);
  };
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      marginTop={props.first ? 0 : 1}
      backgroundColor={background()}
    >
      <box flexDirection="row" gap={1}>
        <text fg={foreground()} attributes={TextAttributes.BOLD} flexGrow={1} selectable={false}>
          Comment
        </text>
        <text fg={foreground()} flexShrink={0} selectable={false} onMouseUp={() => props.onRemove(props.comment.id)}>
          ✕
        </text>
      </box>
      <text fg={foreground()} selectable={false}>
        {props.comment.note}
      </text>
      <Show when={props.showQuote && props.comment.quote}>
        <text fg={foreground()} attributes={TextAttributes.ITALIC} wrapMode="none" truncate selectable={false}>
          {`on “${truncate(props.comment.quote, 200)}”`}
        </text>
      </Show>
    </box>
  );
}

export default Plugin.define({
  id,
  setup: (ctx) => {
    const options = readOptions(ctx.options);
    const unclaimCommands = ctx.ui.slot({ append: "app", render: () => <Commands ctx={ctx} options={options} /> });
    const unclaimPanel = ctx.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === PANEL}>
          <ArtifactPanel ctx={ctx} input={input} />
        </Show>
      ),
    });
    return () => {
      unclaimCommands();
      unclaimPanel();
    };
  },
});
