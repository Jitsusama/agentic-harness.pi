import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";
import { RESULT_VIEW_KEY, type ResultView } from "../json-summary.js";

/** The slice of pi's ToolRenderContext the default result renderer reads. */
interface ResultRenderContext {
	isError: boolean;
}

/** The content a cancelled call carries, owned here so the renderer can recognise it. */
export const CANCELLED_TEXT = "Tool call cancelled by user.";

/** Lines shown in a collapsed result before the rest are folded away. */
export const PREVIEW_LINES = 6;

/** The three states the default result renderer distinguishes. */
export type ResultKind = "error" | "cancel" | "preview";

/** Join the text blocks of a result, ignoring images and other content. */
export function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * Classify a result for display. An errored call is an error; the owned cancel
 * sentinel is a cancel; everything else is ordinary preview output. Write
 * success is not a distinct state: a completed write renders as preview,
 * because the write was already surfaced at the approval gate and the result
 * carries no field the renderer could key on.
 */
export function classifyResult(text: string, isError: boolean): ResultKind {
	if (isError) return "error";
	if (text.trim() === CANCELLED_TEXT) return "cancel";
	return "preview";
}

/** The terminal-only view a summarized result carries on its details, if any. */
export function resultViewOf(
	result: AgentToolResult<unknown>,
): ResultView | undefined {
	const details = result.details as Record<string, unknown> | undefined;
	const view = details?.[RESULT_VIEW_KEY];
	if (!view || typeof view !== "object") return undefined;
	const candidate = view as Partial<ResultView>;
	if (typeof candidate.pretty !== "string") return undefined;
	return candidate as ResultView;
}

/** A human-readable byte size: bytes, KB or MB, whichever reads cleanly. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Split text into the first `previewLines` lines and a count of those hidden. */
export function collapsePreview(
	text: string,
	previewLines: number,
): { lines: string[]; hiddenCount: number } {
	const lines = text.split("\n");
	if (lines.length <= previewLines) return { lines, hiddenCount: 0 };
	return {
		lines: lines.slice(0, previewLines),
		hiddenCount: lines.length - previewLines,
	};
}

/** Render a tool result: an error or cancel note, a full expanded body, or a collapsed preview with an expand hint. */
export function renderDefaultResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultRenderContext,
): Component {
	if (options.isPartial) return new Text(theme.fg("warning", "Running…"), 0, 0);

	const text = resultText(result);
	const kind = classifyResult(text, context.isError);

	if (kind === "error")
		return new Text(theme.fg("error", text || "Error"), 0, 0);
	if (kind === "cancel") return new Text(theme.fg("muted", text), 0, 0);

	// A summarized result renders from its view: one line collapsed, the friendly
	// indented shape expanded. The model still receives the full digest in `text`.
	const view = resultViewOf(result);
	if (view) {
		if (options.expanded) {
			const footer = view.handle
				? `\n\n${theme.fg("muted", `Full JSON under ${view.handle} · query to pull records`)}`
				: "";
			return new Text(theme.fg("toolOutput", view.pretty) + footer, 0, 0);
		}
		const where = view.handle ?? view.path;
		const line = `JSON result · ${formatBytes(view.bytes)} · ${where} · ⏎ to expand`;
		return new Text(theme.fg("muted", line), 0, 0);
	}

	if (!text) return new Text(theme.fg("muted", "No output"), 0, 0);

	if (options.expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

	const { lines, hiddenCount } = collapsePreview(text.trim(), PREVIEW_LINES);
	const body = lines.map((line) => theme.fg("dim", line));
	if (hiddenCount > 0) {
		body.push(theme.fg("muted", `… ${hiddenCount} more lines · ⏎ to expand`));
	}
	return new Text(body.join("\n"), 0, 0);
}
