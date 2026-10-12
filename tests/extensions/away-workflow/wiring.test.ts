/**
 * Away mode driven through the events pi emits, with a job host on the
 * bus standing in for job-workflow.
 */

import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import awayWorkflow from "../../../extensions/away-workflow/index.ts";
import {
	hold,
	isAway,
	resetAway,
	setProgressSource,
} from "../../../lib/internal/away/state.ts";
import { announceJobHost, type Job } from "../../../lib/jobs/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Tool {
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { text: string }[] }>;
}

interface Said {
	customType: string;
	content: string;
	options: unknown;
}

interface FakeJob {
	summary?: string;
	withdrawn: boolean;
}

const disposers: (() => void)[] = [];

function activate() {
	const handlers = new Map<string, Handler[]>();
	const events = createEventBus();
	const said: Said[] = [];
	const entries: unknown[] = [];
	const jobs: FakeJob[] = [];
	const notices: string[] = [];
	const session = { busy: false };
	let tool: Tool | undefined;

	disposers.push(
		announceJobHost(events, {
			start: (): Job => {
				const job: FakeJob = { withdrawn: false };
				jobs.push(job);
				return {
					id: `j${jobs.length}`,
					signal: new AbortController().signal,
					finish: (outcome) => {
						job.summary = outcome.summary;
					},
					onDelivered: () => {},
					withdraw: () => {
						job.withdrawn = true;
						return true;
					},
				};
			},
		}),
	);

	const pi = {
		events,
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: () => {},
		registerTool: (definition: Tool) => {
			tool = definition;
		},
		sendMessage: (
			message: { customType: string; content: string },
			options: unknown,
		) => said.push({ ...message, options }),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !session.busy,
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: () => {},
			notify: (text: string) => notices.push(text),
			theme: { fg: (_colour: string, text: string) => text },
		},
	};
	awayWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const goAway = async (goal?: string) => {
		await tool?.execute("t1", goal ? { goal } : {}, undefined, undefined, ctx);
	};
	/** A run that ends with this reply, with this many tool calls. */
	const runEnds = async (text: string, toolCalls = 1, stopReason = "stop") => {
		await fire("agent_end", {
			messages: [
				{
					role: "assistant",
					stopReason,
					content: [
						...Array.from({ length: toolCalls }, () => ({ type: "toolCall" })),
						{ type: "text", text },
					],
				},
			],
		});
		await fire("agent_settled", {});
	};
	return { fire, said, entries, jobs, notices, session, goAway, runEnds };
}

beforeEach(async () => {
	resetAway();
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	resetAway();
});

describe("while away", () => {
	it("sends a run that stopped short back to work with the goal", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway("finish the subquests");

		await pi.runEnds("Here's where things stand.");

		expect(pi.jobs).toHaveLength(1);
		expect(pi.jobs[0]?.summary).toContain("finish the subquests");
	});

	it("names the plan's next item when quest-workflow says where it stands", async () => {
		const pi = activate();
		await pi.fire("session_start");
		setProgressSource(() => ({
			document: "PLAN-9",
			done: 1,
			total: 4,
			next: "Docs",
		}));
		await pi.goAway();

		await pi.runEnds("Paused.");

		expect(pi.jobs[0]?.summary).toContain(
			"PLAN-9: 1 of 4 items done. Next: Docs",
		);
	});

	it("lets a run that says Blocked rest", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("Blocked: needs your credentials.");

		expect(pi.jobs).toHaveLength(0);
		expect(isAway()).toBe(true);
	});

	it("does not nudge when the person is here", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Want me to continue?");

		expect(pi.jobs).toHaveLength(0);
	});

	it("says in the transcript when it stops nudging", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		for (let i = 0; i < 3; i++) await pi.runEnds("Hmm.", 0);

		expect(pi.jobs).toHaveLength(2);
		expect(pi.said.map((s) => s.customType)).toContain("away-stopped");
	});
});

describe("coming back", () => {
	it("ends on a message the person submits, and tells the model what was held", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		hold({ guard: "slack", title: "Send to #team", body: "hi" });

		await pi.fire("input", { text: "morning", source: "interactive" });

		expect(isAway()).toBe(false);
		const back = pi.said.find((s) => s.customType === "away-return");
		expect(back?.content).toContain("#1 Send to #team");
		expect(back?.options).toEqual({ deliverAs: "nextTurn" });
	});

	it("steers the note into a run already under way, so it is read now", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		hold({ guard: "slack", title: "Send" });
		pi.session.busy = true;

		await pi.fire("input", { text: "stop that", source: "interactive" });

		const back = pi.said.find((s) => s.customType === "away-return");
		expect(back?.options).toEqual({ deliverAs: "steer" });
	});

	it("takes back a nudge not yet said", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		await pi.runEnds("Summary.");

		await pi.fire("input", { text: "I'm back", source: "interactive" });

		expect(pi.jobs[0]?.withdrawn).toBe(true);
	});

	it("is not triggered by a message an extension sent", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.fire("input", {
			text: "[Automated message]",
			source: "extension",
		});

		expect(isAway()).toBe(true);
	});

	it("ends when the person stops a run with Escape, and does not nudge", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("", 0, "aborted");

		expect(isAway()).toBe(false);
		expect(pi.jobs).toHaveLength(0);
	});

	it("ends on pi's own aborted flag too", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		await pi.fire("agent_end", { messages: [] });

		await pi.fire("agent_settled", { aborted: true });

		expect(isAway()).toBe(false);
	});
});

describe("a message that reads like leaving", () => {
	it("adds a hint for the model rather than switching away mode on", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.fire("input", {
			text: "I'm going to bed, keep working on the plan",
			source: "interactive",
		});

		expect(isAway()).toBe(false);
		expect(pi.said.map((s) => s.customType)).toEqual(["away-hint"]);
	});
});

describe("across a restart", () => {
	it("comes back away, with what was held", async () => {
		const first = activate();
		await first.fire("session_start");
		await first.goAway("overnight work");
		hold({ guard: "slack", title: "Send" });
		const saved = [...first.entries];
		resetAway();

		const second = activate();
		second.entries.push(...saved);
		await second.fire("session_start");

		expect(isAway()).toBe(true);
		await second.fire("input", { text: "hi", source: "interactive" });
		expect(
			second.said.find((s) => s.customType === "away-return")?.content,
		).toContain("#1 Send");
	});

	it("starts present in another session, though this process was away", async () => {
		const first = activate();
		await first.fire("session_start");
		await first.goAway();

		const other = activate();
		await other.fire("session_start");

		expect(isAway()).toBe(false);
	});
});
