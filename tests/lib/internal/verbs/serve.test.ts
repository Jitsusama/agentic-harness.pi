import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SECRET_REFUSED,
	type VerbServer,
	verbServer,
} from "../../../../lib/internal/verbs/serve.ts";

const TOKEN = "[secret scrubbed: GitHub token]";
const AT = new Date("2026-11-12T13:00:00Z");

const EXPLAIN = "---\nwords: Explain\nresult: say\n---\nExplain it plainly.\n";
const HAND = `---
words: Hand to an agent
result: hand
disruptive: true
prompt: "{{note}}\\n\\n{{selection}}"
args:
  - name: note
    words: What to ask
---
`;

/** A client holding one connection, reading its answers in turn. */
interface Client {
	send(line: unknown): void;
	sendRaw(text: string): void;
	next(): Promise<Record<string, unknown>>;
	close(): void;
}

function client(path: string): Promise<Client> {
	return new Promise((resolve, reject) => {
		const socket: Socket = connect(path);
		const lines: Record<string, unknown>[] = [];
		const waiting: ((line: Record<string, unknown>) => void)[] = [];
		let held = "";
		socket.on("data", (data) => {
			held += data.toString();
			let end = held.indexOf("\n");
			while (end >= 0) {
				const line = JSON.parse(held.slice(0, end));
				held = held.slice(end + 1);
				const wake = waiting.shift();
				if (wake) wake(line);
				else lines.push(line);
				end = held.indexOf("\n");
			}
		});
		socket.once("error", reject);
		socket.once("connect", () =>
			resolve({
				send: (line) => socket.write(`${JSON.stringify(line)}\n`),
				sendRaw: (text) => socket.write(text),
				next: () => {
					const line = lines.shift();
					if (line) return Promise.resolve(line);
					return new Promise((wake, fail) => {
						const timer = setTimeout(
							() => fail(new Error("no answer came within 3 s")),
							3000,
						);
						waiting.push((answer) => {
							clearTimeout(timer);
							wake(answer);
						});
					});
				},
				close: () => socket.destroy(),
			}),
		);
	});
}

describe("the verbs server", () => {
	let root = "";
	let folder = "";
	let uses = "";
	let server: VerbServer | undefined;
	let asker: Client | undefined;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "verbs-"));
		folder = join(root, "verbs");
		uses = join(root, "state", "uses.jsonl");
		mkdirSync(folder);
		writeFileSync(join(folder, "explain.md"), EXPLAIN);
		writeFileSync(join(folder, "hand.md"), HAND);
		server = verbServer({
			folders: [folder],
			uses,
			known: [{ name: "GITHUB_TOKEN", value: TOKEN }],
			now: () => AT,
			settleMs: 20,
			log: () => undefined,
		});
		const socket = join(root, "v.sock");
		await new Promise<void>((done) => server?.server.listen(socket, done));
		asker = await client(socket);
	});

	afterEach(async () => {
		asker?.close();
		await server?.stop();
		rmSync(root, { recursive: true, force: true });
	});

	function ask(line: unknown): Promise<Record<string, unknown>> {
		if (!asker) throw new Error("no client");
		asker.send(line);
		return asker.next();
	}

	it("tells a watch every verb, then only the verbs a file changed and the ones gone", async () => {
		const first = await ask({ id: 1, ask: "watch" });
		expect(first).toEqual({
			id: 1,
			changed: [
				{
					key: "verb:explain",
					kind: "verb",
					id: "explain",
					words: "Explain",
					says: "",
					result: "say",
					disruptive: false,
					args: [],
				},
				{
					key: "verb:hand",
					kind: "verb",
					id: "hand",
					words: "Hand to an agent",
					says: "",
					result: "hand",
					disruptive: true,
					args: [{ name: "note", words: "What to ask" }],
				},
			],
		});

		writeFileSync(
			join(folder, "explain.md"),
			EXPLAIN.replace("Explain\n", "Explain this\n"),
		);
		const changed = await asker?.next();
		expect(changed).toMatchObject({
			id: 1,
			changed: [{ key: "verb:explain", words: "Explain this" }],
		});
		expect(changed?.gone, "nothing went").toBeUndefined();

		unlinkSync(join(folder, "hand.md"));
		expect(await asker?.next()).toEqual({
			id: 1,
			changed: [],
			gone: ["verb:hand"],
		});
	});

	it("answers a verb with its system prompt and its filled prompt, and counts it as asked", async () => {
		const answer = await ask({
			id: 2,
			ask: "verb",
			verb: "explain",
			args: {},
			selection: "what is a cgroup",
		});
		expect(answer).toEqual({
			id: 2,
			ok: true,
			use: expect.any(String),
			system: "Explain it plainly.",
			prompt: "what is a cgroup",
		});
		expect(readFileSync(uses, "utf8")).toBe(
			`${JSON.stringify({ at: AT.toISOString(), use: answer.use, verb: "explain", outcome: "asked" })}\n`,
		);
	});

	it("answers a hand with the text to hand on alone", async () => {
		expect(
			await ask({
				id: 3,
				ask: "verb",
				verb: "hand",
				args: { note: "Fix this" },
				selection: "a stack trace",
			}),
		).toEqual({
			id: 3,
			ok: true,
			use: expect.any(String),
			text: "Fix this\n\na stack trace",
		});
	});

	it("refuses a selection holding a secret, and counts nothing", async () => {
		expect(
			await ask({
				id: 4,
				ask: "verb",
				verb: "explain",
				selection: `export GITHUB_TOKEN=${TOKEN}`,
			}),
		).toEqual({ id: 4, ok: false, refused: SECRET_REFUSED });
		expect(SECRET_REFUSED).toBe("this looks like a secret; not sent");
		expect(() => readFileSync(uses), "no use was counted").toThrow();
	});

	it("refuses an argument holding a secret", async () => {
		expect(
			await ask({
				id: 5,
				ask: "verb",
				verb: "hand",
				args: { note: TOKEN },
				selection: "x",
			}),
		).toEqual({ id: 5, ok: false, refused: SECRET_REFUSED });
	});

	it("counts what became of a use under its verb", async () => {
		const answer = await ask({
			id: 6,
			ask: "verb",
			verb: "explain",
			selection: "x",
		});
		expect(
			await ask({ id: 7, ask: "told", use: answer.use, outcome: "undone" }),
		).toEqual({
			id: 7,
			ok: true,
		});
		const lines = readFileSync(uses, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.at(-1)).toEqual({
			at: AT.toISOString(),
			use: answer.use,
			verb: "explain",
			outcome: "undone",
		});
	});

	it.each([
		[
			{ id: 8, ask: "told", use: "u", outcome: "loved" },
			"loved is not accepted, undone or dismissed",
		],
		[
			{ id: 8, ask: "verb", verb: "sing", selection: "x" },
			"there is no verb named sing",
		],
		[{ id: 8, ask: "verb", verb: "explain" }, "a verb is asked of a selection"],
		[
			{
				id: 8,
				ask: "verb",
				verb: "explain",
				selection: "x",
				args: { tone: "warm" },
			},
			"explain takes no argument named tone",
		],
		[{ id: 8, ask: "dance" }, "there is no ask named dance"],
	])("refuses %j", async (line, refused) => {
		expect(await ask(line)).toEqual({ id: 8, ok: false, refused });
	});

	it("refuses a line that isn't JSON, and goes on answering", async () => {
		asker?.sendRaw("not json\n");
		expect(await asker?.next()).toEqual({
			ok: false,
			refused: "that line is not JSON",
		});
		expect(
			await ask({ id: 9, ask: "dance" }),
			"the next line is answered",
		).toMatchObject({ id: 9 });
	});
});
