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
	MAIL_MESSAGE,
	type MailPaths,
	mailWorkflow,
} from "../../../extensions/mail-workflow/index.ts";
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
		expect(content).toContain("Mail from WCJQSG to ALL");
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
			?.execute("call-1", { to: "all", text: "from me" });
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
			?.execute("call-1", { to: "p9r1ki, all", text: "hello" });

		expect(answer?.content[0]?.text).toContain("Sent as 7M6JKG");
		const box = createMailbox(paths.box);
		const [file] = box.list();
		expect(file && box.read(file)).toMatchObject({
			from: "7M6JKG",
			to: ["P9R1KI", "ALL"],
			text: "hello",
			pid: process.pid,
		});
	});
});
