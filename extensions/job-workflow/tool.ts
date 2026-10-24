/**
 * The `jobs` tool: the agent's way to list its session's background jobs
 * and stop one, as `/jobs` is the person's.
 *
 * Without it an agent that wanted a job gone killed its shell by hand.
 * On 23 October one killed a job's shell and its direct children; the
 * nix build beneath them was a grandchild and ran on, writing at its old
 * offset into a log a later job had reused, and holding a VM the machine
 * queue had counted free once the shell was gone. Stopping through the
 * host aborts the producer's signal, and pi's bash answers that by
 * killing the shell's whole process group, grandchildren included.
 *
 * A stop the tool answered is not said again as a message: the call's
 * own answer is how the agent hears it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { asText, renderToolCall } from "../../lib/ui/index.ts";
import type { JobEntry, Jobs } from "./jobs.ts";

/** A tool answer: text, and whether it is a refusal. */
function answer(text: string, refused = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		...(refused ? { isError: true } : {}),
	};
}

/** One job as the agent reads it in a list. */
function line(entry: JobEntry): string {
	const state =
		entry.state === "running" ? "running" : "finished, result on its way";
	return `${entry.id} ${entry.spec.kind} (${state}): ${entry.spec.label}`;
}

/** Register `jobs`, reading the session's jobs at each call. */
export function registerJobsTool(
	pi: ExtensionAPI,
	jobsNow: () => Jobs | undefined,
): void {
	pi.registerTool({
		name: "jobs",
		// Wanted only when a job has to go: loaded on demand.
		exposure: "deferred",
		label: "Jobs",
		description:
			"List this session's background jobs, or stop one. A command " +
			"handed off to the background, a background fleet and a watched " +
			"review round are each a job, named by the id the hand-off gave " +
			"(j1, j2 ...). Stop a job here rather than killing its shell: " +
			"this kills the shell's whole process group, so what it started " +
			"(a nix build, a VM) goes too, and its place in the machine queue " +
			"is freed. Only this session's jobs are listed.",
		// What the index of tools that load on demand says of it, so a job
		// that has to go is stopped here and not by killing its shell.
		promptSnippet:
			"List this session's background jobs, or stop one by id; stop a job here, never by killing its shell.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("stop")], {
				description: "list: every job held. stop: stop the job named by id.",
			}),
			id: Type.Optional(
				Type.String({
					description: "For stop: the job's id, as the hand-off named it.",
				}),
			),
		}),
		renderCall(args, theme, context) {
			const action = typeof args.action === "string" ? args.action : "list";
			const id = typeof args.id === "string" ? args.id : undefined;
			return renderToolCall(
				{ tool: "jobs", action, ...(id !== undefined ? { subject: id } : {}) },
				theme,
				asText(context?.lastComponent),
			);
		},
		async execute(_toolCallId, params) {
			const jobs = jobsNow();
			if (params.action === "list") {
				const entries = jobs?.list() ?? [];
				if (entries.length === 0)
					return answer("No background jobs in this session.");
				return answer(entries.map(line).join("\n"));
			}
			if (params.id === undefined || params.id.trim() === "") {
				return answer(
					"Nothing was stopped: stop needs the job's id. Call jobs list to see them.",
					true,
				);
			}
			const id = params.id.trim();
			const entry = jobs?.list().find((job) => job.id === id);
			const outcome = jobs?.stopForAgent(id) ?? "unknown";
			if (outcome === "unknown") {
				return answer(
					`Nothing was stopped: this session holds no job ${id}. Call jobs list to see the ones it does; a job another session started is that session's to stop.`,
					true,
				);
			}
			if (outcome === "finished") {
				return answer(
					`Nothing was stopped: job ${id} has already finished, and its result is on its way as a message of its own.`,
					true,
				);
			}
			const what = entry ? ` (${entry.spec.kind}: ${entry.spec.label})` : "";
			return answer(
				`Stopped ${id}${what}. Its work was told to stop; a shell job's whole process group is killed, grandchildren included. Nothing more will be said about it.`,
			);
		},
	});
}
