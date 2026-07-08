/**
 * Advisor Extension
 *
 * A second model that watches the main agent at work. After each
 * substantive turn it reviews the new transcript delta against
 * the captured governance rules, investigates suspicions with a
 * read-only tool palette, and raises evidence-backed findings.
 * Asides arrive as quiet tail notes; concerns and blockers
 * interrupt through the steer channel, framed as advice to weigh.
 *
 * It runs on a cheap side model (GLM via the proxy) and keeps one
 * long-lived context per session, so its prefix caches turn to
 * turn. It is off by default and turned on by asking for it in
 * conversation, which calls the `advisor` tool; the choice
 * persists across sessions. It watches the main agent only
 * (subagents load an isolated config without it), and self-heals
 * its review cursor when the transcript is compacted or rewritten.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { runInvestigation } from "../../lib/completion/index.js";
import {
	condenseTranscript,
	openRuleStore,
	type RuleStore,
} from "../../lib/governance/index.js";
import { dataDir } from "../../lib/internal/paths.js";
import {
	recordRunEverywhere,
	runRecordFrom,
} from "../../lib/observability/index.js";
import { entriesToTurns } from "../correction-capture/transcript.js";
import { advisorCharter, reviewPrompt } from "./charter.js";
import {
	channelFor,
	type Finding,
	nextImmuneTurns,
	parseFindings,
} from "./findings.js";
import { loadAdvisorEnabled, saveAdvisorEnabled } from "./settings.js";
import { isSubstantiveTurn } from "./substantive.js";
import { investigationTools } from "./tools.js";

/**
 * The runtime context fields the advisor uses that the older
 * typecheck dependency does not yet declare. They are present at
 * runtime (pi 0.80.x), so the context is read through this view.
 */
interface RuntimeContext {
	readonly sessionId?: string;
	sendUserMessage(
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
	sendMessage(message: {
		customType: string;
		content: string;
		display?: boolean;
	}): void;
}

/** View a context through its runtime-only fields. */
function runtime(ctx: ExtensionContext): RuntimeContext {
	return ctx as unknown as RuntimeContext;
}

/** Marker prefixing the advisor's own steered notes. */
const NOTE_MARKER = "[advisor]";
/** Maximum model round-trips per review. */
const MAX_STEPS = 6;
/** Reset the caching context once it grows past this many chars. */
const MAX_CONTEXT_CHARS = 60_000;

/** A finding the advisor injected, to skip on later reviews. */
function isAdvisorNote(text: string): boolean {
	return text.trimStart().startsWith(NOTE_MARKER);
}

/** Tool names used across a slice of session entries. */
function toolNamesOf(entries: unknown[]): string[] {
	const names: string[] = [];
	for (const entry of entries as Array<{
		type: string;
		toolName?: string;
		message?: { content?: unknown };
	}>) {
		if (entry.type === "toolResult" && entry.toolName) {
			names.push(entry.toolName);
			continue;
		}
		const content = entry.message?.content;
		if (Array.isArray(content)) {
			for (const block of content as Array<{ type: string; name?: string }>) {
				if (block.type === "toolCall" && block.name) names.push(block.name);
			}
		}
	}
	return names;
}

/** Total characters held in the persistent context. */
function contextChars(messages: unknown[]): number {
	return JSON.stringify(messages).length;
}

/** Render a finding as an advisory note the doer can weigh. */
function formatFinding(finding: Finding): string {
	const evidence = finding.evidence ? `\n  evidence: ${finding.evidence}` : "";
	return `${NOTE_MARKER} ${finding.severity}: ${finding.claim}${evidence}`;
}

export default function advisor(pi: ExtensionAPI) {
	// Off until turned on in conversation. The flag is loaded at
	// session start and flipped by the advisor tool; while off, the
	// turn_end handler returns at once, so a session that did not
	// ask for the advisor pays nothing.
	let enabled = false;
	const settingsPath = () => join(dataDir("advisor"), "settings.json");

	let store: RuleStore | null = null;
	function ruleStore(): RuleStore {
		if (!store) {
			const dir = dataDir("governance");
			mkdirSync(dir, { recursive: true });
			store = openRuleStore(join(dir, "rules.json"));
		}
		return store;
	}

	let messages: unknown[] = [];
	let cursor = 0;
	let immuneTurns = 0;
	let runSeq = 0;

	function resetContext(): void {
		messages = [];
		cursor = 0;
	}

	pi.on("session_start", async () => {
		enabled = loadAdvisorEnabled(settingsPath());
		resetContext();
	});
	// A compaction rewrites the transcript, so any index into it is
	// stale; drop the cursor and the cached context and start fresh.
	pi.on("session_compact", async () => resetContext());

	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		description:
			"Turn the background advisor on or off, or check its status. " +
			"The advisor is a second cheap model that reviews your " +
			"substantive turns against the captured rules and raises " +
			"evidence-backed notes. It is off by default; enable it when you " +
			"want a second set of eyes, and the choice persists across " +
			"sessions until disabled.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("enable"),
					Type.Literal("disable"),
					Type.Literal("status"),
				],
				{ description: "Turn the advisor on, off, or report its state." },
			),
		}),
		renderCall(args, theme) {
			const label = theme.fg("toolTitle", theme.bold("advisor "));
			const action = typeof args.action === "string" ? args.action : "status";
			return new Text(label + theme.fg("dim", action), 0, 0);
		},
		async execute(_toolCallId, params) {
			if (params.action === "status") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Advisor is ${enabled ? "enabled" : "disabled"}.`,
						},
					],
					details: { enabled },
				};
			}
			enabled = params.action === "enable";
			saveAdvisorEnabled(settingsPath(), enabled);
			return {
				content: [
					{
						type: "text" as const,
						text: enabled
							? "Advisor enabled. It will review substantive turns this " +
								"session and future ones until you disable it."
							: "Advisor disabled. It will not run until you enable it again.",
					},
				],
				details: { enabled },
			};
		},
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (!enabled) return;
		try {
			await review(ctx);
		} catch {
			// The advisor is advisory: a failure in it must never
			// disturb the turn it was watching.
		}
	});

	async function review(ctx: ExtensionContext): Promise<void> {
		const entries = ctx.sessionManager.getEntries();
		// Self-heal: a shorter transcript than last seen means it was
		// rewritten, so the old cursor and context no longer apply.
		if (entries.length < cursor) resetContext();

		const deltaEntries = entries.slice(cursor);
		cursor = entries.length;

		const turns = entriesToTurns(deltaEntries).filter(
			(t) => !isAdvisorNote(t.text),
		);
		if (turns.length === 0) {
			immuneTurns = nextImmuneTurns(immuneTurns, false);
			return;
		}
		if (!isSubstantiveTurn(toolNamesOf(deltaEntries))) {
			immuneTurns = nextImmuneTurns(immuneTurns, false);
			return;
		}

		if (contextChars(messages) > MAX_CONTEXT_CHARS) messages = [];
		messages.push({
			role: "user",
			content: reviewPrompt(ruleStore().list(), condenseTranscript(turns)),
			timestamp: Date.now(),
		});

		const startedAt = Date.now();
		const result = await runInvestigation(ctx.modelRegistry, {
			systemPrompt: advisorCharter(),
			messages,
			tools: investigationTools(ctx.cwd),
			maxSteps: MAX_STEPS,
			current: ctx.model,
		});
		messages = result.messages;
		recordCost(ctx, result, startedAt);

		if (!result.ok) return;

		const rt = runtime(ctx);
		let firedInterrupt = false;
		for (const finding of parseFindings(result.text)) {
			const note = formatFinding(finding);
			if (channelFor(finding.severity, immuneTurns) === "steer") {
				rt.sendUserMessage(note, { deliverAs: "steer" });
				firedInterrupt = true;
			} else {
				rt.sendMessage({
					customType: "advisor-note",
					content: note,
					display: true,
				});
			}
		}
		immuneTurns = nextImmuneTurns(immuneTurns, firedInterrupt);
	}

	/** Record the review's cost so observability can show it. */
	function recordCost(
		ctx: ExtensionContext,
		result: Awaited<ReturnType<typeof runInvestigation>>,
		startedAt: number,
	): void {
		const tokens = {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
			cacheWrite: result.usage.cacheWrite,
			total: result.usage.totalTokens,
		};
		recordRunEverywhere(
			runRecordFrom({
				runId: `advisor-${runtime(ctx).sessionId ?? "session"}`,
				subagentId: `review-${++runSeq}`,
				kind: "advisor",
				model: result.model ?? "unknown",
				persona: "advisor",
				startedAt,
				result: {
					exitCode: result.ok ? 0 : 1,
					warnings: result.error ? [result.error] : [],
					usage: { tokens, cost: result.usage.cost },
				},
			}),
		);
	}
}
