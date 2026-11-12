import {
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
	mayBeGiven,
	putAsk,
	type SecretAsk,
	takeAsk,
} from "../../../lib/internal/secret-ask.ts";

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
