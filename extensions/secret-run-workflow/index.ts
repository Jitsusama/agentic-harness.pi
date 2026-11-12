/**
 * Secret Run Workflow: an agent asks Joel for one work secret, given to
 * one command, and never holds the value.
 *
 * The tool writes an ask for core's secret-asks daemon, which draws it
 * as a line in the launcher's Asks: the session, the quest, the item,
 * why, the whole command and the folder it runs in. Only Joel's key
 * there says yes; the daemon then reads the item from 1Password and runs
 * the command with it, and the agent hears only how it ended and the
 * command's output, masked. An ask goes as soon as its call is stopped,
 * its job is stopped or its session ends, so no line waits on Joel for
 * work nobody wants any more.
 *
 * It's refused, before anything reaches Joel's screen: while this
 * session's commands run outside the fence, which is what keeps an
 * agent's command from reaching the asks folder or the daemon's socket
 * itself; inside a script, which can't hand the wait off; while the
 * session already has an ask waiting; and for the same item and command
 * within an hour of Joel's no.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	sessionCwd,
	sessionEnv,
	sessionKeyOf,
} from "../../lib/core/session/index.ts";
import { dataDir } from "../../lib/internal/paths.ts";
import { extractTitle } from "../../lib/internal/quest/quest-doc.ts";
import { sandboxFor } from "../../lib/internal/sandbox.ts";
import {
	LONGEST_MINUTES,
	putAsk,
	type SecretAnswer,
	takeAsk,
} from "../../lib/internal/secret-ask.ts";
import { endsWithItsPrompts, runOrHandOff } from "../../lib/jobs/hand-off.ts";
import { questAddress, sessionAddress } from "../../lib/mesh/address.ts";
import { waitForAnswer } from "./wait.ts";

/** The tool's name. */
export const SECRET_RUN_TOOL = "secret_run";

/** How long an ask waits on Joel before the daemon ends it. */
const WAITS_MS = 10 * 60 * 1000;

/** How long a refused ask's item and command stay refused unasked. */
const REFUSED_FOR_MS = 60 * 60 * 1000;

/** Past the ask's wait and its run, how long before nobody is taken to be answering. */
const GRACE_MS = 60 * 1000;

/** How long a command runs when the ask doesn't say. */
const DEFAULT_MINUTES = 5;

/** The variable the value is given as when the ask doesn't say. */
const DEFAULT_GIVEN = "SECRET";

interface SecretRunParams {
	readonly item: string;
	readonly argv: string[];
	readonly why: string;
	readonly tree?: string;
	readonly given?: string;
	readonly minutes?: number;
}

/** A plain answer the agent reads, marked as an error when it is one. */
function said(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		...(isError ? { isError: true } : {}),
	};
}

/** What the agent hears of an answer. */
export function answerText(answer: SecretAnswer): string {
	if (answer.state === "ran") {
		const ended =
			answer.exit === null || answer.exit === undefined
				? "It was stopped at its time limit."
				: `It exited ${answer.exit}.`;
		const output = answer.output ?? "";
		const cut = answer.cut ? "\n(The output was cut at its cap.)" : "";
		return `Joel said yes and the command ran. ${ended} Its output, with the value masked:\n${output}${cut}`;
	}
	if (answer.state === "refused") {
		return `Joel said no${answer.why ? ` (${answer.why})` : ""}. Don't ask again for this; say in words what you need it for, or do the work another way.`;
	}
	return `The ask ended ${answer.state}${answer.why ? `: ${answer.why}` : ""}. Nothing ran.`;
}

/** The quest's title from its README, or its id when it can't be read. */
function questTitle(id: string): string {
	try {
		const readme = readFileSync(
			join(dataDir("quest-workflow"), "quests", id, "README.md"),
			"utf8",
		);
		return extractTitle(readme) ?? id;
	} catch {
		// A quest whose README can't be read is named by its id.
		return id;
	}
}

export default function secretRunWorkflow(pi: ExtensionAPI) {
	// Per session, kept in this instance: a host's conversations each
	// have their own key, so none sees another's.
	const waiting = new Map<string, string>();
	const refusals = new Map<
		string,
		{ readonly what: string; readonly at: number }
	>();

	pi.registerTool({
		name: SECRET_RUN_TOOL,
		label: "Secret Run",
		description:
			"Ask Joel to release one work secret from 1Password to one command, which runs with the value in one environment variable. He sees the item, why, the whole command and the folder it runs in as a line in his launcher, and says yes or no there; the value never reaches you, only how the command ended and its output, masked. Use it only for a command that cannot work without the secret, such as a publish.",
		promptSnippet:
			"Ask Joel to release a work secret to one command with secret_run; you never see the value.",
		promptGuidelines: [
			"Use secret_run only when a command can't work without a secret, and say why in one plain line Joel can judge at a glance.",
			"After a no from Joel, don't ask again for the same thing: say in words what you need it for.",
		],
		parameters: Type.Object({
			item: Type.String({
				description: "The 1Password reference, op://<vault>/<item>/<field>.",
			}),
			argv: Type.Array(Type.String(), {
				description:
					"The command as words, never a shell line, since what Joel reads is what runs.",
			}),
			why: Type.String({
				description: "Why, in one plain line of at most 200 characters.",
			}),
			tree: Type.Optional(
				Type.String({
					description:
						"The folder it runs in, read-only; this session's folder when left out.",
				}),
			),
			given: Type.Optional(
				Type.String({
					description: `The environment variable the value goes in; ${DEFAULT_GIVEN} when left out.`,
				}),
			),
			minutes: Type.Optional(
				Type.Number({
					description: `How long it may run, 1 to ${LONGEST_MINUTES}; ${DEFAULT_MINUTES} when left out.`,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const asked = params as SecretRunParams;
			const session = sessionKeyOf(ctx);
			const env = sessionEnv(session);
			// A nested call answers its script, which would then hold the
			// session for the whole wait on Joel.
			if (toolCallId.includes("/")) {
				return said(
					"secret_run can't run inside a script, which would wait on Joel for up to 15 minutes; call it on its own.",
					true,
				);
			}
			if (sandboxFor(env.snapshot()).kind !== "fence") {
				return said(
					"secret_run is refused while this session's commands run outside the agent fence, since only the fence keeps them from the asks. Ask Joel in words instead.",
					true,
				);
			}
			const runtime = env.get("XDG_RUNTIME_DIR");
			if (
				!runtime ||
				!existsSync(join(runtime, "daemons", "secret-asks.sock"))
			) {
				return said(
					"secret_run needs core's secret-asks daemon, which doesn't run on this machine. Ask Joel in words instead.",
					true,
				);
			}
			if (waiting.has(session)) {
				return said(
					"This session already has an ask waiting on Joel; wait for its answer before asking again.",
					true,
				);
			}
			const what = JSON.stringify([asked.item, asked.argv]);
			const refused = refusals.get(session);
			if (
				refused &&
				refused.what === what &&
				Date.now() - refused.at < REFUSED_FOR_MS
			) {
				return said(
					"Joel said no to this item for this command within the hour. Say in words what you need it for rather than asking again.",
					true,
				);
			}

			const folder = join(runtime, "secret-asks");
			const questId = env.get("PI_QUEST");
			const minutes = asked.minutes ?? DEFAULT_MINUTES;
			let id: string;
			try {
				id = putAsk(folder, {
					session: questId ? questAddress(questId) : sessionAddress(session),
					...(questId
						? { quest: { id: questId, title: questTitle(questId) } }
						: {}),
					item: asked.item,
					why: asked.why,
					argv: asked.argv,
					tree: resolve(sessionCwd(ctx), asked.tree ?? "."),
					given: asked.given ?? DEFAULT_GIVEN,
					minutes,
				}).id;
			} catch (error) {
				return said(
					`The ask was refused before it reached Joel: ${error instanceof Error ? error.message : String(error)}.`,
					true,
				);
			}
			waiting.set(session, id);

			return await runOrHandOff({
				kind: "secret",
				label: `an ask for ${asked.item}`,
				noun: "background ask",
				filePrefix: "pi-secret-run",
				stopping: (jobId) =>
					`To take the ask back, call the jobs tool's stop with ${jobId} (load it with tool_search). The person can stop it with /jobs, or answer it in the launcher.`,
				quiet: "It waits on Joel's answer in the launcher.",
				toolCallId,
				session,
				nested: endsWithItsPrompts(ctx.mode),
				signal,
				onUpdate,
				bus: pi.events,
				run: async (owned) => {
					// One listener for every way the wait can stop (Escape, a
					// stopped job, the session's end), on the signal the work runs under.
					const takeBack = () => takeAsk(folder, id);
					owned.addEventListener("abort", takeBack, { once: true });
					try {
						const waited = await waitForAnswer(
							folder,
							id,
							owned,
							WAITS_MS + minutes * 60 * 1000 + GRACE_MS,
						);
						if (waited.kind === "stopped") {
							return said("The ask was taken back before Joel answered.", true);
						}
						if (waited.kind === "unanswered") {
							return said(
								"Nobody answered the ask, so it was taken back: the secret-asks daemon may not be running. Nothing ran.",
								true,
							);
						}
						if (waited.answer.state === "refused") {
							refusals.set(session, { what, at: Date.now() });
						}
						return said(
							answerText(waited.answer),
							waited.answer.state !== "ran",
						);
					} finally {
						owned.removeEventListener("abort", takeBack);
						takeAsk(folder, id);
						waiting.delete(session);
					}
				},
			});
		},
	});
}
