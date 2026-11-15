/**
 * A message reaching a session at the attention it bears: put in as
 * context, glanced at as one line, or kept off the screen while the
 * session is quiet, never as a prompt that stops what it is doing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomMessageComponent,
	initTheme,
	type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	ADVISORY,
	ASKS,
	type Delivered,
	GLANCE,
	GLANCES,
	MOST_GLANCES,
	NOTED,
} from "../../../extensions/mesh-workflow/delivery.ts";
import {
	MOST_CAUGHT_UP,
	MOST_IN_FULL_FROM_ONE,
} from "../../../lib/mesh/damping.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { endTurn } from "../../support/turn-end.ts";
import {
	fixture,
	fromElsewhere,
	judging,
	leased,
	notYours,
	pausedByItsPerson,
	peer,
	type Renderer,
	send,
	type Sent,
	session,
	startSession,
} from "./support/mesh.ts";

describe("a message as context", () => {
	it("is put in without starting or extending a turn", async () => {
		const { sent } = await startSession();

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message).toMatchObject({
			customType: NOTED,
			display: true,
		});
	});

	it("tells the model it is for awareness, not a task", async () => {
		// Said with the message, because the note in front of a model is
		// what it takes as its next instruction.
		const { sent } = await startSession();

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const content = sent[0]?.message.content ?? "";
		expect(content).toMatch(
			/Mesh message \[[0-9a-f]{8}\] \(fyi\) from WCJQSG to #all at \d\d:\d\d:/,
		);
		expect(content).toContain("hold heavy builds until I say done");
		expect(content.slice(-ADVISORY.length)).toBe(ADVISORY);
	});

	it("catches up on what arrived before it started, once, without a turn", async () => {
		// Starting with messages waiting once asked pi for a second turn
		// while the first prompt was about to run, which pi refuses.
		fromElsewhere({ text: "one" });
		// A real pause, so the second is sent a clock tick after the first.
		await new Promise((wake) => setTimeout(wake, 2));
		fromElsewhere({ text: "two" });

		const first = await startSession();
		await vi.waitFor(() => expect(first.sent).toHaveLength(1));
		expect(first.sent[0]?.options).toEqual({ triggerTurn: false });
		expect(first.sent[0]?.message.content).toMatch(/one[\s\S]*two/);

		// A reload is a fresh start that has read them already.
		const again = await startSession();
		// A real pause: the test is that no catch-up arrives in it.
		await new Promise((wake) => setTimeout(wake, 20));
		expect(again.sent).toEqual([]);
	});

	it("hands over a long catch-up in full only for its newest and its own", async () => {
		const dir = join(fixture.paths.mesh, "messages");
		mkdirSync(dir, { recursive: true });
		const senders = ["WCJQSG", "P9R1KI", "2HN63P", "OVAE1I", "CV3XVS"];
		const count = MOST_CAUGHT_UP + 5;
		const text = (n: number) => `news-${String(n).padStart(2, "0")}`;
		for (let n = 0; n < count; n += 1) {
			const sent = Date.now() - 60_000 + n * 100;
			const from = senders[n % senders.length] as string;
			const id = `${sent}-${from}-7-aaaaaaaa`;
			writeFileSync(
				join(dir, `${id}.json`),
				JSON.stringify({
					v: 1,
					id,
					at: new Date(sent).toISOString(),
					from,
					to: n === 0 ? ["@7M6JKG"] : [ALL],
					intent: "fyi",
					text: text(n),
					pid: 7,
				}),
			);
		}

		const { sent, entries } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const details = sent[0]?.message.details as Delivered;
		expect(details.messages.map((one) => one.text)).toEqual([
			text(0),
			...Array.from({ length: MOST_CAUGHT_UP }, (_, n) => text(n + 5)),
		]);
		expect(
			entries
				.filter((entry) => entry.type === GLANCE)
				.map((entry) => (entry.data as { message: Message }).message.text),
		).toEqual([text(1), text(2), text(3), text(4)]);
	});

	it("glances at a sender's fyi once it has had the hour's in full", async () => {
		const { sent, entries } = await startSession({}, { isIdle: () => false });
		for (let n = 0; n < MOST_IN_FULL_FROM_ONE; n += 1) {
			fromElsewhere({ to: ["@7M6JKG"], text: `news ${n}` });
			await vi.waitFor(() => expect(sent).toHaveLength(n + 1));
		}

		fromElsewhere({ to: ["@7M6JKG"], text: "one more" });
		fromElsewhere({ to: ["@7M6JKG"], from: "P9R1KI", text: "from another" });

		await vi.waitFor(() =>
			expect(sent.at(-1)?.message.content).toContain("from another"),
		);
		expect(entries.find((entry) => entry.type === GLANCE)?.data).toMatchObject({
			message: { text: "one more" },
			why: expect.stringContaining("the hour's news from WCJQSG spent"),
		});
	});

	it("counts a sender's news within what it catches up on at once", async () => {
		for (let n = 0; n <= MOST_IN_FULL_FROM_ONE; n += 1) {
			fromElsewhere({ to: ["@7M6JKG"], text: `news ${n}` });
		}

		const { sent, entries } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const details = sent[0]?.message.details as Delivered;
		expect(details.messages).toHaveLength(MOST_IN_FULL_FROM_ONE);
		expect(entries.filter((entry) => entry.type === GLANCE)).toHaveLength(1);
	});

	it("glances at an fyi it catches up on past its hour", async () => {
		const hour = 60 * 60 * 1000;
		const dir = join(fixture.paths.mesh, "messages");
		const sent = Date.now() - 2 * hour;
		const id = `${sent}-WCJQSG-7-aaaaaaaa`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({
				v: 1,
				id,
				at: new Date(sent).toISOString(),
				from: "WCJQSG",
				to: ["@7M6JKG"],
				intent: "fyi",
				text: "the stick is free",
				pid: 7,
			}),
		);
		writeFileSync(join(dir, ".read-7M6JKG"), `${sent - hour}-X-1-bbbbbbbb`);

		const { entries } = await startSession();

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0]).toMatchObject({
			type: GLANCE,
			data: { why: "an fyi past its hour" },
		});
	});

	it("hands over nothing meant for another group, and none of its own", async () => {
		const { sent, tools } = await startSession();

		fromElsewhere({ to: ["@OVAE1I"], text: "not for you" });
		await send(tools, "#optimus", "fyi", "from me");
		fromElsewhere({ to: ["@7M6JKG"], text: "for you" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("for you");
		expect(sent[0]?.message.content).not.toContain("not for you");
	});

	it("hears the peer that took over a quest it once held, and not what is sent to it", async () => {
		// Seen live: the session that spawned LUQ49E still answered to it,
		// so it took LUQ49E's messages for its own and dropped them.
		mkdirSync(join(fixture.paths.quests, "QEST-20261021-LUQ49E"), { recursive: true });
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-LUQ49E", "README.md"),
			`sessions:\n  - id: ${session}\n`,
		);
		peer("session-l", ["LUQ49E"], []);
		const { sent } = await startSession();

		fromElsewhere({ from: "LUQ49E", to: ["@LUQ49E"], text: "to LUQ49E" });
		fromElsewhere({ from: "LUQ49E", text: "from LUQ49E" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("from LUQ49E");
		expect(sent[0]?.message.content).not.toContain("to LUQ49E");
	});

	it("says only what the intents delivered ask", async () => {
		const { sent } = await startSession();

		fromElsewhere({ intent: "hold", text: "hold heavy builds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const content = sent[0]?.message.content ?? "";
		expect(content).toContain(ASKS.hold);
		expect(content).not.toContain(ASKS.question);
		expect(content).not.toContain(ASKS.fyi);
	});
});

describe("a glance", () => {
	it("is shown at once and kept out of context until the next turn", async () => {
		const calls: unknown[] = [];
		const { sent, entries } = await startSession({}, judging(notYours, calls));

		fromElsewhere({ text: "merging core.nix#330 now" });

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0]?.type).toBe(GLANCE);
		expect(sent).toEqual([]);
		// The classifier is told who is receiving, not just what was said.
		expect(JSON.stringify(calls[0])).toContain("7M6JKG");
	});

	it("reaches the model as one line at the end of the current step", async () => {
		const { sent, entries, fire } = await startSession({}, judging(notYours));
		const glanced = fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		await endTurn(fire);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message).toMatchObject({
			customType: GLANCES,
			display: false,
			details: { glanced: [glanced.id] },
		});
		const lines = sent[0]?.message.content.split("\n") ?? [];
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(
			/^- \d\d:\d\d \[[0-9a-f]{8}\] fyi from WCJQSG to #all: merging core\.nix#330 now$/,
		);

		// Handed over once.
		await endTurn(fire);
		expect(sent).toHaveLength(1);
	});

	it("opens the next run while the session is idle", async () => {
		const { entries, fire } = await startSession({}, judging(notYours));
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		const opened = (await fire("before_agent_start")) as {
			message?: { customType: string; content: string };
		};

		expect(opened?.message?.customType).toBe(GLANCES);
		expect(opened?.message?.content).toContain("merging core.nix#330 now");
		expect(await fire("before_agent_start")).toBeUndefined();
	});

	it("rides along with the next message noted in full", async () => {
		const { sent, entries } = await startSession({}, judging(notYours));
		fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		fromElsewhere({ intent: "hold", text: "hold heavy builds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.customType).toBe(NOTED);
		expect(sent[0]?.message.content).toContain("hold heavy builds");
		expect(sent[0]?.message.content).toContain("merging core.nix#330 now");
	});

	it("spells out a few and counts the rest", async () => {
		const { sent, entries, fire } = await startSession({}, judging(notYours));
		for (let n = 0; n < MOST_GLANCES + 3; n++) {
			fromElsewhere({ text: `progress ${n}` });
		}
		await vi.waitFor(() => expect(entries).toHaveLength(MOST_GLANCES + 3));

		await endTurn(fire);

		const content = sent[0]?.message.content ?? "";
		expect(content.split("\n")).toHaveLength(MOST_GLANCES + 2);
		expect(content).toMatch(/- and 3 more$/);
	});

	it("is cut to one line however long it was", async () => {
		const { sent, entries, fire } = await startSession({}, judging(notYours));
		fromElsewhere({ text: `${"word ".repeat(80)}\nsecond line` });
		await vi.waitFor(() => expect(entries).toHaveLength(1));

		await endTurn(fire);

		const glance = sent[0]?.message.content.split("\n")[1] ?? "";
		expect(glance.length).toBeLessThanOrEqual(160);
		expect(glance).toMatch(/…$/);
	});

	it("still reaches the model after a reload, and only once", async () => {
		// A glance shown but not yet delivered when the session reloads.
		const waiting = fromElsewhere({ text: "waiting" });
		const carried = fromElsewhere({ text: "carried" });
		const branch = [
			{ type: "custom", customType: GLANCE, data: { message: carried } },
			{
				type: "custom_message",
				customType: GLANCES,
				details: { messages: [], glanced: [carried.id] },
			},
			{ type: "custom", customType: GLANCE, data: { message: waiting } },
		];
		// Both were read before the reload.
		folderTransport(join(fixture.paths.mesh, "messages")).markRead(
			"7M6JKG",
			waiting.id,
		);

		const { sent, fire } = await startSession({}, {}, branch);
		await endTurn(fire);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("waiting");
		expect(sent[0]?.message.content).not.toContain("carried");
	});

	it("is noted in full when the classifier fails", async () => {
		const { sent, entries } = await startSession(
			{},
			judging(new Error("network gone")),
		);

		fromElsewhere({ text: "merging core.nix#330 now" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(entries).toEqual([]);
	});

	it("asks no classifier when it is switched off", async () => {
		const calls: unknown[] = [];
		const { sent } = await startSession(
			{ PI_MESH_CLASSIFIER: "off" },
			judging(notYours, calls),
		);

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(calls).toEqual([]);
	});

	it("shows the classifier what this peer is changing now, and asks about it", async () => {
		const calls: unknown[] = [];
		const { sent, entries } = await startSession({}, judging(notYours, calls));
		leased(session, { subject: "agentic-harness.pi:lib/mesh/attention.ts" });

		fromElsewhere({ text: "merging core #366 to main now. Shell only." });

		await vi.waitFor(() => expect(calls).toHaveLength(1));
		const asked = calls[0] as {
			state: { receiver: { changing_now?: string[] } };
			questions: { about: { instructions: string } };
		};
		expect(asked.state.receiver.changing_now).toEqual([
			"agentic-harness.pi:lib/mesh/attention.ts",
		]);
		expect(asked.questions.about.instructions).toContain("changing now");
		await vi.waitFor(() => expect(entries[0]?.type).toBe(GLANCE));
		expect(sent).toEqual([]);
	});

	it("takes a message naming a file this peer changes as its own, unasked", async () => {
		const calls: unknown[] = [];
		const { sent } = await startSession({}, judging(notYours, calls));
		leased(session, { subject: "agentic-harness.pi:lib/mesh/attention.ts" });

		fromElsewhere({ text: "lib/mesh/attention.ts glances at my holds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(calls).toEqual([]);
		expect(JSON.stringify(sent[0]?.message)).toContain(
			"about this peer's work",
		);
	});
});

describe("quiet", () => {
	// Joel, 11 November 2026: a session he steers "that is focused only on
	// me and doesn't show a bunch of background shit."
	const plainTheme = { fg: (_colour: string, text: string) => text };
	const quietLog = [
		{ type: "custom", customType: "mesh-quiet", data: { on: true } },
	];
	const drawn = (
		renderers: Map<string, Renderer>,
		one: Sent | undefined,
		expanded = false,
	): string[] => {
		const render = renderers.get("mesh");
		if (!render || !one) return ["(nothing to draw)"];
		return render(one.message, { expanded }, plainTheme).render(120);
	};

	it("keeps peers' fyis and findings off the screen, and hands the model them whole", async () => {
		const { sent, renderers } = await startSession(
			{},
			{ isIdle: () => true },
			quietLog,
		);

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		fromElsewhere({ intent: "finding", to: ["@7M6JKG"], text: "your bug" });
		await vi.waitFor(() => expect(sent).toHaveLength(2));

		expect(drawn(renderers, sent[0])).toEqual([]);
		expect(drawn(renderers, sent[1])).toEqual([]);
		expect(sent[0]?.message.content).toContain("merged #950");
		expect(sent[1]?.message.content).toContain("your bug");
	});

	it("leaves no row on pi's screen for what it keeps off", async () => {
		// Joel, 11 November 2026: "for mesh quiet, it is still printing blank
		// lines to my pi terminal." Drawn through pi's own component, which
		// puts a blank line above each message.
		initTheme();
		const { sent, renderers } = await startSession(
			{},
			{ isIdle: () => true },
			quietLog,
		);

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		const one = sent[0]?.message;
		const render = renderers.get("mesh");
		if (!one || !render) throw new Error("no delivery to draw");
		const row = new CustomMessageComponent(
			{ role: "custom", timestamp: 0, display: true, ...one },
			// The test's renderer is pi's, read through the stand-in's narrower type.
			render as unknown as MessageRenderer,
		);
		expect(row.render(120)).toEqual([]);
		row.setExpanded(true);
		expect(row.render(120).join("\n")).toContain("merged #950");
	});

	it("opens what it kept off when the person expands the screen", async () => {
		// ctrl+o rebuilds a custom message expanded, as it opens tool output.
		const { sent, renderers } = await startSession(
			{},
			{ isIdle: () => true },
			quietLog,
		);

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		expect(drawn(renderers, sent[0], true).join("\n")).toContain("merged #950");
	});

	it("still shows a question, a hold and a pivot", async () => {
		const { sent, renderers } = await startSession(
			{},
			{ isIdle: () => true },
			quietLog,
		);

		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		fromElsewhere({ intent: "hold", to: ["@7M6JKG"], text: "hold builds" });
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		fromElsewhere({ intent: "pivot", to: ["@7M6JKG"], text: "take up X" });
		await vi.waitFor(() => expect(sent).toHaveLength(3));

		const lines = sent.map((one) => drawn(renderers, one).join("\n"));
		expect(lines[0]).toContain("why?");
		expect(lines[1]).toContain("hold builds");
		expect(lines[2]).toContain("take up X");
	});

	it("still shows an answer to this peer while its person has paused it", async () => {
		// Paused, the answer is handed over with no turn, like any fyi.
		pausedByItsPerson();
		const { sent, renderers, tools } = await startSession(
			{},
			{ isIdle: () => true },
			quietLog,
		);
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "#optimus", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(fixture.paths.mesh, "messages")).ids();

		fromElsewhere({ intent: "fyi", re: asked, text: "I do, until 03:00." });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(drawn(renderers, sent[0]).join("\n")).toContain(
			"I do, until 03:00.",
		);
	});

	it("shows everything while it is off, as it is by default", async () => {
		const { sent, renderers } = await startSession({}, { isIdle: () => true });

		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		expect(drawn(renderers, sent[0]).join("\n")).toContain("merged #950");
	});

	it("keeps the session's own sends off the screen too", async () => {
		// Joel, 11 November 2026: "mesh quiet is still showing me mesh
		// messages you send."
		const { tools } = await startSession({}, { isIdle: () => true }, quietLog);
		const meshSend = tools.get("mesh_send") as unknown as {
			renderShell?: string;
			renderCall: (
				args: unknown,
				theme: unknown,
				context: unknown,
			) => { render: (width: number) => string[] };
		};
		const theme = { ...plainTheme, bg: plainTheme.fg, bold: (t: string) => t };
		const context = { expanded: false, state: {}, outputPad: 1 };

		expect(meshSend.renderShell).toBe("self");
		expect(
			meshSend.renderCall({ text: "merged" }, theme, context).render(80),
		).toEqual([]);
	});

	it("turns on and off with /mesh quiet, kept in the session's log", async () => {
		const notices: string[] = [];
		const ui = { notify: (text: string) => notices.push(text) };
		const { sent, renderers, commands, entries } = await startSession(
			{},
			{ isIdle: () => true },
		);
		const mesh = commands.get("mesh");

		await mesh?.handler("quiet", { ui });
		fromElsewhere({ intent: "fyi", to: ["@7M6JKG"], text: "merged #950" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(drawn(renderers, sent[0])).toEqual([]);

		await mesh?.handler("quiet off", { ui });
		expect(drawn(renderers, sent[0]).join("\n")).toContain("merged #950");
		expect(entries.filter(({ type }) => type === "mesh-quiet")).toEqual([
			{ type: "mesh-quiet", data: { on: true } },
			{ type: "mesh-quiet", data: { on: false } },
		]);

		await mesh?.handler("loud", { ui });
		expect(notices.at(-1)).toContain("Usage: /mesh quiet [on|off]");
	});
});
