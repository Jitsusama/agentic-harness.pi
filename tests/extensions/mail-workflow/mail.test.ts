/**
 * Mail reaches a session as context it takes under advisement, never
 * as a prompt that stops what it is doing.
 *
 * The interim mailbox delivered each message with a turn: a busy
 * session took it up as a new task at the moment it would have
 * finished, an idle one started a turn about it, and both answered mail
 * that needed no answer. What pins that here is the delivery options
 * pi is handed, since pi's own rules decide the rest: without a turn, a
 * message sent mid-run is appended once the current step's tool results
 * are in, and one sent while idle is appended with no turn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ADVISORY,
	ASKS,
	MAIL_MESSAGE,
	type MailPaths,
	mailWorkflow,
} from "../../../extensions/mail-workflow/index.ts";
import { createMemberships } from "../../../lib/mail/channels.ts";
import { createMailbox, type Mail } from "../../../lib/mail/mailbox.ts";

const session = "01a15f3a-2255-7463-9909-afa624b025fe";
let root: string;
let paths: MailPaths;
let stops: (() => Promise<void>)[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mail-workflow-"));
	paths = {
		box: join(root, "box"),
		sessions: join(root, "sessions"),
		quests: join(root, "quests"),
	};
	mkdirSync(paths.sessions, { recursive: true });
	writeFileSync(
		join(paths.sessions, `${session}.json`),
		JSON.stringify({ quest: "QEST-20261021-7M6JKG" }),
		"utf8",
	);
	stops = [];
});

afterEach(async () => {
	for (const stop of stops) await stop();
	rmSync(root, { recursive: true, force: true });
});

type Sent = {
	message: { customType: string; content: string; display?: boolean };
	options: unknown;
};

/** Start a session on the extension, with just enough of pi to run it. */
async function startSession() {
	const sent: Sent[] = [];
	const lifecycle = new Map<
		string,
		(event: unknown, ctx: unknown) => unknown
	>();
	const tools = new Map<
		string,
		{
			execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
		}
	>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			lifecycle.set(event, handler),
		registerTool: (tool: { name: string }) =>
			tools.set(tool.name, tool as never),
		sendMessage: (message: Sent["message"], options?: unknown) =>
			sent.push({ message, options }),
	};
	mailWorkflow(paths)(pi as never);
	await lifecycle.get("session_start")?.(
		{ reason: "startup" },
		{ hasUI: false, sessionManager: { getSessionId: () => session } },
	);
	stops.push(async () => {
		await lifecycle.get("session_shutdown")?.({}, {});
	});
	return { sent, tools };
}

/** Mail from another session, written the way it writes it. */
function fromElsewhere(over: Partial<Mail> = {}): string {
	return createMailbox(paths.box).send({
		at: new Date().toISOString(),
		from: "WCJQSG",
		to: ["ALL"],
		text: "hold heavy builds until I say done",
		pid: process.pid + 1,
		...over,
	});
}

describe("mail as context", () => {
	it("puts mail in without starting or extending a turn", async () => {
		const { sent } = await startSession();

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message).toMatchObject({
			customType: MAIL_MESSAGE,
			display: true,
		});
	});

	it("tells the model it is for awareness, not a task", async () => {
		// Said with the mail, because the note in front of a model is what
		// it takes as its next instruction.
		const { sent } = await startSession();

		fromElsewhere();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const content = sent[0]?.message.content ?? "";
		expect(content).toContain("Mail (fyi) from WCJQSG to ALL");
		expect(content).toContain("hold heavy builds until I say done");
		expect(content.endsWith(ADVISORY)).toBe(true);
		expect(content).not.toMatch(/Answer, if it needs one/);
	});

	it("catches up on mail that arrived before it started, once, without a turn", async () => {
		// Starting with mail waiting used to ask pi for a second turn while
		// the first prompt was about to run, which pi refuses.
		fromElsewhere({ text: "one" });
		await new Promise((wake) => setTimeout(wake, 2));
		fromElsewhere({ text: "two" });

		const first = await startSession();
		expect(first.sent).toHaveLength(1);
		expect(first.sent[0]?.options).toEqual({ triggerTurn: false });
		expect(first.sent[0]?.message.content).toMatch(/one[\s\S]*two/);

		// A reload is a fresh start that has read them already.
		const again = await startSession();
		expect(again.sent).toEqual([]);
	});

	it("hands over nothing meant for someone else, and none of its own", async () => {
		const { sent, tools } = await startSession();

		fromElsewhere({ to: ["OVAE1I"], text: "not for you" });
		await tools
			.get("mail_send")
			?.execute("call-1", { to: "all", kind: "fyi", text: "from me" });
		fromElsewhere({ to: ["7M6JKG"], text: "for you" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("for you");
		expect(sent[0]?.message.content).not.toContain("not for you");
	});
});

describe("sending mail", () => {
	it("signs with the quest the session has loaded", async () => {
		const { tools } = await startSession();

		const answer = await tools
			.get("mail_send")
			?.execute("call-1", { to: "p9r1ki, all", kind: "fyi", text: "hello" });

		expect(answer?.content[0]?.text).toContain("Sent as 7M6JKG");
		const box = createMailbox(paths.box);
		const [file] = box.list();
		expect(file && box.read(file)).toMatchObject({
			from: "7M6JKG",
			to: ["P9R1KI", "ALL"],
			text: "hello",
			kind: "fyi",
			pid: process.pid,
		});
	});

	it("says who it reaches, and which names nobody answers to", async () => {
		// A typo used to send mail nowhere without a word.
		other("session-p", ["P9R1KI"], []);
		const { tools } = await startSession();

		const answer = await send(tools, "p9r1ki, p9rlki", "question", "ready?");

		expect(answer).toContain("It reaches P9R1KI.");
		expect(answer).toContain("No session here goes by P9RLKI");
	});

	it("refuses a channel nobody else is on, and sends nothing", async () => {
		const { tools } = await startSession();

		const answer = await send(tools, "#skynet", "fyi", "site is up");

		expect(answer).toContain("Not sent: no other session is on #skynet");
		expect(createMailbox(paths.box).list()).toEqual([]);
	});
});

describe("what each kind asks", () => {
	it("says only what the kinds delivered ask", async () => {
		// So a reader knows whether to answer, to note, or only to know,
		// without guidance about kinds that are not in front of it.
		const { sent } = await startSession();

		fromElsewhere({ kind: "hold", text: "hold heavy builds" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const content = sent[0]?.message.content ?? "";
		expect(content).toContain("Mail (hold) from WCJQSG");
		expect(content).toContain(ASKS.hold);
		expect(content).not.toContain(ASKS.question);
		expect(content).not.toContain(ASKS.fyi);
	});

	it("reads mail with no kind, or one it does not know, as an fyi", async () => {
		const { sent } = await startSession();

		fromElsewhere({ kind: "gossip" as never });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain(ASKS.fyi);
	});
});

describe("channels", () => {
	it("hears a channel it joined, and its parents, and no other", async () => {
		const { sent, tools } = await startSession();
		await tools
			.get("mail_join")
			?.execute("call-1", { channel: "#optimus/power" });

		fromElsewhere({ to: ["#skynet"], text: "not yours" });
		fromElsewhere({ to: ["#optimus"], text: "the parent" });
		fromElsewhere({ to: ["#optimus/power"], text: "the channel" });

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		const all = sent.map((one) => one.message.content).join("\n");
		expect(all).toContain("the parent");
		expect(all).toContain("the channel");
		expect(all).not.toContain("not yours");
	});

	it("keeps what it joined across a reload", async () => {
		const first = await startSession();
		await first.tools
			.get("mail_join")
			?.execute("call-1", { channel: "harness" });

		const again = await startSession();
		fromElsewhere({ to: ["#harness"], text: "for the harness" });

		await vi.waitFor(() =>
			expect(
				again.sent.some((one) =>
					one.message.content.includes("for the harness"),
				),
			).toBe(true),
		);
	});

	it("stops hearing a channel it left", async () => {
		const { sent, tools } = await startSession();
		await tools.get("mail_join")?.execute("call-1", { channel: "harness" });
		await tools.get("mail_leave")?.execute("call-2", { channel: "#harness" });

		fromElsewhere({ to: ["#harness"], text: "gone" });
		fromElsewhere({ to: ["7M6JKG"], text: "still here" });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.message.content).toContain("still here");
	});

	it("lists the channels and who is on them", async () => {
		other("session-p", ["P9R1KI"], ["optimus/power"]);
		const { tools } = await startSession();
		await tools.get("mail_join")?.execute("call-1", { channel: "harness" });

		const listed = await tools.get("mail_channels")?.execute("call-2", {});

		const text = listed?.content[0]?.text ?? "";
		expect(text).toContain("This session is on #harness, and global.");
		expect(text).toContain("#harness: 7M6JKG");
		expect(text).toContain("#optimus/power: P9R1KI");
	});

	it("refuses a name that is not a channel", async () => {
		const { tools } = await startSession();

		const answer = await tools
			.get("mail_join")
			?.execute("call-1", { channel: "#Not A Channel" });

		expect(answer?.content[0]?.text).toContain("is not a channel name");
	});

	it("reads back only the mail this session hears", async () => {
		const { tools } = await startSession();
		fromElsewhere({ to: ["OVAE1I"], text: "someone else's" });
		fromElsewhere({ text: "everyone's" });

		const read = await tools.get("mail_read")?.execute("call-1", {});

		const text = read?.content[0]?.text ?? "";
		expect(text).toContain("everyone's");
		expect(text).not.toContain("someone else's");
	});
});

/** Another session's place in the networks, as it would have kept it. */
function other(session: string, names: string[], channels: string[]) {
	createMemberships(join(paths.box, ".members")).keep({
		session,
		names,
		channels,
	});
}

/** Send through the tool, and hand back what it answered. */
async function send(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	to: string,
	kind: string,
	text: string,
): Promise<string> {
	const answer = await tools
		.get("mail_send")
		?.execute("call-1", { to, kind, text });
	return answer?.content[0]?.text ?? "";
}
