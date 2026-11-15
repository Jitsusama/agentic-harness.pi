/**
 * What answers a message: an answer and where it goes, a withdrawal of
 * one already sent, and ending another peer's hold on the person's word.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTED } from "../../../extensions/mesh-workflow/delivery.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { endTurn } from "../../support/turn-end.ts";
import {
	fixture,
	fromElsewhere,
	judging,
	leased,
	notYours,
	ownBoard,
	peer,
	send,
	sentOut,
	startSession,
} from "./support/mesh.ts";

describe("an answer", () => {
	it("to this peer's own message gets a turn, wherever it went", async () => {
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "#optimus", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(fixture.paths.mesh, "messages")).ids();

		fromElsewhere({ intent: "question", re: asked, text: "which version?" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(sent[0]?.message.content).toMatch(/answering \[[0-9a-f]{8}\]/);
	});

	it("to this peer's question gets a turn however it was sent", async () => {
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		peer("session-w", ["WCJQSG"], []);
		await send(tools, "#optimus", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(fixture.paths.mesh, "messages")).ids();

		fromElsewhere({ intent: "fyi", re: asked, text: "I do, until 03:00." });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
	});

	it("names the question this peer took up when its answer names none", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "which qemu?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		const said = await send(tools, "WCJQSG", "fyi", "9.1, from nixpkgs");

		const answer = sentOut().at(-1);
		expect(answer?.re).toBe(asked.id);
		expect(said).toContain(
			`It answers [${asked.id.slice(-8)}], the question this peer took up; name re to say it answers another.`,
		);
	});

	it("takes a question of its own to the asker for no answer", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "review #778?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		const said = await send(tools, "WCJQSG", "question", "who folds quest?");

		expect(sentOut().at(-1)?.re).toBeUndefined();
		expect(said).not.toContain("the question this peer took up");
	});

	it("names no question for an answer elsewhere, a hold, or one of two", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { sent, tools } = await startSession({}, { isIdle: () => true });
		fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "which qemu?",
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		await send(tools, "#harness", "fyi", "qemu 9.1 is in");
		await send(tools, "WCJQSG", "hold", "hold qemu while I test");
		fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "and which nix?",
		});
		await vi.waitFor(() =>
			expect(ownBoard().filter(({ kind }) => kind === "answer")).toHaveLength(
				2,
			),
		);
		await send(tools, "WCJQSG", "fyi", "9.1, and 2.31");

		expect(sentOut().map(({ re }) => re)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("names every mesh tool in the line the prompt always shows", async () => {
		const { tools } = await startSession();
		const snippet =
			(tools.get("mesh_send") as { promptSnippet?: string } | undefined)
				?.promptSnippet ?? "";
		const names = [...tools.keys()].filter((name) => name.startsWith("mesh_"));
		expect(names.length).toBeGreaterThan(1);
		for (const name of names.filter((name) => name !== "mesh_send")) {
			expect(snippet).toContain(name);
		}
	});

	it("stands under this peer's question as it is read back", async () => {
		peer("session-p", ["P9R1KI"], ["#optimus"]);
		const { tools } = await startSession();
		await send(tools, "#optimus", "question", "who has qemu?");
		const [asked = ""] = folderTransport(join(fixture.paths.mesh, "messages")).ids();
		const readBack = async () =>
			(await tools.get("mesh_read")?.execute("call-2", {}))?.content[0]?.text ??
			"";

		expect(await readBack()).toContain("\n  unanswered after 0 min");
		leased("session-p", { kind: "answer", subject: asked });
		expect(await readBack()).toContain("\n  being answered by P9R1KI");
		const answer = fromElsewhere({
			from: "P9R1KI",
			to: ["@WCJQSG"],
			re: asked,
			text: "I do",
		});
		expect(await readBack()).toContain(
			`\n  answered by P9R1KI, last in [${answer.id.slice(-8)}]`,
		);
	});

	it("goes back to whoever asked when it answers and names nowhere", async () => {
		const { tools } = await startSession();
		peer("session-w", ["WCJQSG"], []);
		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "are you there?",
		});

		const answer = await tools.get("mesh_send")?.execute("call-1", {
			intent: "fyi",
			text: "PONG",
			re: asked.id.slice(-8),
		});

		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const sent = transport.ids().map((id) => transport.read(id));
		expect(sent.find((one) => one?.text === "PONG")?.to).toEqual(["@WCJQSG"]);
		expect(answer?.content[0]?.text).not.toContain("It named no group");
	});

	it("goes without its reply when the message it answers is not there", async () => {
		const { tools } = await startSession();
		peer("session-w", ["WCJQSG"], []);

		const answer = await tools.get("mesh_send")?.execute("call-1", {
			to: "WCJQSG",
			intent: "fyi",
			text: "x",
			re: "ffffffff",
		});

		expect(answer?.content[0]?.text).toContain(
			"No message has the id ffffffff, so it answers nothing. mesh_read shows each message's id in brackets.",
		);
		const [id] = folderTransport(join(fixture.paths.mesh, "messages")).ids();
		expect(
			folderTransport(join(fixture.paths.mesh, "messages")).read(id as string),
		).not.toHaveProperty("re");
	});
});

describe("a withdrawal", () => {
	it("goes wherever what it replaces went, and only from its sender", async () => {
		const { tools } = await startSession();
		peer("session-w", ["WCJQSG"], ["#optimus"]);
		await send(tools, "#optimus", "finding", "the cache is poisoned");
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [said = ""] = transport.ids();

		await tools.get("mesh_send")?.execute("call-2", {
			to: "WCJQSG",
			intent: "finding",
			text: "the cache is fine; it was my disk",
			supersedes: said.slice(-8),
		});
		const others = fromElsewhere({ to: ["#optimus"], text: "mine" });
		const refused = await tools.get("mesh_send")?.execute("call-3", {
			to: "#optimus",
			intent: "fyi",
			text: "not yours",
			supersedes: others.id,
		});

		expect(transport.read(transport.ids()[1] ?? "")).toMatchObject({
			to: ["#optimus", "@WCJQSG"],
			supersedes: said,
		});
		expect(refused?.content[0]?.text).toContain(
			"was sent by WCJQSG, and only a message's sender may replace it",
		);
		const read = await tools.get("mesh_read")?.execute("call-4", {});
		expect(read?.content[0]?.text).toMatch(
			/the cache is poisoned\n {2}withdrawn: replaced by \[[0-9a-f]{8}\], so go by that instead/,
		);
	});

	it("takes back a glance not yet handed over, and is noted by whoever heard it", async () => {
		const { sent, fire } = await startSession({}, judging(notYours));

		const said = fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() =>
			expect(
				folderTransport(join(fixture.paths.mesh, "messages")).lastRead(["7M6JKG"]),
			).toBe(said.id),
		);
		fromElsewhere({ text: "not merging after all", supersedes: said.id });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.customType).toBe(NOTED);
		expect(sent[0]?.message.content).toContain("which its sender withdraws");
		expect(sent[0]?.message.details).toMatchObject({ glanced: [] });
		await endTurn(fire);
		expect(sent).toHaveLength(1);
	});

	it("stays a glance for a peer whose quest hears only what is put to it", async () => {
		mkdirSync(join(fixture.paths.quests, "QEST-20261021-7M6JKG"), { recursive: true });
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
			"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\nhears: addressed\n---\n# QEST-20261021-7M6JKG\n",
		);
		const { sent, entries } = await startSession();
		const glanced = () =>
			entries.filter((entry) => entry.type === "mesh-glance").length;

		const said = fromElsewhere({ text: "merging core.nix#330 now" });
		await vi.waitFor(() => expect(glanced()).toBe(1));
		fromElsewhere({ text: "not merging after all", supersedes: said.id });

		await vi.waitFor(() => expect(glanced()).toBe(2));
		expect(sent).toHaveLength(0);
	});
});

describe("ending another peer's hold on the person's word", () => {
	afterEach(() => restoreSessionModes({}));

	/** Answer a hold through the tool, saying the person ended it. */
	const ending = async (
		tools: Awaited<ReturnType<typeof startSession>>["tools"],
		re: string,
	) =>
		(
			await tools.get("mesh_send")?.execute("call-1", {
				intent: "fyi",
				text: "Joel says the reboot is done; carry on",
				re,
				endsHold: true,
			})
		)?.content[0]?.text ?? "";

	it("goes wherever the hold went, and waits on nothing", async () => {
		setSessionMode("mesh-end-hold", "redirect");
		const { tools } = await startSession();
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });

		const said = await ending(tools, hold.id);

		expect(sentOut()).toMatchObject([
			{ re: hold.id, endsHold: true, to: [ALL] },
		]);
		expect(said).toContain("ends [");
		expect(said).not.toContain("waits on");
		expect(ownBoard()).toEqual([]);
	});

	it("is not sent where nobody can confirm it", async () => {
		const { tools } = await startSession();
		const hold = fromElsewhere({ intent: "hold", text: "rebooting" });

		const said = await ending(tools, hold.id);

		expect(said).toMatch(/^Not sent: /);
		expect(sentOut()).toEqual([]);
	});

	it("is left out where it answers no other peer's hold", async () => {
		const { tools } = await startSession();
		const question = fromElsewhere({ intent: "question", text: "who?" });

		const said = await ending(tools, question.id);

		expect(sentOut()).toHaveLength(1);
		expect(sentOut()[0]?.endsHold).toBeUndefined();
		expect(said).toContain("is no other peer's hold");
	});
});
