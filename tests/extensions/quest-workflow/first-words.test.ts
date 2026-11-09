import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sayFirstWords } from "../../../extensions/quest-workflow/lifecycle.ts";
import {
	FIRST_WORDS_VARIABLE,
	leaveFirstWords,
} from "../../../lib/internal/quest/first-words.ts";

let dir: string;
let said: { text: string; options: unknown }[];
let pi: ExtensionAPI;
let idle: boolean;
const ctx = { isIdle: () => idle } as unknown as ExtensionContext;
const settled = () => new Promise((done) => setImmediate(done));
/** Take the words as session_start does, and send them as start's end does. */
const sayAtStartsEnd = (
	sessionId: string,
	pending = () => false,
): (() => void) | undefined => {
	const send = sayFirstWords(pi, ctx, sessionId, pending, dir);
	send?.();
	return send;
};
/** The record a session leaves of taking the words under `key`. */
const takenRecord = (key: string): unknown =>
	JSON.parse(readFileSync(join(dir, `${key}.taken`), "utf8"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "first-words-start-"));
	said = [];
	idle = true;
	pi = {
		sendUserMessage: (text: string, options?: unknown) => {
			said.push({ text, options });
		},
	} as unknown as ExtensionAPI;
	delete process.env[FIRST_WORDS_VARIABLE];
});
afterEach(() => {
	delete process.env[FIRST_WORDS_VARIABLE];
	rmSync(dir, { recursive: true, force: true });
});

describe("a session a spawn started", () => {
	it("sets to work by itself, with the words the spawn left for it", async () => {
		leaveFirstWords("019a-spawned", "carry on with QEST-1", dir);
		sayAtStartsEnd("019a-spawned");
		expect(said).toEqual([
			{ text: "carry on with QEST-1", options: undefined },
		]);
		// Only the record that it took them, for its spawner to look at.
		expect(readdirSync(dir)).toEqual(["019a-spawned.taken"]);
		expect(takenRecord("019a-spawned")).toMatchObject({
			sessionId: "019a-spawned",
			said: true,
		});
	});

	it("takes the words its environment names, once", async () => {
		leaveFirstWords("token-1", "carry on", dir);
		process.env[FIRST_WORDS_VARIABLE] = "token-1";
		sayAtStartsEnd("019a-other");
		expect(sayAtStartsEnd("019a-other")).toBeUndefined();
		expect(said.map((one) => one.text)).toEqual(["carry on"]);
		expect(process.env[FIRST_WORDS_VARIABLE]).toBeUndefined();
	});

	it("says nothing more when its command line gave pi a first prompt", async () => {
		leaveFirstWords("019a-told", "carry on", dir);
		expect(sayAtStartsEnd("019a-told", () => true)).toBeUndefined();
		expect(said).toEqual([]);
		expect(readdirSync(dir)).toEqual(["019a-told.taken"]);
		expect(takenRecord("019a-told")).toMatchObject({ said: false });
	});

	it("follows a run already under way rather than cutting into it", async () => {
		idle = false;
		leaveFirstWords("019a-busy", "carry on", dir);
		sayAtStartsEnd("019a-busy");
		expect(said).toEqual([
			{ text: "carry on", options: { deliverAs: "followUp" } },
		]);
	});

	it("says nothing when no spawn left it words", async () => {
		expect(sayAtStartsEnd("019a-plain")).toBeUndefined();
		expect(said).toEqual([]);
	});

	// pi awaits each extension's session_start in turn; words sent on the
	// loop's next turn went out while later handlers still settled the
	// tool set, which was then declared a second time after turn one.
	it("says nothing by itself while start is still under way", async () => {
		leaveFirstWords("019a-early", "carry on", dir);
		const send = sayFirstWords(pi, ctx, "019a-early", () => false, dir);
		await settled();
		await new Promise((done) => setTimeout(done, 5));
		expect(said).toEqual([]);
		send?.();
		expect(said.map((one) => one.text)).toEqual(["carry on"]);
	});
});
