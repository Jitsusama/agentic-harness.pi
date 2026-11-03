import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sayFirstWords } from "../../../extensions/quest-workflow/lifecycle";
import {
	FIRST_WORDS_VARIABLE,
	leaveFirstWords,
} from "../../../lib/internal/quest/first-words";

let dir: string;
let said: { text: string; options: unknown }[];
let pi: ExtensionAPI;
let idle: boolean;
const ctx = { isIdle: () => idle } as unknown as ExtensionContext;
const settled = () => new Promise((done) => setImmediate(done));

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
		sayFirstWords(pi, ctx, "019a-spawned", () => false, dir);
		await settled();
		expect(said).toEqual([
			{ text: "carry on with QEST-1", options: undefined },
		]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("takes the words its environment names, once", async () => {
		leaveFirstWords("token-1", "carry on", dir);
		process.env[FIRST_WORDS_VARIABLE] = "token-1";
		sayFirstWords(pi, ctx, "019a-other", () => false, dir);
		sayFirstWords(pi, ctx, "019a-other", () => false, dir);
		await settled();
		expect(said.map((one) => one.text)).toEqual(["carry on"]);
		expect(process.env[FIRST_WORDS_VARIABLE]).toBeUndefined();
	});

	it("says nothing more when its command line gave pi a first prompt", async () => {
		leaveFirstWords("019a-told", "carry on", dir);
		sayFirstWords(pi, ctx, "019a-told", () => true, dir);
		await settled();
		expect(said).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("follows a run already under way rather than cutting into it", async () => {
		idle = false;
		leaveFirstWords("019a-busy", "carry on", dir);
		sayFirstWords(pi, ctx, "019a-busy", () => false, dir);
		await settled();
		expect(said).toEqual([
			{ text: "carry on", options: { deliverAs: "followUp" } },
		]);
	});

	it("says nothing when no spawn left it words", async () => {
		sayFirstWords(pi, ctx, "019a-plain", () => false, dir);
		await settled();
		expect(said).toEqual([]);
	});
});
