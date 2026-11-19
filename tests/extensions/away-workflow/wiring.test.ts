/**
 * Away mode driven through the events pi emits, with a job host on the
 * bus standing in for job-workflow.
 *
 * Long because every case drives the same fake session, job host and
 * mocked desktop through the one extension, and splitting it would copy
 * that harness into each part.
 */

import { rmSync } from "node:fs";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS } from "../../../extensions/away-workflow/carry-on.ts";
import {
	HELD_BACK_ENTRY,
	HELD_LOOK_MS,
} from "../../../extensions/away-workflow/held-back.ts";
import awayWorkflow from "../../../extensions/away-workflow/index.ts";
import {
	machineAwayPath,
	publishMachineWord,
	readMachineWord,
} from "../../../lib/internal/away/machine.ts";
import type { Notice } from "../../../lib/internal/away/notify.ts";
import {
	hold,
	isAway,
	resetAway,
	setProgressSource,
	stoppingFromOutside,
} from "../../../lib/internal/away/state.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	leaveSession,
	stayInSession,
} from "../../../lib/internal/session/left.ts";
import {
	isWakersAsk,
	WAKERS_ASK,
} from "../../../lib/internal/session/wakers.ts";
import {
	forgetWants,
	onWants,
	showWants,
	type WantEvent,
} from "../../../lib/internal/session/wants.ts";
import {
	announceJobHost,
	type Job,
	type RunningJob,
} from "../../../lib/jobs/index.ts";

/** What would have reached the desktop. */
const desktop = vi.hoisted(() => [] as Notice[]);
/** Whether the desktop has stopped answering, as while a reboot stops it. */
const silence = vi.hoisted(() => ({ on: false }));
vi.mock("../../../lib/internal/away/notify.ts", () => ({
	notify: async (notice: Notice) => {
		desktop.push(notice);
		return { id: desktop.length };
	},
	withdrawNotice: ({ id = 0 }) =>
		silence.on
			? new Promise(() => {})
			: Promise.resolve(Reflect.deleteProperty(desktop, id - 1)),
}));

/** The session's move as its presence and note would say it. */
const move = vi.hoisted(() => ({ waits: false, movedOn: false }));
vi.mock(
	"../../../extensions/away-workflow/held-back.ts",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		moveWaits: () => move.waits,
		movedOn: () => move.movedOn,
	}),
);

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
	/** Said to the model already, so no longer taken back. */
	said?: boolean;
}

const disposers: (() => unknown)[] = [];

function activate({ hasUI = true, sessionId = "live" } = {}) {
	const handlers = new Map<string, Handler[]>();
	const events = createEventBus();
	const said: Said[] = [];
	const entries: unknown[] = [];
	const jobs: FakeJob[] = [];
	// Background work the host says is under way, which the test sets.
	const running: RunningJob[] = [];
	const notices: string[] = [];
	const session = { busy: false };
	const wants: WantEvent[] = [];
	disposers.push(onWants(events, (want) => wants.push(want)));
	let tool: Tool | undefined;

	disposers.push(
		announceJobHost(events, {
			running: () => running,
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
						if (job.said) return false;
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
		hasUI,
		isIdle: () => !session.busy,
		sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
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
	// Each session watches the machine's word until it shuts down.
	disposers.push(() => fire("session_shutdown"));
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
	/** Have the bus say something will wake this session, as the mesh would. */
	const wakeable = (waker = "a question [1] awaiting B") => {
		events.on(WAKERS_ASK, (data: unknown) => {
			if (isWakersAsk(data) && data.session === sessionId) {
				data.wakers.push(waker);
			}
		});
	};
	return {
		fire,
		said,
		entries,
		wakeable,
		jobs,
		running,
		notices,
		session,
		goAway,
		runEnds,
		wants,
	};
}

beforeEach(async () => {
	desktop.splice(0);
	silence.on = false;
	move.waits = false;
	move.movedOn = false;
	forgetWants();
	resetAway();
	rmSync(machineAwayPath(), { force: true });
});

afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
	resetAway();
	rmSync(machineAwayPath(), { force: true });
});

describe("a session this process rolled away from", () => {
	// On 3 November a copy left running on a log that had rolled over
	// kept writing the person's absence into it, hours after the switch.
	it("writes nothing of an absence into its old log", async () => {
		const live = activate();
		const left = activate({ sessionId: "left-1" });
		leaveSession("left-1");
		try {
			await left.fire("session_start");
			await live.fire("session_start");

			await live.goAway("finish the subquests");
		} finally {
			stayInSession("left-1");
		}

		expect(live.entries).not.toEqual([]);
		expect(left.entries).toEqual([]);
	});
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

	it("lets a run that says Blocked rest while something will wake it", async () => {
		const pi = activate();
		pi.wakeable();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("Blocked: needs your credentials.");

		expect(pi.jobs).toHaveLength(0);
		expect(isAway(), "a Blocked run leaves away mode on").toBe(true);
	});

	it("sends a Blocked run with nothing to wake it back once, then lets it rest", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("Blocked: waiting on #12 merging.");
		expect(pi.jobs).toHaveLength(1);
		expect(pi.jobs[0]?.summary).toContain(
			"nothing is set to wake this session",
		);

		await pi.runEnds("Blocked: waiting on #12 merging.");
		expect(pi.jobs, "the same line again rests").toHaveLength(1);
		expect(
			pi.entries.filter(
				(entry) =>
					isRecord(entry) && entry.customType === "away-blocked-unwoken",
			),
		).toEqual([
			{
				type: "custom",
				customType: "away-blocked-unwoken",
				data: { line: "Blocked: waiting on #12 merging.", sentBack: true },
			},
			{
				type: "custom",
				customType: "away-blocked-unwoken",
				data: { line: "Blocked: waiting on #12 merging.", sentBack: false },
			},
		]);
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

describe("reaching the person", () => {
	it("reaches them once when the first call is held, however many follow", async () => {
		const pi = activate();
		await pi.fire("session_start");
		setProgressSource(() => ({ document: "PLAN-9", done: 0, total: 2 }));
		await pi.goAway();

		hold({ guard: "pr", title: "Open PR #1" });
		hold({ guard: "pr", title: "Open PR #2" });

		expect(desktop).toHaveLength(1);
		expect(desktop[0]?.title).toBe("PLAN-9 holds a call for you");
	});

	it("reaches them with what a Blocked run needs, once for each thing", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("Built it.\n\nBlocked: needs your npm one-time password.");
		await pi.runEnds("Blocked: needs your npm one-time password.");

		expect(desktop.map((n) => n.body)).toEqual([
			"needs your npm one-time password.",
		]);
	});

	it("leaves what it wants to the launcher while presence shows its wants", async () => {
		// The launcher posts a notice for each want in presence, so a desktop
		// notification of the same held call or Blocked: reached Joel twice,
		// and the second one was never withdrawn.
		const hide = showWants();
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		hold({ guard: "pr", title: "Open PR #1" });
		await pi.runEnds("Blocked: needs your npm one-time password.");
		for (let i = 0; i < 3; i++) await pi.runEnds("Hmm.", 0);
		hide();

		// Resting is no want, so it still says so, quietly.
		expect(desktop.map((n) => n.urgency)).toEqual(["low"]);
	});

	it("ends within the holder's grace while the desktop stops answering", async () => {
		// In the 22:22 reboot on 14 November, 8 of 10 held sessions outlived
		// the holder's 3 s after asking them to end and were killed.
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		hold({ guard: "pr", title: "Open PR #1" });
		await vi.waitFor(() => expect(desktop, "a notice is up").toHaveLength(1));

		silence.on = true;
		const started = performance.now();
		await pi.fire("session_shutdown", { reason: "quit" });
		const took = performance.now() - started;

		expect(took, "left well inside the holder's 3 s").toBeLessThan(2_000);
	}, 5_000);

	it("says quietly that a session rests once it stops being sent back", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		for (let i = 0; i < 3; i++) await pi.runEnds("Hmm.", 0);

		expect(desktop.map((n) => n.urgency)).toEqual(["low"]);
		await pi.fire("agent_start");
		expect(desktop.filter(Boolean), "a run took it back").toEqual([]);
	});

	it("reaches nobody while the person is here", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Blocked: needs you.");

		expect(desktop).toEqual([]);
	});

	it("reaches nobody from a session nobody is at", async () => {
		const pi = activate({ hasUI: false });
		await pi.fire("session_start");
		await pi.goAway();

		hold({ guard: "pr", title: "Open PR #1" });
		await pi.runEnds("Blocked: needs you.");

		expect(desktop).toEqual([]);
	});
});

describe("saying what it wants of the person", () => {
	const saidOf = (wants: WantEvent[]) => wants.map((w) => [w.kind, w.said]);

	it("says the calls held, latest last, until the person is back", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		hold({ guard: "pr", title: "Open PR #1" });
		hold({ guard: "pr", title: "Open PR #2" });
		await pi.fire("input", { text: "morning", source: "interactive" });

		expect(saidOf(pi.wants)).toEqual([
			["approval", "Holds a call for you: Open PR #1"],
			["approval", "Holds 2 calls for you, the latest: Open PR #2"],
			["approval", null],
		]);
		const since = pi.wants.map((w) => ("since" in w ? w.since : null));
		expect(since[0]).toBe(since[1]);
	});

	it("says what a Blocked run needs until the person types", async () => {
		const pi = activate();
		pi.wakeable("a Needs You item, npm-otp, not yet settled");
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("Built it.\n\nBlocked: needs your npm one-time password.");
		expect(saidOf(pi.wants)).toEqual([
			["blocked", "needs your npm one-time password."],
		]);

		await pi.fire("input", { text: "123456", source: "interactive" });
		expect(saidOf(pi.wants).at(-1)).toEqual(["blocked", null]);
	});

	it("says the question a run ended on, with the person here, until they answer", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Two ways on.\n\nShall I take the first?");
		await pi.runEnds("Here's what I found.");
		expect(saidOf(pi.wants)).toEqual([["question", "Shall I take the first?"]]);

		await pi.fire("input", { text: "yes", source: "interactive" });
		expect(saidOf(pi.wants).at(-1)).toEqual(["question", null]);
	});

	it("says nothing from a session nobody is at", async () => {
		const pi = activate({ hasUI: false });
		await pi.fire("session_start");
		await pi.goAway();

		hold({ guard: "pr", title: "Open PR #1" });
		await pi.runEnds("Blocked: needs you.");

		expect(pi.wants).toEqual([]);
	});
});

describe("coming back", () => {
	it("ends on a message the person submits, and tells the model what was held", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		hold({ guard: "slack", title: "Send to #team", body: "hi" });

		await pi.fire("input", { text: "morning", source: "interactive" });

		expect(isAway(), "a message the person submits ends away mode").toBe(false);
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

		expect(pi.jobs[0]).toMatchObject({ withdrawn: true });
	});

	it("is not triggered by a message an extension sent", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.fire("input", {
			text: "[Automated message]",
			source: "extension",
		});

		expect(isAway(), "a message an extension sent leaves away mode on").toBe(
			true,
		);
	});

	it("ends when the person stops a run with Escape, and does not nudge", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("", 0, "aborted");

		expect(isAway(), "the person's Escape ends away mode").toBe(false);
		expect(pi.jobs).toHaveLength(0);
	});

	it("stays away when a steer stopped the run, and lets it rest", async () => {
		// The orchestrator's Stop, from outside the window, aborts the run
		// as Escape does; the person is still asleep.
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		stoppingFromOutside();
		await pi.runEnds("", 0, "aborted");

		expect(isAway(), "a steer's stop leaves away mode on").toBe(true);
		expect(pi.jobs).toHaveLength(0);
		expect(readMachineWord()?.away).toBeDefined();
	});

	it("takes the person's Escape after a steer's stop as theirs", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		stoppingFromOutside();
		await pi.runEnds("", 0, "aborted");

		await pi.runEnds("", 0, "aborted");

		expect(isAway(), "an Escape after a steer's stop ends away mode").toBe(
			false,
		);
	});

	it("ends on pi's own aborted flag too", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		await pi.fire("agent_end", { messages: [] });

		await pi.fire("agent_settled", { aborted: true });

		expect(isAway(), "pi's aborted flag ends away mode").toBe(false);
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

		expect(isAway(), "words that read as a departure leave away mode off").toBe(
			false,
		);
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

		expect(isAway(), "a reloaded session comes back away").toBe(true);
		await second.fire("input", { text: "hi", source: "interactive" });
		expect(
			second.said.find((s) => s.customType === "away-return")?.content,
		).toContain("#1 Send");
	});

	it("starts present in another session when only this one went away", async () => {
		const first = activate({ hasUI: false });
		await first.fire("session_start");
		await first.goAway();

		const other = activate();
		await other.fire("session_start");

		expect(isAway(), "another session starts present").toBe(false);
	});

	it("starts away in another session while the machine is away", async () => {
		const first = activate();
		await first.fire("session_start");
		await first.goAway("overnight work");
		resetAway();

		const other = activate();
		await other.fire("session_start");

		expect(isAway(), "another session starts away with the machine").toBe(true);
	});
});

describe("across the machine", () => {
	it("says the person left, for every session to follow", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.goAway("overnight work");

		expect(readMachineWord()?.away?.goal).toBe("overnight work");
	});

	it("goes away when another window says the person left", async () => {
		const pi = activate();
		await pi.fire("session_start");

		publishMachineWord({ since: new Date().toISOString(), goal: "sleep" });

		await vi.waitFor(() =>
			expect(isAway(), "another window's word sends this one away").toBe(true),
		);
	});

	it("comes back when the person types in another window", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();
		hold({ guard: "slack", title: "Send to #team" });

		publishMachineWord(undefined, new Date(Date.now() + 1_000));

		await vi.waitFor(() =>
			expect(isAway(), "typing in another window brings this one back").toBe(
				false,
			),
		);
		const back = pi.said.find((s) => s.customType === "away-return");
		expect(back?.content).toContain("typed in another window");
		expect(back?.content).toContain("#1 Send to #team");
	});

	it("tells every window when the person types here", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway();

		await pi.fire("input", { text: "morning", source: "interactive" });

		expect(readMachineWord()).toBeDefined();
		expect(readMachineWord()?.away).toBeUndefined();
	});

	it("tells every window, even when no session has said anything yet", async () => {
		const pi = activate({ hasUI: false });
		await pi.fire("session_start");
		await pi.goAway();
		const here = activate();
		await here.fire("session_start");

		await here.fire("input", { text: "morning", source: "interactive" });

		expect(readMachineWord()).toEqual({
			at: expect.any(String),
			by: expect.stringMatching(/^typed in session live at /),
		});
	});

	it("leaves the machine alone in a session nobody is at", async () => {
		const pi = activate({ hasUI: false });
		await pi.fire("session_start");

		await pi.goAway();

		expect(readMachineWord()).toBeUndefined();
	});
});

describe("carrying on when nobody answers", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		setProgressSource(() => ({
			document: "PLAN-9",
			done: 1,
			total: 4,
			next: "Docs",
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("takes the plan's next item once a quiet stretch passes", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Merged the first piece.");
		vi.advanceTimersByTime(QUIET_MS - 1);
		expect(pi.jobs).toHaveLength(0);
		vi.advanceTimersByTime(1);

		expect(pi.jobs).toHaveLength(1);
		expect(pi.jobs[0]?.summary).toContain("Next: Docs");
		expect(desktop).toEqual([]);
	});

	it("waits again for as long as the person stays quiet", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("First piece.");
		vi.advanceTimersByTime(QUIET_MS);
		await pi.fire("agent_start");
		await pi.runEnds("Second piece.");
		vi.advanceTimersByTime(QUIET_MS);

		expect(pi.jobs).toHaveLength(2);
	});

	it("carries on nothing once the person answers", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Merged the first piece.");
		await pi.fire("input", { text: "hold on", source: "interactive" });
		vi.advanceTimersByTime(QUIET_MS);

		expect(pi.jobs).toHaveLength(0);
	});

	it("withdraws a carry-on not yet said when the person types", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Merged the first piece.");
		vi.advanceTimersByTime(QUIET_MS);
		await pi.fire("input", { text: "wait", source: "interactive" });

		expect(pi.jobs[0]).toMatchObject({ withdrawn: true });
	});

	it("reaches the person once with a question it asked, and carries on", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Built it.\n\nShall I merge it?");
		vi.advanceTimersByTime(QUIET_MS);

		expect(desktop.map((n) => n.title)).toEqual(["PLAN-9 asked you something"]);
		expect(pi.jobs[0]?.summary).toContain("Your question stands");
	});

	it("does not carry on while a run is under way", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Merged the first piece.");
		pi.session.busy = true;
		vi.advanceTimersByTime(QUIET_MS);

		expect(pi.jobs).toHaveLength(0);
	});

	it("leaves a session nobody is at alone", async () => {
		const pi = activate({ hasUI: false });
		await pi.fire("session_start");

		await pi.runEnds("Merged the first piece.");
		vi.advanceTimersByTime(QUIET_MS);

		expect(pi.jobs).toHaveLength(0);
	});

	it("hands over to keep-going once the person says they are away", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Merged the first piece.");
		await pi.goAway();
		vi.advanceTimersByTime(QUIET_MS);

		expect(pi.jobs).toHaveLength(0);
	});
});

// On 18 and 19 November a session ended turns with "Waiting on the eval
// tests (j27)." while j27 ran on for an hour, telling the person nothing.
describe("a run that ends only naming a job that runs", () => {
	const evalTests = { id: "j27", kind: "shell", label: "the eval tests" };

	it("is sent back once to say where things stand", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		await pi.fire("session_start");

		await pi.runEnds("Waiting on the eval tests (j27).");
		expect(pi.jobs).toHaveLength(1);
		expect(pi.jobs[0]?.summary).toContain("Running now: j27 (the eval tests)");

		await pi.runEnds("Still waiting on j27.", 0);
		expect(pi.jobs, "the answer is never sent back").toHaveLength(1);
	});

	it("is left alone with no job running", async () => {
		const pi = activate();
		await pi.fire("session_start");

		await pi.runEnds("Waiting on the eval tests (j27).");

		expect(pi.jobs).toHaveLength(0);
	});

	it("is left alone in a session nobody is at", async () => {
		const pi = activate({ hasUI: false });
		pi.running.push(evalTests);
		await pi.fire("session_start");

		await pi.runEnds("Waiting on j27.");

		expect(pi.jobs).toHaveLength(0);
	});

	it("speaks for the run while away, and keep-going judges the answer", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		await pi.fire("session_start");
		await pi.goAway("finish the subquests");

		await pi.runEnds("Waiting on j27.");
		expect(pi.jobs, "one send-back, not two").toHaveLength(1);
		expect(pi.jobs[0]?.summary).toContain("Running now: j27");
		expect(pi.jobs[0]?.summary).not.toContain("finish the subquests");

		await pi.runEnds("j27 runs the eval tests; then I push.", 0);
		expect(pi.jobs).toHaveLength(2);
		expect(pi.jobs[1]?.summary).toContain("finish the subquests");
	});

	it("starts no quiet wait for the bare run, only for its answer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			setProgressSource(() => ({ document: "PLAN-9", done: 1, total: 4 }));
			const pi = activate();
			pi.running.push(evalTests);
			await pi.fire("session_start");

			await pi.runEnds("Waiting on j27.", 3);
			vi.advanceTimersByTime(QUIET_MS);
			expect(pi.jobs, "only the send-back").toHaveLength(1);

			// The answer made no calls of its own; the bare run's count for it.
			await pi.runEnds("j27 runs the eval tests, about five minutes more.", 0);
			vi.advanceTimersByTime(QUIET_MS);
			expect(pi.jobs).toHaveLength(2);
			expect(pi.jobs[1]?.summary).toContain("PLAN-9 has 3 open items");
		} finally {
			setProgressSource(undefined);
			vi.useRealTimers();
		}
	});

	it("lets a Blocked: ending while away rest on the job that wakes it", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		pi.wakeable("1 background job");
		await pi.fire("session_start");
		await pi.goAway();

		await pi.runEnds("Blocked: waiting on j27.");

		expect(pi.jobs).toHaveLength(0);
	});

	it("sends nothing back while a move waits, and the next run starts afresh", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		await pi.fire("session_start");
		await pi.runEnds("Waiting on j27.");

		move.waits = true;
		await pi.runEnds("Waiting on j27.");
		expect(pi.jobs, "none while the move waits").toHaveLength(1);

		move.waits = false;
		await pi.runEnds("Waiting on j27.");
		expect(pi.jobs, "the skipped run answered the send-back").toHaveLength(2);
	});

	it("is off with PI_JOB_WAIT=off", async () => {
		vi.stubEnv("PI_JOB_WAIT", "off");
		try {
			const pi = activate();
			pi.running.push(evalTests);
			await pi.fire("session_start");

			await pi.runEnds("Waiting on j27.");

			expect(pi.jobs).toHaveLength(0);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("still answers a send-back already said when the person types into its answer", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		await pi.fire("session_start");
		await pi.runEnds("Waiting on j27.");
		const sent = pi.jobs[0];
		if (sent) sent.said = true;

		await pi.fire("input", { text: "and j31?", source: "interactive" });
		await pi.runEnds("Waiting on j27.");

		expect(pi.jobs, "the answer is not sent back").toHaveLength(1);
	});

	it("starts afresh once the person stops the run answering a send-back", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		await pi.fire("session_start");
		await pi.runEnds("Waiting on j27.");

		// pi from 1.1 says so on the settled event itself.
		await pi.fire("agent_end", { messages: [] });
		await pi.fire("agent_settled", { aborted: true });
		await pi.runEnds("Waiting on j27.");

		expect(pi.jobs, "a stopped run answers nothing").toHaveLength(2);
	});

	it("takes back a send-back not yet said when the person types, and starts afresh", async () => {
		const pi = activate();
		pi.running.push(evalTests);
		await pi.fire("session_start");
		await pi.runEnds("Waiting on j27.");

		await pi.fire("input", { text: "what's j27?", source: "interactive" });
		expect(pi.jobs[0]).toMatchObject({ withdrawn: true });

		await pi.runEnds("Waiting on j27.");
		expect(
			pi.jobs,
			"the person's run is no answer to a send-back",
		).toHaveLength(2);
	});
});

/** The send-backs a session's log holds back for a move. */
function heldBack(entries: readonly unknown[]): unknown[] {
	return entries.filter(
		(entry) => isRecord(entry) && entry.customType === HELD_BACK_ENTRY,
	);
}

// On 15 November a release waited out its whole deadline on a hosted
// conversation away mode kept sending back: each send-back started the
// next run as the last settled, and a move looks only between runs.
describe("while a move waits for the session", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes the send-back into the log rather than start a run", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway("finish the subquests");
		move.waits = true;

		await pi.runEnds("Here's where things stand.");

		expect(pi.jobs, "no run is started").toHaveLength(0);
		expect(heldBack(pi.entries)).toEqual([
			{
				type: "custom",
				customType: HELD_BACK_ENTRY,
				data: { text: expect.stringContaining("finish the subquests") },
			},
		]);
	});

	it("sends it back itself once the move is called off", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway("finish the subquests");
		move.waits = true;
		await pi.runEnds("Here's where things stand.");

		vi.advanceTimersByTime(HELD_LOOK_MS);
		expect(pi.jobs, "not while the move waits").toHaveLength(0);
		move.waits = false;
		vi.advanceTimersByTime(HELD_LOOK_MS);

		expect(pi.jobs).toHaveLength(1);
		expect(pi.jobs[0]?.summary).toContain("finish the subquests");
	});

	it("leaves it to the next pi once the session has moved on", async () => {
		const pi = activate();
		await pi.fire("session_start");
		await pi.goAway("finish the subquests");
		move.waits = true;
		await pi.runEnds("Here's where things stand.");

		move.movedOn = true;
		vi.advanceTimersByTime(HELD_LOOK_MS * 2);

		expect(pi.jobs).toHaveLength(0);
	});
});

describe("a session opened on a log that held a send-back back", () => {
	/** A log that went away and held a send-back back as it moved. */
	const movedLog = async (): Promise<unknown[]> => {
		const first = activate();
		await first.fire("session_start");
		await first.goAway("finish the subquests");
		move.waits = true;
		await first.runEnds("Here's where things stand.");
		move.waits = false;
		move.movedOn = true;
		const log = [...first.entries];
		await first.fire("session_shutdown");
		resetAway();
		return log;
	};

	it("sends it on as it opens, the person still away", async () => {
		const log = await movedLog();
		const next = activate();
		next.entries.push(...log);

		await next.fire("session_start", { reason: "resume" });

		const sent = next.said.filter((s) => s.customType === "away-sent-on");
		expect(sent).toEqual([
			{
				customType: "away-sent-on",
				content: expect.stringContaining("finish the subquests"),
				display: true,
				options: { triggerTurn: true },
			},
		]);
	});

	it("leaves it on a reload, which keeps the session's own look", async () => {
		const log = await movedLog();
		const next = activate();
		next.entries.push(...log);

		await next.fire("session_start", { reason: "reload" });

		expect(next.said.filter((s) => s.customType === "away-sent-on")).toEqual(
			[],
		);
	});

	it("leaves it once the person is back", async () => {
		const log = await movedLog();
		publishMachineWord(undefined, new Date(Date.now() + 1_000));
		const next = activate();
		next.entries.push(...log);

		await next.fire("session_start", { reason: "resume" });

		expect(next.said.filter((s) => s.customType === "away-sent-on")).toEqual(
			[],
		);
	});
});
