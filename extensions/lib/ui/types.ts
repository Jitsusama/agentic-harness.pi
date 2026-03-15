/**
 * Component library types — the public API surface for the
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

// ---- Glyphs ----

/** Semantic glyphs — roguelike-inspired geometric set. */
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

// ---- Content ----

/** Content rendering function. Receives theme and width, returns lines. */
export type ContentFn = (theme: Theme, width: number) => string[];

// ---- Actions (Type A — key-hint bar) ----

/** A fixed action shown in the action bar. */
export interface Action {
	/** Single lowercase letter — the keyboard shortcut AND the return value. */
	key: string;
	/** Display label. The key letter is highlighted in accent color. */
	label: string;
}

// ---- Options (Type B — numbered list) ----

/** A dynamic option shown in a numbered list. */
export interface Option {
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

// ---- Results ----

/**
 * Result from a single prompt. Discriminated union:
 * - 'action': user picked a specific action/option
 * - 'steer': user wants to redirect (Shift+S)
 * null = cancelled (Escape)
 */
export type PromptResult =
	| {
			type: "action";
			/** The action key (for actions) or option value (for options). */
			value: string;
			/** Annotation from hold-to-reveal. Present when user added a note. */
			note?: string;
			/** Text from NoteEditor for opensEditor options. */
			editorText?: string;
	  }
	| {
			type: "steer";
			/** The steer note — always present. */
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

// ---- Tab Items ----

/** Status of a tab item. */
export type TabStatus = "pending" | "complete" | "rejected" | "active";

/** A single item in a tabbed prompt. */
export interface PromptItem {
	/** Tab label (e.g., "Q1", "R1", "C1"). */
	label: string;
	/** Renders the content for this item. */
	content: ContentFn;
	/** Fixed actions for this item (Type A key-hint bar). Overrides shared actions. */
	actions?: Action[];
	/** Dynamic options for this item (Type B numbered list). Overrides shared options. */
	options?: Option[];
	/** Enable horizontal scrolling for this item's content. Default: false. */
	allowHScroll?: boolean;
}

// ---- Prompt Config ----

/**
 * Config for a single prompt (no tabs).
 * Must provide at least one of: actions, options.
 */
export interface SinglePromptConfig {
	/** Renders the content area. */
	content: ContentFn;
	/** Fixed actions (Type A key-hint bar). */
	actions?: Action[];
	/** Dynamic options (Type B numbered list). */
	options?: Option[];
	/** Placeholder text shown in NoteEditor when steer is activated. */
	steerHint?: string;
	/** Enable horizontal scrolling (Shift+←→) for code content. Default: false. */
	allowHScroll?: boolean;
}

/**
 * Config for a tabbed prompt (multiple items).
 */
export interface TabbedPromptConfig {
	/** Items to review. Each becomes a tab. */
	items: PromptItem[];
	/**
	 * Default actions for all items. Individual items can override
	 * by providing their own actions or options.
	 */
	actions?: Action[];
	/** Default options for all items. Individual items can override. */
	options?: Option[];
	/** Allow user to add items via '+' hotkey. */
	canAddItems?: boolean;
	/** Auto-resolve when all items have been acted on. */
	autoResolve?: boolean;
	/** Placeholder text for steer NoteEditor. */
	steerHint?: string;
	/** Enable horizontal scrolling (Shift+←→) for code content. Default: false. */
	allowHScroll?: boolean;
}

// ---- View Config ----

export interface ViewConfig {
	/** Optional title shown at the top. */
	title?: string;
	/** Renders the content. */
	content: ContentFn;
	/** Enable horizontal scrolling (Shift+←→) for code content. Default: false. */
	allowHScroll?: boolean;
}

// ---- Layout Constants ----

/** Maximum panel height as a fraction of terminal rows. */
export const MAX_HEIGHT_FRACTION = 0.6;

/** Maximum content width in columns (readability cap). */
export const MAX_CONTENT_WIDTH = 100;

/** Content indent (spaces per side). */
export const CONTENT_INDENT = 2;

/** Lines reserved for pi chrome above the panel. */
export const PI_CHROME_LINES = 8;

/** Horizontal scroll step in visible characters. */
export const H_SCROLL_STEP = 20;

/** Lines of overlap kept when paging up/down for visual continuity. */
export const PAGE_SCROLL_OVERLAP = 3;

/** Width reserved for the vertical scrollbar gutter. */
export const SCROLLBAR_GUTTER = 2;
