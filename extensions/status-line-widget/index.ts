/**
 * Status Line Widget Extension
 *
 * Single-line responsive footer showing directory, model, context
 * usage, thinking level, and extension statuses. Right-justified
 * status segments with left-side directory/model info that degrades
 * progressively as the terminal narrows.
 *
 * Context and money read as one segment, because they are one fact:
 * cost per turn is 97 percent explained by the context resident when
 * the turn runs. `cost-workflow` owns the figures and publishes them;
 * this line lays them out and decides what to drop. The brain does not
 * paint and the widget does not price.
 *
 * Degradation order:
 *   1. Shrink directory (full path → basename)
 *   2. Remove the session total (the one figure nothing can act on)
 *   3. Context tokens → percentage
 *   4. Shrink model name
 *   5. Remove thinking glyph
 *   6. Remove branch
 *   (the marginal rate is never removed: it is the only reading here
 *   that changes what you do next)
 */

import * as path from "node:path";
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ContextGauge,
	contextGauge,
	GAP,
	marginalText,
	sessionText,
} from "../../lib/internal/cost-meter/index.js";
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
	marginal: string | null;
	sessionTotal: string | null;
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
	theme: { fg: (color: ThemeColor, text: string) => string },
): { left: string[]; right: string[] } {
	// Degradation flags
	const useShortDir = level >= 1;
	const hideSessionTotal = level >= 2;
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

	// Context, rate and total read as one segment rather than three,
	// so the gauge emptying and the price falling are seen together.
	const meter = [usePctContext ? d.contextPct : d.contextTokens];
	if (d.marginal) meter.push(d.marginal);
	if (!hideSessionTotal && d.sessionTotal) meter.push(d.sessionTotal);
	right.push(meter.join(GAP));

	if (!hideThinking && d.thinkGlyph) right.push(d.thinkGlyph);

	return { left, right };
}

const MAX_LEVEL = 6;

/**
 * Paint a gauge: the glyph carries the band colour and the number stays
 * quiet, separated by the same gap every marker gets.
 */
function paintGauge(
	theme: { fg: (color: ThemeColor, text: string) => string },
	gauge: ContextGauge,
): string {
	return `${theme.fg(gauge.token, gauge.glyph)}${GAP}${theme.fg("dim", gauge.text)}`;
}

/** Dim a meter piece, or pass the absence through untouched. */
function withColour(
	theme: { fg: (color: ThemeColor, text: string) => string },
	text: string | null,
): string | null {
	return text === null ? null : theme.fg("dim", text);
}

/** The latest figures cost-workflow published. */
interface CostReading {
	session: number;
	marginal: number | null;
}

function toReading(data: unknown): CostReading | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	const session = record.session;
	const marginal = record.marginal;
	if (typeof session !== "number") return null;
	return {
		session,
		marginal: typeof marginal === "number" ? marginal : null,
	};
}

export default function statusLine(pi: ExtensionAPI) {
	// Held rather than computed: this widget must not learn to price.
	let reading: CostReading = { session: 0, marginal: null };
	// The live surface, so a new reading can ask for a repaint. Without
	// this the figures update and nothing shows them until some other
	// event happens to redraw the line.
	let surface: { requestRender: () => void } | null = null;

	pi.events.on("cost:reading", (data: unknown) => {
		const next = toReading(data);
		if (!next) return;
		reading = next;
		surface?.requestRender();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			surface = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const sep = theme.fg("dim", SEP);

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					const modelId = ctx.model?.id || "no-model";
					const usage = ctx.getContextUsage();
					const thinking = pi.getThinkingLevel();
					const extStatuses = footerData.getExtensionStatuses();

					const cwd = process.cwd();
					const tokens = usage?.tokens ?? 0;
					const window = usage?.contextWindow ?? 0;

					const gauge = contextGauge(tokens, window);
					const narrowGauge = contextGauge(tokens, window, true);

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
						contextTokens: paintGauge(theme, gauge),
						contextPct: paintGauge(theme, narrowGauge),
						marginal: withColour(theme, marginalText(reading.marginal)),
						sessionTotal: withColour(theme, sessionText(reading.session)),
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
