/**
 * Status Line Widget Extension
 *
 * pi's one line along the bottom, in the language of the machine's prompt
 * (`layout.ts` says what it holds and how it gives way). This file gathers
 * the facts and paints the pieces.
 *
 * Context and money read as one field, because they are one fact: cost
 * per turn is 97 percent explained by the context resident when the turn
 * runs. `spend-workflow` owns the figures and publishes them; this line
 * lays them out and decides what to drop. The brain does not paint and
 * the widget does not price.
 *
 * Git's state comes from the machine's engine when `where.json` names one,
 * asked when something may have changed it: the session starting, a tool
 * finishing, a shell command, the agent settling, pi seeing the branch
 * move. Otherwise the branch is pi's own, with no marks.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ContextGauge,
	contextGauge,
	marginalText,
	sessionText,
} from "../../lib/internal/cost-meter/index.ts";
import {
	getPanelHeightGlyph,
	getPanelHeightMode,
} from "../../lib/ui/panel-height.ts";
import { Engine, type GitState } from "./git.ts";
import { type Facts, layout, type Piece, type Role, width } from "./layout.ts";
import { told } from "./place.ts";
import { type UsageReader, usageReader } from "./usage.ts";
import { readWhere } from "./where.ts";

/**
 * The theme's colour for each role. pi names no strong colour of its own,
 * so the strong word takes a tool's title, which a theme draws as the
 * brightest text.
 */
const COLOUR: Record<Exclude<Role, "thinking" | "painted">, ThemeColor> = {
	text: "text",
	muted: "dim",
	strong: "toolTitle",
	alert: "error",
	warning: "warning",
};

/** Each thinking level's colour, which only its mark wears. */
const THINKING: Record<string, ThemeColor> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** The meter's band names, as the theme's colours. */
const BAND: Record<ContextGauge["token"], Role> = {
	dim: "muted",
	warning: "warning",
	error: "alert",
};

function gaugePieces(gauge: ContextGauge): Piece[] {
	return [
		{ role: BAND[gauge.token], text: gauge.glyph },
		{ role: "muted", text: ` ${gauge.text}` },
	];
}

/** The latest figures spend-workflow published. */
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

	const where = readWhere();
	const answers = new Map<string, GitState | false>();
	const engine = where.engine
		? new Engine(where.engine, (dir, state) => {
				answers.set(dir, state);
				surface?.requestRender();
			})
		: null;
	const ask = () => engine?.ask(process.cwd());

	// Telling a folder looks at the disk, so it's kept until pi moves.
	let toldFor: string | null = null;
	let place = told("/", [], "");

	pi.events.on("cost:reading", (data: unknown) => {
		const next = toReading(data);
		if (!next) return;
		reading = next;
		surface?.requestRender();
	});

	// The context's usage, held between the events that change it, since
	// reading it in every frame cost a long session half a core.
	let usage: UsageReader<
		ReturnType<ExtensionContext["getContextUsage"]>
	> | null = null;
	const changed = async () => usage?.stale();
	pi.on("message_end", changed);
	pi.on("turn_end", changed);
	pi.on("agent_end", changed);
	pi.on("tool_result", changed);
	pi.on("session_compact", changed);
	pi.on("session_tree", changed);
	pi.on("model_select", changed);

	pi.on("tool_result", async () => ask());
	pi.on("user_bash", async () => ask());
	pi.on("agent_end", async () => ask());
	pi.on("session_shutdown", async () => engine?.stop());

	pi.on("session_start", async (_event, ctx) => {
		ask();
		usage = usageReader(() => ctx.getContextUsage());
		const reader = usage;
		ctx.ui.setFooter((tui, theme, footerData) => {
			surface = tui;
			const unsub = footerData.onBranchChange(() => {
				ask();
				tui.requestRender();
			});

			const paint = (pieces: readonly Piece[], level: string) =>
				pieces
					.map((piece) => {
						if (piece.role === "painted") return piece.text;
						if (piece.role === "thinking") {
							return theme.fg(THINKING[level] ?? "dim", piece.text);
						}
						return theme.fg(COLOUR[piece.role], piece.text);
					})
					.join("");

			return {
				dispose: unsub,
				invalidate() {},
				render(columns: number): string[] {
					const cwd = process.cwd();
					if (toldFor !== cwd) {
						toldFor = cwd;
						place = told(cwd, where.roots, process.env.HOME ?? "");
					}
					const now = reader.get();
					const tokens = now?.tokens ?? 0;
					const window = now?.contextWindow ?? 0;
					const thinking = pi.getThinkingLevel();
					const answer = answers.get(cwd);
					const mode = getPanelHeightMode();

					const facts: Facts = {
						place,
						git: answer || null,
						branch: answer === false ? null : footerData.getGitBranch(),
						model: ctx.model?.id || "no-model",
						thinking,
						statuses: [...footerData.getExtensionStatuses().values()].filter(
							(text) => text.length > 0,
						),
						panel:
							mode === "normal" ? null : theme.fg("dim", getPanelHeightGlyph()),
						context: gaugePieces(contextGauge(tokens, window)),
						contextShare: gaugePieces(contextGauge(tokens, window, true)),
						rate: marginalText(reading.marginal),
						total: sessionText(reading.session),
						marks: where.marks,
					};

					const { left, right } = layout(facts, columns);
					const leftText = paint(left, thinking);
					if (right.length === 0) {
						return [truncateToWidth(leftText, columns)];
					}
					const room = columns - width(left) - width(right);
					const line =
						leftText + " ".repeat(Math.max(2, room)) + paint(right, thinking);
					return [truncateToWidth(line, columns)];
				},
			};
		});
	});
}
