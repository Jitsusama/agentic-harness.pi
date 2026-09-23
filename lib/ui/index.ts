/**
 * UI component library: panels, prompts, content rendering,
 * navigation and text layout.
 *
 * Public entry point for external consumers. Internal
 * implementation files (prompt-single, prompt-tabbed,
 * panel-layout, scroll-region, action-bar, tab-strip,
 * note-editor, option-list, panel-height, redirect) are not
 * re-exported.
 */

// ── Spawned work ────────────────────────────────────────────
export { AGENT_GLYPH, type AgentState } from "./agent-glyphs.ts";
// ── Badges and bars ─────────────────────────────────────────
export {
	type BadgeKind,
	type BadgeOptions,
	type BarOptions,
	renderBadge,
	renderBar,
} from "./badge.ts";
// ── Content rendering ───────────────────────────────────────
export {
	type CodeRenderOptions,
	languageFromPath,
	// The companion to `CodeRenderOptions.preHighlighted`: a caller
	// that highlights once and renders repeatedly needs this to
	// produce the lines the option takes, so leaving it out of the
	// barrel made that option unusable from outside.
	preHighlightCode,
	renderCode,
	renderDiff,
	renderMarkdown,
} from "./content-renderer.ts";
// ── Counts ─────────────────────────────────────────
export { count, noun, verb } from "./count.ts";
// ── Gate serialization ──────────────────────────────────────
export { runGate } from "./gate-queue.ts";
// ── Narration ───────────────────────────────────────────────
export {
	NARRATION_GLYPH,
	type NarrationLevel,
	type NarrationOptions,
	renderNarrationLine,
} from "./narration.ts";
// ── Navigable lists ─────────────────────────────────────────
export {
	type DetailEntry,
	type NavigableItem,
	// The options and the output belong here because they are the
	// parameter and return types of the two functions below. Exported from
	// the file but missing from the barrel, they left a consumer able to
	// call these and unable to name what they take or hand back.
	type NavigableListOptions,
	type NavigableListOutput,
	type NavigableSection,
	renderNavigableList,
	renderNavigableSections,
} from "./navigable-list.ts";
// ── Panel interaction ───────────────────────────────────────
export {
	promptSingle,
	promptTabbed,
	view,
	workspace,
} from "./panel.ts";
// ── Paths ──────────────────────────────────────────
export { displayPath } from "./path.ts";
// ── Pipeline progress ───────────────────────────────────────
export {
	type PipelineProgressOptions,
	type PipelineStage,
	renderPipelineProgress,
	renderPipelineProgressLines,
	type StageState,
} from "./pipeline-progress.ts";
// ── Toggle list ─────────────────────────────────────────────
export {
	initToggleModel,
	promptToggleList,
	type ToggleListConfig,
	type ToggleListModel,
	type ToggleRow,
	type ToggleSection,
} from "./prompt-toggle-list.ts";
// ── Text layout ─────────────────────────────────────────────
export { contentWrapWidth, wordWrap } from "./text-layout.ts";
// ── Tool call lines ───────────────────────────────────
export {
	asText,
	drawInto,
	type RenderTheme,
	renderToolCall,
	type ToolCallLine,
} from "./tool-call.ts";
// ── Tool results ───────────────────────
export { firstText, type MaybeTextBlock } from "./tool-result.ts";

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
	// A property of WorkspacePromptConfig's views, so a consumer writing
	// one needs to be able to name it.
	WorkspaceInputHandler,
	WorkspaceItem,
	WorkspacePromptConfig,
	WorkspaceResult,
	WorkspaceView,
} from "./types.ts";
