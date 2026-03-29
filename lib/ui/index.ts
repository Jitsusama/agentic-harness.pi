/**
 * UI component library: panels, prompts, content rendering,
 * navigation and text layout.
 *
 * Public entry point for external consumers. Internal
 * implementation files (prompt-single, prompt-tabbed, etc.)
 * are not re-exported.
 */

// ── Panel interaction ───────────────────────────────────────
export {
	prompt,
	promptSingle,
	promptTabbed,
	view,
	workspace,
} from "./panel.js";

// ── Panel layout ────────────────────────────────────────────
export {
	computeChromeLines,
	type FooterOptions,
	renderFooter,
} from "./panel-layout.js";

// ── Content rendering ───────────────────────────────────────
export {
	type CodeRenderOptions,
	languageFromPath,
	preHighlightCode,
	renderCode,
	renderDiff,
	renderMarkdown,
} from "./content-renderer.js";

// ── Navigable lists ─────────────────────────────────────────
export {
	type DetailEntry,
	handleNavigableListInput,
	type NavigableItem,
	type NavigableListOptions,
	type NavigableListOutput,
	type NavigableSection,
	renderNavigableList,
	renderNavigableSections,
	sectionItemCount,
} from "./navigable-list.js";

// ── Text layout ─────────────────────────────────────────────
export {
	CONTENT_INDENT,
	contentWrapWidth,
	FALLBACK_CONTENT_WIDTH,
	wordWrap,
} from "./text-layout.js";

// ── Redirect formatting ─────────────────────────────────────
export {
	formatRedirectBlock,
	formatRedirectReason,
} from "./redirect.js";

// ── Panel height ────────────────────────────────────────────
export {
	getPanelHeightFraction,
	getPanelHeightGlyph,
	getPanelHeightMode,
	HEIGHT_FRACTION_FULLSCREEN,
	HEIGHT_FRACTION_MINIMIZED,
	HEIGHT_FRACTION_NORMAL,
	setPanelHeightMode,
} from "./panel-height.js";

// ── Tab completion ──────────────────────────────────────────
export {
	tabCompletion,
	type TabCompletionCallbacks,
} from "./tab-completion.js";

// ── Types ───────────────────────────────────────────────────
export {
	type AsyncContentRenderer,
	type ContentRenderer,
	GLYPH,
	type KeyAction,
	type ListChoice,
	type PanelHeightMode,
	type PromptItem,
	type PromptResult,
	type PromptView,
	type SinglePromptConfig,
	type TabbedPromptConfig,
	type TabbedResult,
	type TabStatus,
	type ViewConfig,
	type WorkspaceDoneInput,
	type WorkspaceInputContext,
	type WorkspaceInputHandler,
	type WorkspaceItem,
	type WorkspacePromptConfig,
	type WorkspaceResult,
	type WorkspaceView,
} from "./types.js";
