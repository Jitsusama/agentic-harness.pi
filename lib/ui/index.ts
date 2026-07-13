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

// ── Badges and bars ─────────────────────────────────────────
export {
	type BadgeKind,
	type BadgeOptions,
	type BarOptions,
	renderBadge,
	renderBar,
} from "./badge.js";
// ── Content rendering ───────────────────────────────────────
export {
	type CodeRenderOptions,
	languageFromPath,
	renderCode,
	renderDiff,
	renderMarkdown,
} from "./content-renderer.js";
// ── Narration ───────────────────────────────────────────────
export {
	NARRATION_GLYPH,
	type NarrationLevel,
	type NarrationOptions,
	renderNarrationLine,
} from "./narration.js";
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
// ── Pipeline progress ───────────────────────────────────────
export {
	type PipelineProgressOptions,
	type PipelineStage,
	renderPipelineProgress,
	renderPipelineProgressLines,
	type StageState,
} from "./pipeline-progress.js";
// ── Toggle list ─────────────────────────────────────────────
export {
	initToggleModel,
	promptToggleList,
	type ToggleListConfig,
	type ToggleListModel,
	type ToggleRow,
	type ToggleSection,
} from "./prompt-toggle-list.js";

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
