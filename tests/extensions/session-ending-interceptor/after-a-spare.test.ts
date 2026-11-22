/**
 * Once a spare let an ask past the sessions it would end, what follows
 * in the same run is read beside it: a later reply or call naming a
 * command off the plain list is held until the person speaks, answers
 * the spared ask, or the run ends.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sessionEndingInterceptor } from "../../../extensions/session-ending-interceptor/index.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import { setSessionMode } from "../../../lib/guardian/policy.ts";
import { PERSON_TALKED } from "../../../lib/internal/priority/typed.ts";
import type { NodeSession } from "../../../lib/mesh/node.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

const SELF = "self-session";
const GUARD = "no-session-ending-ask-while-live";

const ctx = { sessionManager: { getSessionId: () => SELF } };

const me: NodeSession = {
	id: SELF,
	address: "0IM95G",
	machine: "optimus",
	state: "busy",
};

/** A hosted session, idle and parked, which a reboot spares. */
const parked: NodeSession = {
	id: "hosted",
	address: "H00001",
	machine: "optimus",
	state: "idle",
	host: "work-background",
};

/** A command a spare can't stand beside, said after one stood. */
const RESCUE = "Done. If it hangs, run `sudo systemctl isolate rescue.target`.";

let pi: FakePi;

/** The interceptor over a machine where `node` holds these sessions. */
function interceptorOver(node: readonly NodeSession[] = [parked, me]): void {
	pi = fakePi();
	sessionEndingInterceptor({
		onMesh: () => true,
		sessions: async () => node,
		machines: async () => undefined,
		here: () => "optimus",
		spares: async () => ({ lingers: false, parked: new Set(["hosted"]) }),
	})(pi);
}

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const reply = (said: string) =>
	handler("message_end")(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: said }],
				stopReason: "stop",
			},
		},
		ctx,
	);

/** A call to `toolName` with `input`, as `id`. */
const call = (toolName: string, input: Record<string, unknown>, id: string) =>
	handler("tool_call")(
		{ type: "tool_call", toolName, toolCallId: id, input },
		ctx,
	);

const look = (ask: string, id = "c1", why?: string) =>
	call(
		"show_person",
		{
			kind: "page",
			target: "https://example.org/bios",
			title: "BIOS 1.13.0",
			ask,
			...(why === undefined ? {} : { why }),
		},
		id,
	);

const askPerson = (prompt: string, id: string) =>
	call(
		"ask",
		{
			questions: [
				{
					id: "q",
					prompt,
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "later", label: "Later" },
					],
				},
			],
		},
		id,
	);

/** The result of call `id` to `toolName`, with `details`. */
const resultOf = (toolName: string, id: string, details: unknown) =>
	handler("tool_result")(
		{
			type: "tool_result",
			toolName,
			toolCallId: id,
			input: {},
			content: [{ type: "text", text: "answered" }],
			isError: false,
			details,
		},
		ctx,
	);

/** A wait on the person, as `id`, with `extra` beside its title. */
const wait = (extra: Record<string, unknown>, id: string) =>
	call(
		"mesh_wait",
		{ title: "Install the BIOS", machine: "optimus", ...extra },
		id,
	);

/** The person's own input, typed or through the host, then its message. */
const personSays = async (said: string, source: string) => {
	await handler("input")({ type: "input", text: said, source }, ctx);
	return handler("message_end")(
		{
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: said }] },
		},
		ctx,
	);
};

const traces = () =>
	pi.recorded.entries
		.filter((entry) => entry.customType === "session-ending-spare")
		.map((entry) => entry.data);

/** The text a withheld reply now holds in its place. */
const textOf = (withheld: unknown) =>
	JSON.stringify((withheld as { message?: { content?: unknown } })?.message);

beforeEach(() => {
	setSessionMode(GUARD, "block");
	forgetRedirects();
});

describe("what follows a spare in the same run", () => {
	it("withholds a later reply that shows a command off the plain list", async () => {
		interceptorOver();

		expect(await look("Reboot optimus to install it")).toBeUndefined();
		const withheld = await reply(RESCUE);

		expect(withheld, "the later reply is withheld").toBeDefined();
		expect(textOf(withheld)).toMatch(/named a command after an ask/);
		expect(traces()).toMatchObject([
			{ outcome: "spared" },
			{
				outcome: "after a spare",
				shown: "sudo systemctl isolate rescue.target",
			},
		]);
	});

	it("withholds a later reply that names a next root in prose", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");

		expect(
			await reply("Copy the tree into /run/nextroot first."),
			"the later reply is withheld",
		).toBeDefined();
	});

	it("says why the model's reply was withheld", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");
		await reply(RESCUE);

		expect(pi.recorded.sent).toMatchObject([
			{
				content: expect.stringMatching(
					/let through earlier in this run.*\("sudo systemctl isolate rescue\.target"\).*without the command/s,
				),
			},
		]);
	});

	it.each([
		"Done; the notes are in `notes.md`.",
		"The reboot is queued for when you say.",
		"It runs `sudo reboot` once you say.",
		"The skills are loaded, and the stuck test was killed.",
		"See `~/.pi/skills/README.md`; sshd is up.",
	])("lets a later reply through that names no command: %s", async (said) => {
		interceptorOver();

		await look("Reboot optimus to install it");

		expect(await reply(said)).toBeUndefined();
	});

	it("refuses a later call whose words name a command", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");
		const verdict = await look(
			"Say when the BIOS screen shows",
			"c2",
			"If it hangs, `sudo kexec -e` brings it back.",
		);

		expect(verdict).toMatchObject({
			block: true,
			reason: expect.stringMatching(
				/let through earlier in this run.*\("sudo kexec -e"\)/,
			),
		});
	});

	it("refuses a later wait whose check names a command, which runs as the person", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");
		const verdict = await wait(
			{ why: "To see it came up", readyWhen: { check: "pkill -u joel node" } },
			"w2",
		);

		expect(verdict).toMatchObject({
			block: true,
			reason: expect.stringMatching(
				/let through earlier in this run.*\("pkill -u joel node"\)/,
			),
		});
	});

	it("starts from a spared wait, without holding its own check against it", async () => {
		interceptorOver();

		expect(
			await wait(
				{
					why: "The BIOS installs as it starts",
					doneWhen: { signal: "boot", check: "systemctl is-system-running" },
				},
				"w1",
			),
			"the wait is spared",
		).toBeUndefined();
		expect(await reply(RESCUE), "the later reply is withheld").toBeDefined();
	});

	it("starts from a spared reply", async () => {
		interceptorOver();

		expect(
			await reply("Please reboot optimus to install the BIOS."),
			"the reply is spared",
		).toBeUndefined();
		expect(await reply(RESCUE), "the later reply is withheld").toBeDefined();
	});

	it("tells the model, under redirect, to say the command again to override", async () => {
		setSessionMode(GUARD, "redirect");
		interceptorOver();

		await look("Reboot optimus to install it");
		await reply(RESCUE);
		const said = JSON.stringify(pi.recorded.sent);

		expect(said).toContain("say it again");
		expect(said).not.toContain("ask it again");
		expect(await reply(RESCUE), "said again, it goes").toBeUndefined();
	});

	it("carries no other command through an override, under redirect", async () => {
		setSessionMode(GUARD, "redirect");
		interceptorOver();

		await look("Reboot optimus to install it");
		await reply(RESCUE);

		expect(
			await reply(`${RESCUE} Or \`sudo kexec -e\`.`),
			"a command beside the one told of is withheld",
		).toBeDefined();
	});

	it("holds nothing where the ask before was refused, not spared", async () => {
		interceptorOver([{ ...parked, state: "busy" }, me]);

		expect(await look("Reboot optimus to install it")).toMatchObject({
			block: true,
		});
		expect(await reply(RESCUE)).toBeUndefined();
	});

	it("holds nothing where no spare stood", async () => {
		interceptorOver();

		expect(await reply(RESCUE)).toBeUndefined();
	});
});

describe("when what followed a spare is free again", () => {
	it.each(["interactive", "rpc"])(
		"once the person speaks (%s)",
		async (source) => {
			interceptorOver();

			await look("Reboot optimus to install it");
			await personSays("Done, it's back.", source);

			expect(await reply(RESCUE)).toBeUndefined();
		},
	);

	it("once the person talks from the launcher", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");
		pi.events.emit(PERSON_TALKED, { intoRun: true });

		expect(await reply(RESCUE)).toBeUndefined();
	});

	it("not for a message an extension sends", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");
		await personSays("Job j7 finished.", "extension");

		expect(await reply(RESCUE), "still withheld").toBeDefined();
	});

	it("once the run settles", async () => {
		interceptorOver();

		await look("Reboot optimus to install it");
		await handler("agent_settled")({ type: "agent_settled" }, ctx);

		expect(await reply(RESCUE)).toBeUndefined();
	});

	it("once the person answers the spared ask", async () => {
		interceptorOver();

		expect(
			await askPerson("Reboot optimus now to install the BIOS?", "a1"),
		).toBeUndefined();
		await resultOf("ask", "a1", {
			questions: [],
			answers: [{ id: "q", value: "yes", label: "Yes" }],
			cancelled: false,
		});

		expect(await reply(RESCUE)).toBeUndefined();
	});

	it.each([
		["answered by the recommendation while away", { answers: [] }],
		["cancelled", { answers: [{ id: "q", label: "Yes" }], cancelled: true }],
		[
			"parked unanswered",
			{ answers: [{ id: "q", label: "Yes" }], parked: "locked" },
		],
	])("not for a spared ask %s", async (_how, details) => {
		interceptorOver();

		await askPerson("Reboot optimus now to install the BIOS?", "a1");
		await resultOf("ask", "a1", {
			questions: [],
			cancelled: false,
			...details,
		});

		expect(await reply(RESCUE), "still withheld").toBeDefined();
	});

	it("not for another ask's answer", async () => {
		interceptorOver();

		await askPerson("Reboot optimus now to install the BIOS?", "a1");
		await resultOf("ask", "a2", {
			answers: [{ id: "q", label: "Yes" }],
			cancelled: false,
		});

		expect(await reply(RESCUE), "still withheld").toBeDefined();
	});

	it("not for another tool's result, even under the ask's id", async () => {
		interceptorOver();

		await askPerson("Reboot optimus now to install the BIOS?", "a1");
		await resultOf("show_person", "a1", {
			answers: [{ id: "q", label: "Yes" }],
			cancelled: false,
		});

		expect(await reply(RESCUE), "still withheld").toBeDefined();
	});

	it("not while another spare still stands", async () => {
		interceptorOver();

		await look("Reboot optimus to install it", "c1");
		await askPerson("Reboot optimus now to install the BIOS?", "a1");
		await resultOf("ask", "a1", {
			answers: [{ id: "q", label: "Yes" }],
			cancelled: false,
		});

		expect(await reply(RESCUE), "the look's spare still stands").toBeDefined();
	});
});
