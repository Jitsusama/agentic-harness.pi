/**
 * UI component library: panels, prompts, content rendering,
 * navigation and text layout.
 *
 * Public entry point for external consumers. Internal
 * implementation files (prompt-single, prompt-tabbed,
 * panel-layout, scroll-region, action-bar, tab-strip,
 * note-editor, option-list, panel-height, redirect,
 * tab-completion) are not re-exported.
 */

// ── Content rendering ───────────────────────────────────────
export {
	type CodeRenderOptions,
	languageFromPath,
	renderCode,
	renderDiff,
	renderMarkdown,
} from "./content-renderer.js";
// ── Navigable lists ─────────────────────────────────────────
export {
	type DetailEntry,
	type NavigableItem,
	type NavigableSection,
	renderNavigableList,
	renderNavigableSections,
} from "./navigable-list.js";
// ── Panel interaction ───────────────────────────────────────
export {
	promptSingle,
	promptTabbed,
	view,
	workspace,
} from "./panel.js";

// ── Text layout ─────────────────────────────────────────────
export { contentWrapWidth, wordWrap } from "./text-layout.js";

// ── Types ───────────────────────────────────────────────────
export type {
	AsyncContentRenderer,
	ContentRenderer,
	KeyAction,
	ListChoice,
	PanelHeightMode,
	PromptItem,
	PromptResult,
	PromptView,
	SinglePromptConfig,
	TabbedPromptConfig,
	TabbedResult,
	TabStatus,
	ViewConfig,
	WorkspaceItem,
	WorkspacePromptConfig,
	WorkspaceResult,
	WorkspaceView,
} from "./types.js";
