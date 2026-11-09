/**
 * A credential in a tool's answer is put out of sight before the model or
 * the session's log sees it, and ordinary output reads as it did.
 *
 * Every credential here is made as the test runs, from pieces, so the
 * repository never holds a string shaped like a live one.
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import secretScrubInterceptor from "../../extensions/secret-scrub-interceptor/index.ts";
import { savedOutputFile } from "../../extensions/secret-scrub-interceptor/output-file.ts";
import { scrubSecrets } from "../../lib/internal/secrets.ts";

const mixed = (length: number) =>
	"a1B2c3D4e5".repeat(Math.ceil(length / 10)).slice(0, length);
const upper = (length: number) =>
	"A1B2C3D4E5".repeat(Math.ceil(length / 10)).slice(0, length);
const hex = (length: number) => "0123456789abcdef".repeat(4).slice(0, length);

const credentials: [kind: string, value: string][] = [
	["GitHub token", `gh${"o"}_${mixed(36)}`],
	["GitHub token", `github${"_pat_"}${mixed(40)}`],
	["npm token", `npm${"_"}${mixed(36)}`],
	["Anthropic key", `sk-${"ant-"}api03-${mixed(40)}`],
	["OpenAI key", `sk-${"proj-"}${mixed(40)}`],
	["AWS access key", `AK${"IA"}${upper(16)}`],
	["Google refresh token", `1/${"/0"}${mixed(40)}`],
	["Google access token", `ya${"29."}${mixed(40)}`],
	["Google API key", `AI${"za"}${mixed(35)}`],
	["Slack token", `xo${"xb"}-${mixed(30)}`],
	["Shopify token", `shp${"at_"}${hex(32)}`],
	["age identity", `AGE-SECRET${"-KEY-1"}${upper(58)}`],
	["JSON web token", `ey${"J"}${mixed(20)}.ey${"J"}${mixed(20)}.${mixed(20)}`],
];

describe("a credential printed on its own", () => {
	for (const [kind, value] of credentials) {
		it(`is scrubbed and named as a ${kind}`, () => {
			const { text, kinds } = scrubSecrets(`before ${value} after`);
			expect(text).toBe(`before [secret scrubbed: ${kind}] after`);
			expect(kinds).toEqual([kind]);
		});
	}

	it("takes a private key whole, from its first line to its last", () => {
		const key = [
			`-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`,
			mixed(64),
			mixed(64),
			`-----END OPENSSH ${"PRIVATE"} KEY-----`,
		].join("\n");
		expect(scrubSecrets(`key:\n${key}\ndone`).text).toBe(
			"key:\n[secret scrubbed: private key]\ndone",
		);
	});
});

describe("a credential where a file or a shell keeps it", () => {
	it("keeps the name a shell variable gives it", () => {
		const line = `export BITRISE${"_TOKEN"}=${mixed(40)}`;
		expect(scrubSecrets(line).text).toBe(
			"export BITRISE_TOKEN=[secret scrubbed: credential]",
		);
	});

	it("keeps an npmrc line's registry and key", () => {
		const line = `//registry.npmjs.org/:_auth${"Token"}=${mixed(40)}`;
		expect(scrubSecrets(line).text).toBe(
			"//registry.npmjs.org/:_authToken=[secret scrubbed: npm token]",
		);
	});

	it("keeps a JSON field's name and quotes", () => {
		const json = `{"refresh${"_token"}": "${mixed(40)}", "scope": "drive"}`;
		expect(scrubSecrets(json).text).toBe(
			'{"refresh_token": "[secret scrubbed: credential]", "scope": "drive"}',
		);
	});

	it("keeps the word Bearer in a header", () => {
		const header = `Authorization: Bearer ${mixed(40)}`;
		expect(scrubSecrets(header).text).toBe(
			"Authorization: Bearer [secret scrubbed: bearer token]",
		);
	});
});

describe("ordinary output", () => {
	const ordinary = [
		"commit 8c07f75e2b9c4d1a9f0e3b2c1d0e9f8a7b6c5d4e",
		"sha256-sq8gkou9Rr+iWR95OeQNtd57doTDkUa47KQN3IabmVk=",
		"/nix/store/f0rfa5pcykqbv313j74x7l7wa8nl4bj4-nix-2.34.8/bin/nix",
		"const token = someVeryLongFunctionName1(input);",
		'GITHUB_TOKEN="$SOME_VARIABLE_NAME_THAT_IS_LONG"',
		"API_TOKEN=<paste-the-token-here-1>",
		"NPM_TOKEN=nothingButLettersInHere",
		"Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
		'{"access_token": "short"}',
	];
	for (const text of ordinary) {
		it(`reads as it did: ${text}`, () => {
			expect(scrubSecrets(text)).toEqual({ text, kinds: [] });
		});
	}
});

describe("a tool's answer", () => {
	type Handler = (event: unknown) => Promise<unknown>;
	let handler: Handler;

	beforeEach(() => {
		const handlers = new Map<string, Handler>();
		const pi = { on: (name: string, on: Handler) => handlers.set(name, on) };
		secretScrubInterceptor(pi as unknown as ExtensionAPI);
		const registered = handlers.get("tool_result");
		if (!registered) throw new Error("the scrub never listened for results");
		handler = registered;
	});

	const answer = (fields: Record<string, unknown>) =>
		handler({
			type: "tool_result",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat ~/.zsh_history" },
			isError: false,
			details: undefined,
			...fields,
		});

	it("reaches the model and the log with its text scrubbed", async () => {
		const token = `gh${"p"}_${mixed(36)}`;
		const image = {
			type: "image",
			data: `AK${"IA"}${upper(16)}`,
			mimeType: "image/png",
		};
		const result = await answer({
			content: [{ type: "text", text: `token: ${token}` }, image],
		});
		expect(result).toMatchObject({
			content: [
				{ type: "text", text: "token: [secret scrubbed: GitHub token]" },
				image,
			],
		});
	});

	it("has its details and structured answer scrubbed however deep", async () => {
		const token = `npm${"_"}${mixed(36)}`;
		const result = await answer({
			content: [{ type: "text", text: "done" }],
			details: { runs: [{ output: token, exit: 0 }] },
			structuredContent: { tokens: [token] },
		});
		expect(result).toMatchObject({
			details: { runs: [{ output: "[secret scrubbed: npm token]", exit: 0 }] },
			structuredContent: { tokens: ["[secret scrubbed: npm token]"] },
		});
	});

	it("is handed on untouched when it holds no secret", async () => {
		const result = await answer({
			content: [{ type: "text", text: "all clean" }],
		});
		expect(result).toBeUndefined();
	});

	describe("whose whole output pi saved to a file", () => {
		const written: string[] = [];
		const saved = (name: string, text: string) => {
			const file = path.join(os.tmpdir(), name);
			fs.writeFileSync(file, text, { mode: 0o600 });
			written.push(file);
			return file;
		};

		afterEach(() => {
			for (const file of written.splice(0))
				fs.rmSync(file, { recursive: true, force: true });
		});

		it("has the file scrubbed, even where the answer left the secret out", async () => {
			const token = `gh${"p"}_${mixed(36)}`;
			const file = saved(
				`pi-bash-${randomBytes(8).toString("hex")}.log`,
				`early ${token}\nlate\n`,
			);
			const result = await answer({
				content: [{ type: "text", text: "late" }],
				details: { fullOutputPath: file },
			});
			expect(result).toBeUndefined();
			expect(fs.readFileSync(file, "utf8")).toBe(
				"early [secret scrubbed: GitHub token]\nlate\n",
			);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		});

		it("has pi-durable's spill scrubbed, named in the structured answer", async () => {
			const key = `AK${"IA"}${upper(16)}`;
			const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-"));
			const file = path.join(folder, `pi-output-${randomUUID()}.log`);
			fs.writeFileSync(file, `early ${key}\nlate\n`, { mode: 0o644 });
			written.push(folder);
			const result = await answer({
				content: [{ type: "text", text: "late" }],
				structuredContent: {
					output: "late",
					truncated: true,
					fullOutputPath: file,
					exitCode: 0,
				},
			});
			expect(result).toBeUndefined();
			expect(fs.readFileSync(file, "utf8")).toBe(
				"early [secret scrubbed: AWS access key]\nlate\n",
			);
			expect(fs.statSync(file).mode & 0o777).toBe(0o644);
		});

		it("leaves a file pi didn't name alone", async () => {
			const token = `gh${"p"}_${mixed(36)}`;
			const file = saved(`notes-${randomBytes(8).toString("hex")}.log`, token);
			await answer({
				content: [{ type: "text", text: "done" }],
				details: { fullOutputPath: file },
			});
			expect(fs.readFileSync(file, "utf8")).toBe(token);
		});
	});
});

describe("the file an answer names as its saved output", () => {
	const folder = "/tmp/pi-folder";

	it("is one pi saved, in the temporary folder", () => {
		const file = `${folder}/pi-bash-0a1b2c3d4e5f6a7b.log`;
		expect(savedOutputFile({ fullOutputPath: file }, folder)).toBe(file);
	});

	it("is one pi-durable saved, in its own folder in the temporary folder", () => {
		const file = `${folder}/tmp-a1B2c3/pi-output-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.log`;
		expect(savedOutputFile({ fullOutputPath: file }, folder)).toBe(file);
	});

	it("is never one elsewhere, however it is named", () => {
		for (const named of [
			`${folder}/pi-output-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.log`,
			`${folder}/tmp-a1B2c3/deeper/pi-output-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.log`,
			`${folder}/other-a1B2c3/pi-output-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.log`,
			`${folder}/tmp-a1B2c3/pi-output-not-a-uuid.log`,
			`${folder}/tmp-a1B2c3/session.jsonl`,
			`/home/someone/tmp-a1B2c3/pi-output-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.log`,
			"/home/someone/pi-bash-0a1b2c3d4e5f6a7b.log",
			`${folder}/../pi-bash-0a1b2c3d4e5f6a7b.log`,
			`${folder}/deeper/pi-bash-0a1b2c3d4e5f6a7b.log`,
			`${folder}/session.jsonl`,
		]) {
			expect(
				savedOutputFile({ fullOutputPath: named }, folder),
			).toBeUndefined();
		}
	});

	it("is nothing when the details name none", () => {
		expect(savedOutputFile(undefined, folder)).toBeUndefined();
		expect(savedOutputFile({ fullOutputPath: 3 }, folder)).toBeUndefined();
	});
});
