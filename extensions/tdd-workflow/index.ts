/**
 * TDD Workflow Extension
 *
 * A tracker and a reminder for test-driven development, not a
 * turnstile. The agent drives one discrete red-green-refactor
 * loop at a time through the tdd_phase tool, attesting each
 * transition. The machine advances only when the attestation
 * carries the justification the step requires, and otherwise
 * hands back guidance and changes nothing. There are no user
 * prompts: the human's surface is the passive glyph scoreboard.
 *
 * The extension interprets nothing about the outside world. It
 * never reads code, test output or file paths; the one guardrail
 * it enforces is the agent's own contract, which is what stays
 * robust across every language.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { disciplineFor } from "./discipline.js";
import { persist, restore, updateScoreboard } from "./lifecycle.js";
import { transition } from "./machine.js";
import { createTddState } from "./state.js";
import { buildTddContext, tddContextFilter } from "./transitions.js";

/** Width fallback when the terminal width is unknown. */
const DEFAULT_WIDTH = 80;
/** Approximate width of the rendered call prefix, for truncation. */
const CALL_PREFIX_WIDTH = 18;

export default function tddMode(pi: ExtensionAPI) {
	const state = createTddState();

	pi.registerTool({
		name: "tdd_phase",
		label: "TDD Phase",
		description:
			"Drive one discrete red-green-refactor loop by attesting each transition.",
		promptSnippet:
			"Drive TDD as discrete loops with tdd_phase: start, write, red, green, " +
			"refactor, done. Each transition needs a short justification. Read the " +
			"code-tdd-guide skill for the methodology.",
		promptGuidelines: [
			"Run one loop per increment: start with the single behaviour you want, then close it with done before starting another.",
			"Each transition carries its own justification: start needs the behaviour, write needs the exported surface, red needs the failure you saw, green needs the passing result, done needs a one-line design reflection.",
			"Attest red honestly. A compile or missing-symbol error is failureKind 'other' and is not a real red, so stub a minimal skeleton, re-run, and call red again with the assertion failure (failureKind 'assertion') before you go green.",
			"A refused transition hands back guidance and changes nothing. Read it, do the work it names, then try again. There is no user prompt to wait on.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"start",
					"write",
					"red",
					"green",
					"refactor",
					"done",
					"abandon",
				] as const,
				{ description: "The transition to attest." },
			),
			behaviour: Type.Optional(
				Type.String({
					description:
						"start: the single behaviour under test, named as the exported thing you want to exist.",
				}),
			),
			interface: Type.Optional(
				Type.String({
					description: "write: the exported surface this test binds to.",
				}),
			),
			failure: Type.Optional(
				Type.String({
					description: "red: the failure you saw when you ran the test.",
				}),
			),
			failureKind: Type.Optional(
				StringEnum(["assertion", "other"] as const, {
					description:
						"red: 'assertion' for a real assertion failure, 'other' for a compile or missing-symbol error.",
				}),
			),
			pass: Type.Optional(
				Type.String({
					description: "green: the passing result you saw.",
				}),
			),
			reflection: Type.Optional(
				Type.String({
					description:
						"done: a one-line note on what you reconsidered about the internal and external design.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description: "abandon: why you're leaving the loop.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = transition(state.loop, {
				action: params.action,
				behaviour: params.behaviour,
				interface: params.interface,
				failure: params.failure,
				failureKind: params.failureKind,
				pass: params.pass,
				reflection: params.reflection,
				reason: params.reason,
			});

			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.guidance }],
					details: {
						ok: false,
						phase: state.loop.phase,
						message: result.guidance,
					},
				};
			}

			state.loop = result.state;
			persist(state, pi);
			updateScoreboard(state, ctx);

			const phase = result.state.phase;
			const message = `In ${phase}: ${disciplineFor(phase)}`;
			return {
				content: [{ type: "text", text: message }],
				details: { ok: true, phase, message },
			};
		},

		renderCall(args, theme) {
			const a = args as {
				action?: string;
				behaviour?: string;
				interface?: string;
				failure?: string;
				pass?: string;
				reflection?: string;
				reason?: string;
			};
			const action = a.action ?? "?";
			let text = theme.fg("toolTitle", theme.bold("tdd_phase "));
			text += theme.fg("text", action);

			const note =
				a.behaviour ??
				a.interface ??
				a.failure ??
				a.pass ??
				a.reflection ??
				a.reason;
			if (note) {
				const room =
					(process.stdout.columns || DEFAULT_WIDTH) -
					CALL_PREFIX_WIDTH -
					action.length;
				const snippet =
					note.length > room
						? `${note.slice(0, Math.max(0, room - 1))}…`
						: note;
				text += theme.fg("dim", `: ${snippet}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as
				| { ok?: boolean; phase?: string; message?: string }
				| undefined;
			const message =
				d?.message ??
				(result.content?.[0] && "text" in result.content[0]
					? result.content[0].text
					: "");
			if (!message) {
				return new Text("", 0, 0);
			}

			const firstLine = message.split("\n")[0] ?? "";
			const maxWidth = process.stdout.columns || DEFAULT_WIDTH;
			const truncated =
				firstLine.length > maxWidth - 4
					? `${firstLine.slice(0, maxWidth - 5)}…`
					: firstLine;

			if (d?.ok === false) {
				return new Text(theme.fg("warning", `↩ ${truncated}`), 0, 0);
			}
			return new Text(theme.fg("muted", truncated), 0, 0);
		},
	});

	pi.on("before_agent_start", async () => buildTddContext(state));

	pi.on("context", tddContextFilter(state));

	pi.on("session_start", async (_event, ctx) => {
		restore(state, ctx);
		updateScoreboard(state, ctx);
	});
}
