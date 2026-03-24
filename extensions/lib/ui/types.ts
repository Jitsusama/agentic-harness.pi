/**
 * Component library types: the public API surface for the
 * prompt/view system.
 *
 * Two interaction patterns:
 *   - prompt: interactive decisions (single or tabbed)
 *   - view: read-only display
 *
 * Two action styles:
 *   - Actions (Type A): fixed key-hint bar for gates/reviews
 *   - Options (Type B): numbered list for dynamic choices
 */

import type { Theme } from "@mariozechner/pi-coding-agent";

/** Semantic glyphs: roguelike-inspired geometric set. */
export const GLYPH = {
	/** Active cursor / current selection. */
	cursor: "▸",
	/** Inactive item / spacer dot. */
	dot: "·",
	/** Complete / approved / success. */
	complete: "◆",
	/** Pending / unanswered / default. */
	pending: "◇",
	/** Rejected / failed / error. */
	rejected: "✕",
	/** In-progress / active mode. */
	active: "◈",
	/** Horizontal rule separator. */
	hrule: "─",
	/** Light separator (section divider within content). */
	separator: "┄",
	/** Ellipsis (hidden tabs). */
	ellipsis: "…",
	/** Scrollbar filled portion. */
	scrollFilled: "▓",
	/** Scrollbar empty portion. */
	scrollEmpty: "░",
	/** Scrollbar thumb. */
	scrollThumb: "█",
	/** Active mode indicator. */
	modeActive: "●",
	/** Stopped mode indicator. */
	modeStopped: "■",
} as const;

/** Synchronous content rendering function. */
export type ContentRenderer = (theme: Theme, width: number) => string[];

/** Async content rendering function (for lazy loading). */
export type AsyncContentRenderer = (
	theme: Theme,
	width: number,
) => Promise<string[]>;

/** A fixed action shown in the action bar. */
export interface KeyAction {
	/** Single lowercase letter: the keyboard shortcut AND the return value. */
	key: string;
	/** Display label. The key letter is highlighted in accent colour. */
	label: string;
}

/** A dynamic option shown in a numbered list. */
export interface ListChoice {
	/** Display label (can be a sentence). */
	label: string;
	/** Return value. Defaults to lowercase of label if omitted. */
	value?: string;
	/** Description shown only when this option is selected. */
	description?: string;
	/** When true, selecting this option opens NoteEditor for text input. */
	opensEditor?: boolean;
	/** Pre-fill text for NoteEditor. */
	editorPreFill?: string;
}

/**
 * Result from a single prompt. Discriminated union:
 * - 'action': user pressed a key action from the action bar
 * - 'option': user selected an item from the option list
 * - 'redirect': user wants a different approach (Shift+Escape)
 * null = cancelled (Escape)
 */
export type PromptResult =
	| {
			type: "action";
			/** The action key (single letter). */
			key: string;
			/** Annotation from hold-to-reveal. Present when user added a note. */
			note?: string;
	  }
	| {
			type: "option";
			/** The selected option's value. */
			value: string;
			/** Annotation from hold-to-reveal. Present when user added a note. */
			note?: string;
			/** Text from NoteEditor for opensEditor options. */
			editorText?: string;
	  }
	| {
			type: "redirect";
			/** The redirect note: always present. */
			note: string;
	  };

/**
 * Result from a tabbed prompt.
 * null = cancelled (Escape)
 */
export interface TabbedResult {
	/** Per-item results. Key = item index. Only includes items acted on. */
	items: Map<number, PromptResult>;
	/** Strings from user-added items ('+' hotkey). */
	userItems: string[];
}

/** Status of a tab item. */
export type TabStatus = "pending" | "complete" | "rejected" | "active";

/** A named content view within a tab. */
export interface PromptView {
	/** Single lowercase letter: the keyboard shortcut to activate this view. */
	key: string;
	/** Display label shown in the hint bar (e.g., "Diff", "File"). */
	label: string;
	/** Renders the content for this view. May be async for lazy loading. */
	content: ContentRenderer | AsyncContentRenderer;
}

/** A single item in a tabbed prompt. */
export interface PromptItem {
	/** Tab label (e.g., "Q1", "R1", "C1"). */
	label: string;
	/** Content views. First is active by default. Items with one view show no view hints. */
	views: PromptView[];
	/** Fixed actions for this item (Type A key-hint bar). Overrides shared actions. */
	actions?: KeyAction[];
	/** Dynamic options for this item (Type B numbered list). Overrides shared options. */
	options?: ListChoice[];
	/** Enable horizontal scrolling for this item's content. Default: false. */
	allowHScroll?: boolean;
}

/**
 * Config for a single prompt (no tabs).
 * Must provide at least one of: actions, options.
 */
export interface SinglePromptConfig {
	/** Optional title shown at the top, below the border. */
	title?: string;
	/** Renders the content area. */
	content: ContentRenderer;
	/** Fixed actions (Type A key-hint bar). */
	actions?: KeyAction[];
	/** Dynamic options (Type B numbered list). */
	options?: ListChoice[];
	/** Placeholder text shown in NoteEditor when redirect is activated. */
	redirectHint?: string;
	/** Enable horizontal scrolling (Shift+←→) for code content. Default: false. */
	allowHScroll?: boolean;
}

/**
 * Config for a tabbed prompt (multiple items).
 */
export interface TabbedPromptConfig {
	/** Optional title shown at the top, below the border. */
	title?: string;
	/** Items to review. Each becomes a tab. */
	items: PromptItem[];
	/**
	 * Default actions for all items. Individual items can override
	 * by providing their own actions or options.
	 */
	actions?: KeyAction[];
	/** Default options for all items. Individual items can override. */
	options?: ListChoice[];
	/** Allow user to add items via '+' hotkey. */
	canAddItems?: boolean;
	/** Auto-resolve when all items have been acted on. */
	autoResolve?: boolean;
	/** Placeholder text for redirect NoteEditor. */
	redirectHint?: string;
	/** Enable horizontal scrolling (Shift+←→) for code content. Default: false. */
	allowHScroll?: boolean;
}

/** Configuration for a read-only content view (no actions or options). */
export interface ViewConfig {
	/** Optional title shown at the top. */
	title?: string;
	/** Renders the content. */
	content: ContentRenderer;
	/** Enable horizontal scrolling (Shift+←→) for code content. Default: false. */
	allowHScroll?: boolean;
	/** Signal to programmatically dismiss the view. */
	signal?: AbortSignal;
}

/** Panel height mode: controls what fraction of the terminal panels can occupy. */
export type PanelHeightMode = "minimized" | "normal" | "fullscreen";

/** Content indent (spaces per side). */
export const CONTENT_INDENT = 2;

/** Config for a workspace prompt (stateful tabs). */
export interface WorkspacePromptConfig {
	/** Tab definitions: each is a stateful workspace. */
	items: WorkspaceItem[];
	/** Global actions available on all tabs/views. */
	globalActions?: KeyAction[];
	/** Compute tab status externally (called on render). */
	tabStatus: (index: number) => TabStatus;
	/** Whether all tabs are complete (highlights Ctrl+Enter). */
	allComplete: () => boolean;
	/** Enable horizontal scrolling globally. */
	allowHScroll?: boolean;
}

/** A single workspace tab. */
export interface WorkspaceItem {
	/** Tab label. */
	label: string;
	/** Content views. */
	views: WorkspaceView[];
	/** Enable hScroll for this item. */
	allowHScroll?: boolean;
}

/** A view within a workspace tab. */
export interface WorkspaceView {
	/** View switch key. */
	key: string;
	/** View label for hint bar. */
	label: string;
	/** Render content. May be async. */
	content: ContentRenderer | AsyncContentRenderer;
	/** Actions specific to this view. */
	actions?: KeyAction[];
	/**
	 * Short verb shown as "Enter {hint}" in the footer when this
	 * view handles Enter (e.g., "approve", "open", "select").
	 * Omit when the view doesn't handle Enter.
	 */
	enterHint?: string;
	/**
	 * Handle input for this view. Called BEFORE default
	 * handling (scroll, tabs). Return true if handled.
	 * Use for selectable lists, per-view actions, etc.
	 */
	handleInput?: WorkspaceInputHandler;
}

/** Input handler for a workspace view. */
export type WorkspaceInputHandler = (
	data: string,
	ctx: WorkspaceInputContext,
) => boolean;

/** Context passed to view input handlers. */
export interface WorkspaceInputContext {
	/** Clear content cache and re-render. Use after state mutation. */
	invalidate: () => void;
	/** Trigger a repaint without clearing cache (e.g., cursor moved). */
	requestRender: () => void;
	/** Adjust scroll so the given content line is visible. */
	scrollToContentLine: (line: number) => void;
	/** Open the note editor with a label. */
	openEditor: (label: string, preFill?: string) => void;
	/** Close the panel with a result. */
	done: (result: WorkspaceResult) => void;
}

/**
 * Result from a workspace prompt. Discriminated by type.
 * null = cancelled (Escape).
 */
export type WorkspaceResult =
	| { type: "submit" }
	| { type: "redirect"; note: string }
	| { type: "action"; key: string; note?: string }
	| null;
