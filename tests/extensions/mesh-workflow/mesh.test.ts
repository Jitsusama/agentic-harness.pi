/**
 * The mesh as a session meets it: messages reach it as context at the
 * attention they bear, never as a prompt that stops what it is doing,
 * and never not at all.
 *
 * What pins that here is what pi is handed: the delivery options, and
 * the digest a glance arrives in. pi's own rules decide the rest:
 * without a turn, a message sent mid-run is appended once the current
 * step's tool results are in, one sent while idle is appended with no
 * turn, and one returned from before_agent_start opens the next run.
 *
 * This file keeps what a session's presence says; the rest of the mesh
 * as a session meets it is in the mesh-*.test.ts files beside it, each
 * by what its cases test, over the setup in support/mesh.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { automatedText } from "../../../lib/internal/automated.ts";
import {
	SESSION_LANDED,
	SESSION_UNLANDED,
} from "../../../lib/internal/session/landings.ts";
import { SESSION_WANTS } from "../../../lib/internal/session/wants.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import {
	fixture,
	pausedByItsPerson,
	session,
	startSession,
} from "./support/mesh.ts";

describe("groups", () => {
	it("says in presence what this session waits on, from the bus, held until it starts", async () => {
		const kept = () =>
			createPresences(join(fixture.paths.mesh, "presence")).of(session)?.wants;
		const held = {
			kind: "approval",
			since: "2026-10-22T08:00:00.000Z",
			said: "Push to main?",
		};
		const asked = {
			kind: "question",
			since: "2026-10-22T08:05:00.000Z",
			said: "Which launcher?",
		};

		const { emit } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			(early) => early(SESSION_WANTS, held),
		);
		const withId = (want: { kind: string; since: string }) => ({
			...want,
			id: `${want.kind}@${want.since}`,
		});
		expect(kept()).toEqual(withId(held));

		emit(SESSION_WANTS, asked);
		expect(kept()).toEqual(withId(held));
		emit(SESSION_WANTS, { kind: "approval", said: null });
		expect(kept()).toEqual(withId(asked));
		emit(SESSION_WANTS, { kind: "question", said: null });
		expect(kept()).toBeUndefined();
		emit(SESSION_WANTS, { kind: "lunch", since: held.since, said: "hi" });
		expect(kept()).toBeUndefined();
	});

	it("keeps in presence what this session landed, from the bus, held until it starts", async () => {
		const kept = () =>
			createPresences(join(fixture.paths.mesh, "presence"))
				.of(session)
				?.landings?.map((one) => one.ref);
		const landing = (ref: string) => ({
			at: new Date().toISOString(),
			ref,
			what: `${ref} landed`,
		});

		const { emit } = await startSession(
			{},
			{},
			[],
			undefined,
			undefined,
			(early) => early(SESSION_LANDED, landing("agentic-harness.pi#920")),
		);
		expect(kept()).toEqual(["agentic-harness.pi#920"]);

		emit(SESSION_LANDED, landing("PLAN-20261030-QMUYBH#15"));
		expect(kept()).toEqual([
			"PLAN-20261030-QMUYBH#15",
			"agentic-harness.pi#920",
		]);
		// An untick takes its item back.
		emit(SESSION_UNLANDED, { ref: "PLAN-20261030-QMUYBH#15" });
		expect(kept()).toEqual(["agentic-harness.pi#920"]);
	});
});

describe("a message that names no group", () => {
	it("says nothing in presence of what the file holds, as a session starts", async () => {
		fixture.paths = { ...fixture.paths, waiting: join(fixture.root, "waiting") };
		mkdirSync(fixture.paths.waiting ?? "", { recursive: true });
		writeFileSync(
			join(fixture.root, "waiting", "7M6JKG.json"),
			JSON.stringify({
				updated: "2026-10-26T03:00:00.000Z",
				quest: "QEST-20261021-7M6JKG",
				items: [
					{
						id: "look",
						title: "Look at the sheet",
						why: "His taste",
						minutes: 1,
						when: "now",
						window: null,
						quest: "QEST-20261021-7M6JKG",
						ready: true,
					},
				],
			}),
		);

		await startSession();

		expect(
			createPresences(join(fixture.paths.mesh, "presence")).of(session)?.wants,
		).toBeUndefined();
	});

	it("keeps what waits on the person where the launcher reads it, and out of presence", async () => {
		fixture.paths = { ...fixture.paths, waiting: join(fixture.root, "waiting") };
		const { tools } = await startSession();
		const wait = (params: Record<string, unknown>) =>
			tools.get("mesh_wait")?.execute("call-w", params);
		const file = join(fixture.root, "waiting", "7M6JKG.json");
		const presence = () =>
			createPresences(join(fixture.paths.mesh, "presence")).of(session);

		const unknowable = await wait({
			id: "eero-login",
			title: "Log in to eero",
			why: "Only Joel has the account",
			minutes: 2,
		});
		expect(unknowable?.content[0]?.text).toContain(
			"Nothing was kept: say how it will be known done",
		);
		expect(existsSync(file), `${file} is not written`).toBe(false);

		// Nothing writes the file a sign-in would be heard from, so an item
		// waiting on one would never clear.
		const signin = await wait({
			id: "eero-login",
			title: "Log in to eero",
			why: "Only Joel has the account",
			minutes: 2,
			doneWhen: { signal: "signin:eero" },
			steps: ["Open the eero app", "Sign in"],
		});
		expect(signin?.content[0]?.text).toContain(
			"Nothing was kept: nothing says signin:eero yet",
		);
		expect(existsSync(file), `${file} is not written`).toBe(false);

		const kept = await wait({
			id: "eero-login",
			title: "Log in to eero",
			why: "Only Joel has the account",
			minutes: 2,
			when: "now",
			doneWhen: { check: "eero-signed-in" },
			steps: ["Open the eero app", "Sign in"],
		});

		expect(kept?.content[0]?.text).toContain("Kept eero-login");
		expect(kept?.content[0]?.text).toContain(
			"clears itself once `eero-signed-in` succeeds",
		);
		// No daemon has judged anything yet, so the owner settles it itself.
		expect(kept?.content[0]?.text).toContain(
			"Nothing judges checks or signals yet, since the desktop's daemon hasn't written its verdicts, so settle it with done: true once it is done.",
		);
		// Joel, 8 November: "I have no clue what to act on or even how."
		const stepless = await wait({
			id: "router-look",
			title: "Look at the router",
			why: "Only Joel is home",
			minutes: 1,
			doneWhen: { by: "person" },
		});
		expect(stepless?.content[0]?.text).toContain("give the steps he takes");
		const later = await wait({
			id: "router-look",
			title: "Look at the router",
			why: "Only Joel is home",
			minutes: 1,
			readyWhen: { signal: "switch:d6f916e3" },
			doneWhen: { by: "person" },
			steps: ["Look at its light"],
		});
		expect(later?.content[0]?.text).toContain(
			"so say it again with ready: true once it is.",
		);
		await wait({ id: "router-look", done: true });
		writeFileSync(
			join(fixture.root, "verdicts.json"),
			JSON.stringify({ v: 1, updated: new Date().toISOString(), items: {} }),
		);
		const judged = await wait({
			id: "router-look",
			title: "Look at the router",
			why: "Only Joel is home",
			minutes: 1,
			readyWhen: { signal: "switch:d6f916e3" },
			doneWhen: { by: "person" },
			steps: ["Look at its light"],
		});
		expect(judged?.content[0]?.text).not.toContain("Nothing judges");
		await wait({ id: "router-look", done: true });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			v: 2,
			quest: "QEST-20261021-7M6JKG",
			items: [
				{
					id: "eero-login",
					title: "Log in to eero",
					why: "Only Joel has the account",
					minutes: 2,
					when: "now",
					quest: "QEST-20261021-7M6JKG",
					ready: true,
					doneWhen: { check: "eero-signed-in" },
					steps: ["Open the eero app", "Sign in"],
					// The daemon refuses a strict session's check; this one runs open.
					owner: { session, sandbox: "none" },
					raisedAt: expect.any(String),
					checkedAt: expect.any(String),
				},
			],
		});
		expect(presence()?.wants).toBeUndefined();
		expect(presence()?.state).not.toBe("waiting");

		const refused = await wait({ id: "look", title: "Look" });
		expect(refused?.content[0]?.text).toContain("Nothing was kept");

		await wait({ id: "eero-login", done: true });

		expect(existsSync(file), `${file} is removed`).toBe(false);
		expect(presence()?.wants).toBeUndefined();
	});
});

describe("presence", () => {
	it("names this process, so others can ask whether it is still there", async () => {
		await startSession();

		const own = createPresences(join(fixture.paths.mesh, "presence")).of(session);

		expect(own?.owner?.pid).toBe(process.pid);
	});

	it("says whether the peer is mid-run", async () => {
		const { fire } = await startSession();
		const own = () =>
			createPresences(join(fixture.paths.mesh, "presence")).of(session)?.busy;

		expect(own(), "a peer not yet running reads as not busy").toBe(false);
		await fire("agent_start");
		expect(own(), "a peer mid-run reads as busy").toBe(true);
		await fire("agent_end");
		expect(own(), "a peer whose run ended reads as not busy").toBe(false);
	});

	it("says a run's step and what its model calls took, from pi's events", async () => {
		const { fire } = await startSession();
		const own = () => createPresences(join(fixture.paths.mesh, "presence")).of(session);
		const answer = {
			role: "assistant",
			provider: "anthropic",
			model: "claude-opus-5-5",
			content: [],
			usage: {
				input: 5,
				output: 40,
				cacheRead: 9_000,
				cacheWrite: 100,
				cost: { total: 0.1 },
			},
		};

		await fire("agent_start");
		await fire("turn_start", { turnIndex: 0, timestamp: Date.now() });
		expect(own()?.stepDetail).toMatchObject({ kind: "thinking" });
		await fire("message_update", { message: answer });
		await fire(
			"message_end",
			{ message: answer },
			{
				getContextUsage: () => ({
					tokens: 9_145,
					contextWindow: 200_000,
					percent: 4,
				}),
			},
		);
		await fire("tool_execution_start", {
			toolName: "bash",
			args: { command: "pnpm check" },
		});
		await fire("agent_end");

		expect(own()?.stepDetail).toBeUndefined();
		expect(own()?.usage).toMatchObject({
			"gen_ai.request.model": "claude-opus-5-5",
			"gen_ai.provider.name": "anthropic",
			today: { "gen_ai.usage.cache_read.input_tokens": 9_000 },
			context: { used: 9_145, limit: 200_000 },
			turns: { today: 1, last: { first_token_ms: expect.any(Number) } },
			"pi.cost.usd": { last: 0.1, today: 0.1 },
		});
	});

	it("keeps a pause through a reload, until the person types in the window", async () => {
		const presences = pausedByItsPerson();
		let aborted = 0;
		const { fire } = await startSession({}, { abort: () => aborted++ });
		expect(presences.of(session)?.state).toBe("paused");

		await fire("input", { source: "extension", text: "a job's report" });
		await fire("agent_start");
		expect(aborted).toBe(1);

		await fire("agent_end");
		await fire("input", { source: "interactive", text: "what now?" });
		await fire("agent_start");
		expect(aborted).toBe(1);
		expect(presences.of(session)?.state).toBe("busy");
	});

	it("says a person drives it once a person's words reach it, and not before", async () => {
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		const { fire } = await startSession();
		expect(presences.of(session)?.driven, "undriven at first").toBe(false);

		await fire("input", {
			source: "extension",
			text: automatedText("background work is reporting", "j1 exited 0"),
		});
		expect(presences.of(session)?.driven, "the harness is no person").toBe(
			false,
		);
		await fire("input", { source: "rpc", text: "ship it" });
		expect(presences.of(session)?.driven, "a client's prompt is").toBe(true);
	});

	it("says a person drives it from the log it starts on", async () => {
		const presences = createPresences(join(fixture.paths.mesh, "presence"));
		await startSession({}, {}, [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "." }] },
			},
		]);
		expect(presences.of(session)?.driven, "a lone dot is a person's").toBe(
			true,
		);
	});
});
