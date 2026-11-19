import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerOf,
	askRoute,
	asksAnswered,
	mayBeGiven,
	putAsk,
	type RouteReads,
	type SecretAsk,
	takeAsk,
	withSecretNote,
} from "../../../../lib/internal/secrets/secret-ask.ts";

let dir: string;
let asks: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secret-ask-"));
	asks = join(dir, "secret-asks");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const ask: SecretAsk = {
	session: "S1",
	quest: { id: "Q-1", title: "Try the line" },
	item: "op://Private/Release Test/password",
	why: "To try the line.",
	argv: ["secret-asks", "received"],
	tree: "/tmp/tree",
	given: "RELEASED",
	minutes: 1,
};

describe("an ask for a secret", () => {
	it("is written as the daemon's version 1 reads it", () => {
		const { id, file } = putAsk(asks, ask, () => 1_000);

		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(file).toBe(join(asks, `${id}.ask.json`));
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			version: 1,
			id,
			asked_ms: 1_000,
			session: "S1",
			quest: { id: "Q-1", title: "Try the line" },
			item: "op://Private/Release Test/password",
			why: "To try the line.",
			argv: ["secret-asks", "received"],
			tree: "/tmp/tree",
			given: "RELEASED",
			minutes: 1,
		});
	});

	it("says no quest as null", () => {
		const { file } = putAsk(asks, { ...ask, quest: undefined });

		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			quest: null,
		});
	});

	it("keeps its folder to Joel alone", () => {
		putAsk(asks, ask);

		expect((statSync(asks).mode & 0o777).toString(8)).toBe("700");
	});

	it("gets an id of its own each time", () => {
		const first = putAsk(asks, ask).id;
		const second = putAsk(asks, ask).id;

		expect(second).not.toBe(first);
	});

	it("is refused before it's written when the daemon would refuse it", () => {
		const refused: [Partial<SecretAsk>, RegExp][] = [
			[{ given: "PATH" }, /can't carry/],
			[{ given: "LD_PRELOAD" }, /can't carry/],
			[{ item: "Release Test" }, /op:\/\//],
			[{ argv: [] }, /command/],
			[{ minutes: 0 }, /1 to 30/],
			[{ minutes: 31 }, /1 to 30/],
			[{ why: "two\nlines" }, /one line/],
			[{ why: "x".repeat(201) }, /200/],
		];
		for (const [change, why] of refused) {
			expect(
				() => putAsk(asks, { ...ask, ...change }),
				JSON.stringify(change),
			).toThrow(why);
		}
		expect(readdirSync(dir)).toEqual([]);
	});

	it("is taken back whole, its answer with it", () => {
		const { id, file } = putAsk(asks, ask);
		writeFileSync(join(asks, `${id}.answer.json`), "{}");

		takeAsk(asks, id);

		expect(readdirSync(asks).filter((name) => name.startsWith(id))).toEqual([]);
		expect(() => statSync(file)).toThrow();
	});
});

describe("an ask's answer", () => {
	it("is nothing until the daemon writes it", () => {
		const { id } = putAsk(asks, ask);

		expect(answerOf(asks, id)).toBeUndefined();
	});

	it("says only its state, exit, why and output", () => {
		const { id } = putAsk(asks, ask);
		writeFileSync(
			join(asks, `${id}.answer.json`),
			JSON.stringify({
				version: 1,
				id,
				state: "ran",
				exit: 0,
				output: "RELEASED 12",
				cut: false,
				why: "",
				extra: "left out",
			}),
		);

		expect(answerOf(asks, id)).toEqual({
			state: "ran",
			exit: 0,
			output: "RELEASED 12",
			cut: false,
			why: "",
		});
	});

	it("says a refusal's why", () => {
		const { id } = putAsk(asks, ask);
		writeFileSync(
			join(asks, `${id}.answer.json`),
			JSON.stringify({
				version: 1,
				id,
				state: "refused",
				why: "refused by Joel",
			}),
		);

		expect(answerOf(asks, id)).toEqual({
			state: "refused",
			why: "refused by Joel",
		});
	});

	it("is no answer when it's another ask's", () => {
		const { id } = putAsk(asks, ask);
		writeFileSync(
			join(asks, `${id}.answer.json`),
			JSON.stringify({ version: 1, id: "0".repeat(32), state: "ran" }),
		);

		expect(answerOf(asks, id)).toBeUndefined();
	});
});

describe("a variable's name", () => {
	it("carries a value only when no command's start reads it", () => {
		for (const name of ["PATH", "HOME", "LANG", "BASH_ENV", "ENV", "SHELL"]) {
			expect(mayBeGiven(name), name).toBe(false);
		}
		for (const name of [
			"LD_PRELOAD",
			"lower",
			"1ST",
			"A-B",
			"",
			"A".repeat(65),
		]) {
			expect(mayBeGiven(name), JSON.stringify(name)).toBe(false);
		}
		expect(mayBeGiven("PACKAGE_TOKEN"), "a plain name").toBe(true);
		expect(mayBeGiven("_X1"), "an underscore first").toBe(true);
	});
});

describe("askRoute", () => {
	const runtimeDir = "/run/user/1000";
	const socket = "/run/user/1000/daemons/secret-asks.sock";
	const sign = "/run/user/1000/secret-asks/answering";

	/** A machine with only these files, and only these pids running. */
	function machine(
		files: Readonly<Record<string, string>>,
		running: readonly number[] = [],
	): RouteReads {
		return {
			exists: (path) => path in files,
			read: (path) => files[path],
			alive: (pid) => running.includes(pid),
		};
	}

	it("files in the runtime folder's asks from a fenced session where the daemon runs", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [socket]: "" }),
		);
		expect(route).toEqual({ folder: "/run/user/1000/secret-asks" });
	});

	it("files there where the passwords daemon's sign names a running pid", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [sign]: "4242\n" }, [4242]),
		);
		expect(route).toEqual({ folder: "/run/user/1000/secret-asks" });
	});

	it("refuses where the sign was left by a daemon that runs no more", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir },
			machine({ [sign]: "4242\n" }, [17]),
		);
		expect("refused" in route && route.refused).toMatch(
			/neither does on this machine/,
		);
	});

	it("refuses a sign that holds no pid", () => {
		for (const text of ["", "0\n", "-1\n", "4242 4243\n", "pid\n"]) {
			const route = askRoute(
				{ fenced: true, runtimeDir },
				machine({ [sign]: text }, [0, -1, 4242]),
			);
			expect("refused" in route, JSON.stringify(text)).toBe(true);
		}
	});

	it("refuses a session whose commands run outside the fence", () => {
		const route = askRoute(
			{ fenced: false, runtimeDir },
			machine({ [socket]: "" }),
		);
		expect("refused" in route && route.refused).toMatch(
			/outside the agent fence/,
		);
	});

	it("refuses where nothing answers asks", () => {
		const route = askRoute({ fenced: true, runtimeDir }, machine({}));
		expect("refused" in route && route.refused).toMatch(
			/neither does on this machine/,
		);
	});

	it("refuses with no runtime folder", () => {
		const route = askRoute(
			{ fenced: true, runtimeDir: undefined },
			machine({ [socket]: "" }),
		);
		expect("refused" in route, "no folder to file in").toBe(true);
	});
});

describe("asksAnswered", () => {
	it("reads a running process's pid as running", () => {
		const runtime = mkdtempSync(join(tmpdir(), "answered-"));
		try {
			const folder = join(runtime, "secret-asks");
			mkdirSync(folder);
			writeFileSync(join(folder, "answering"), `${process.pid}\n`);
			expect(asksAnswered(runtime)).toBe(true);
		} finally {
			rmSync(runtime, { recursive: true, force: true });
		}
	});

	it("reads no sign as nothing answering", () => {
		const runtime = mkdtempSync(join(tmpdir(), "answered-"));
		try {
			expect(asksAnswered(runtime)).toBe(false);
		} finally {
			rmSync(runtime, { recursive: true, force: true });
		}
	});
});

describe("withSecretNote", () => {
	it("tells a command naming secret-asks of secret_run, then runs it", () => {
		const said = withSecretNote("secret-asks ask --item x");
		expect(said).toMatch(/^printf '%s\\n' .*secret_run.* >&2\n/);
		expect(
			said.endsWith("\nsecret-asks ask --item x"),
			"the command runs after",
		).toBe(true);
	});

	it("leaves a command alone that only names something like it", () => {
		for (const command of [
			"ls my-secret-asks",
			"cat secret-asks.md",
			"echo hi",
		]) {
			expect(withSecretNote(command), command).toBe(command);
		}
	});

	it("notes the program wherever it stands in a line", () => {
		expect(
			withSecretNote("x && secret-asks list"),
			"after another command",
		).toMatch(/secret_run/);
		expect(withSecretNote("$(secret-asks)"), "in a substitution").toMatch(
			/secret_run/,
		);
	});
});
