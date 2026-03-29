/**
 * Status Line Widget Extension
 *
 * Single-line responsive footer showing directory, model, context
 * usage, cost, thinking level, and extension statuses. Right-justified
 * status segments with left-side directory/model info that degrades
 * progressively as the terminal narrows.
 *
 * Degradation order:
 *   1. Shrink directory (full path → basename)
 *   2. Remove cost
 *   3. Context tokens → percentage
 *   4. Shrink model name
 *   5. Remove thinking glyph
 *   6. Remove branch
 *   (basename is never removed)
 */

import * as path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getPanelHeightGlyph } from "../../lib/ui/panel-height.js";

const THINKING_GLYPHS: Record<string, string> = {
	off: "",
	minimal: "🧠¹",
	low: "🧠²",
	medium: "🧠³",
	high: "🧠⁴",
	xhigh: "🧠⁵",
};

/** ANSI 256-color: muted blue-gray for the model name. */
const MODEL_COLOR = "\x1b[38;5;103m";
const ANSI_RESET = "\x1b[0m";

/** Shorten a model ID: claude-sonnet-4-20250514 → sonnet-4 */
function shortenModel(id: string): string {
	return id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Format a token count: 45200 → "45.2k", 800 → "800" */
function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/** Home-relative path: /Users/joel/src/foo → ~/src/foo */
function homePath(dir: string): string {
	const home = process.env.HOME || "";
	return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

const SEP = " │ ";
const SEP_W = 3;

/** Measure the visible width of segments joined by separators. */
function totalWidth(parts: string[]): number {
	if (parts.length === 0) return 0;
	let w = SEP_W * (parts.length - 1);
	for (const p of parts) w += visibleWidth(p);
	return w;
}

interface FooterData {
	/** Full path with last component highlighted. */
	fullDir: string;
	/** Basename only, highlighted. */
	shortDir: string;
	branch: string | null;
	fullModel: string;
	shortModel: string;
	contextTokens: string;
	contextPct: string;
	cost: string | null;
	thinkGlyph: string;
	panelGlyph: string;
	statuses: string[];
}

/**
 * Build a candidate line at a given degradation level.
 * Returns the joined segments for left and right, or null
 * if there are no segments on that side.
 */
function buildCandidate(
	d: FooterData,
	level: number,
	theme: { fg: (color: string, text: string) => string },
): { left: string[]; right: string[] } {
	// Degradation flags
	const useShortDir = level >= 1;
	const hideCost = level >= 2;
	const usePctContext = level >= 3;
	const useShortModel = level >= 4;
	const hideThinking = level >= 5;
	const hideBranch = level >= 6;

	const left: string[] = [];

	const dir = useShortDir ? d.shortDir : d.fullDir;
	if (!hideBranch && d.branch) {
		left.push(`${dir} ${theme.fg("dim", "·")} ${theme.fg("dim", d.branch)}`);
	} else {
		left.push(dir);
	}

	left.push(useShortModel ? d.shortModel : d.fullModel);

	const right: string[] = [];

	for (const s of d.statuses) right.push(s);

	if (d.panelGlyph) right.push(d.panelGlyph);

	right.push(usePctContext ? d.contextPct : d.contextTokens);

	if (!hideCost && d.cost) right.push(d.cost);

	if (!hideThinking && d.thinkGlyph) right.push(d.thinkGlyph);

	return { left, right };
}

const MAX_LEVEL = 6;

/** Extract the cost from an assistant message, or 0 if not applicable. */
function assistantCost(message: { role: string }): number {
	if (message.role === "assistant" && "usage" in message) {
		return (message as AssistantMessage).usage.cost.total;
	}
	return 0;
}

export default function statusLine(pi: ExtensionAPI) {
	/** Running cost total, accumulated from session start and message_end events. */
	let totalCost = 0;

	pi.on("message_end", async (event) => {
		totalCost += assistantCost(event.message);
	});

	pi.on("session_start", async (_event, ctx) => {
		// Compute the initial cost from the existing branch (handles restored sessions).
		totalCost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message") {
				totalCost += assistantCost(e.message);
			}
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const sep = theme.fg("dim", SEP);

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const cost = totalCost;

					const branch = footerData.getGitBranch();
					const modelId = ctx.model?.id || "no-model";
					const usage = ctx.getContextUsage();
					const thinking = pi.getThinkingLevel();
					const extStatuses = footerData.getExtensionStatuses();

					const cwd = process.cwd();
					const tokens = usage?.tokens ?? 0;
					const window = usage?.contextWindow ?? 0;
					const pct = window > 0 ? Math.round((tokens / window) * 100) : 0;

					// The context colour is dim normally but turns to warning when > 80%.
					const ctxColor = pct > 80 ? "warning" : "dim";

					// We highlight the last path component and dim the rest.
					const homeCwd = homePath(cwd);
					const base = path.basename(cwd);
					const parent = homeCwd.slice(0, homeCwd.length - base.length);
					const fullDir = `${theme.fg("dim", parent)}${MODEL_COLOR}${base}${ANSI_RESET}`;

					const thinkGlyph = THINKING_GLYPHS[thinking] ?? "";

					const d: FooterData = {
						fullDir,
						shortDir: `${MODEL_COLOR}${base}${ANSI_RESET}`,
						branch,
						fullModel: theme.fg("dim", modelId),
						shortModel: theme.fg("dim", shortenModel(modelId)),
						contextTokens: theme.fg(
							ctxColor,
							`${fmtTokens(tokens)}/${fmtTokens(window)}`,
						),
						contextPct: theme.fg(ctxColor, `${pct}%`),
						cost: cost > 0 ? theme.fg("dim", `$${cost.toFixed(3)}`) : null,
						thinkGlyph,
						panelGlyph: theme.fg("dim", getPanelHeightGlyph()),
						statuses: [],
					};

					for (const [, text] of extStatuses) {
						if (text) d.statuses.push(text);
					}

					for (let level = 0; level <= MAX_LEVEL; level++) {
						const { left, right } = buildCandidate(d, level, theme);
						const leftW = totalWidth(left);
						const rightW = totalWidth(right);
						const needed =
							leftW + rightW + (leftW > 0 && rightW > 0 ? SEP_W : 0);

						if (needed <= width) {
							const leftText = left.join(sep);
							const rightText = right.join(sep);

							let line: string;
							if (leftText && rightText) {
								const gap = " ".repeat(Math.max(1, width - leftW - rightW));
								line = leftText + gap + rightText;
							} else if (rightText) {
								const pad = " ".repeat(Math.max(0, width - rightW));
								line = pad + rightText;
							} else {
								line = leftText;
							}

							return [truncateToWidth(line, width)];
						}
					}

					// If everything else is stripped, we just show the basename.
					return [truncateToWidth(d.shortDir, width)];
				},
			};
		});
	});
}
