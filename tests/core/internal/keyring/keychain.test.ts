import { describe, expect, it } from "vitest";
import {
	CHUNK_LENGTH,
	keychainStore,
	type SecurityResult,
	type SecurityRunner,
} from "../../../../lib/core/internal/keyring/keychain.ts";
import { KeyringUnavailable } from "../../../../lib/core/internal/keyring/store.ts";

/** Splits a `security -i` line as its own reader does, quotes and all. */
function words(line: string): string[] {
	return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(
		(match) => match[1] ?? match[2] ?? "",
	);
}

function flag(args: readonly string[], name: string): string {
	const at = args.indexOf(name);
	return at >= 0 ? (args[at + 1] ?? "") : "";
}

/** A Keychain in memory behind a fake `security`, with its calls kept. */
function fakeSecurity(options: { failAdd?: boolean } = {}) {
	const items = new Map<string, string>();
	const calls: { args: readonly string[]; input?: string }[] = [];
	const ok = (stdout = ""): SecurityResult => ({ code: 0, stdout, stderr: "" });
	const missing: SecurityResult = {
		code: 44,
		stdout: "",
		stderr:
			"security: The specified item could not be found in the keychain.\n",
	};
	function act(args: readonly string[]): SecurityResult {
		const account = flag(args, "-a");
		switch (args[0]) {
			case "find-generic-password": {
				const value = items.get(account);
				return value === undefined ? missing : ok(`${value}\n`);
			}
			case "delete-generic-password":
				return items.delete(account) ? ok() : missing;
			case "add-generic-password":
				if (options.failAdd) return ok();
				items.set(account, flag(args, "-w"));
				return ok();
			default:
				return { code: 1, stdout: "", stderr: `unknown ${args[0]}\n` };
		}
	}
	const run: SecurityRunner = async (args, input) => {
		calls.push({ args, input });
		if (args[0] === "-i") {
			for (const line of (input ?? "").split("\n").filter(Boolean)) {
				expect(line.length).toBeLessThan(4096);
				act(words(line));
			}
			return ok();
		}
		return act(args);
	};
	return { items, calls, run };
}

describe("keychainStore", () => {
	it("reads back what it wrote, and nothing for an account never written", async () => {
		const security = fakeSecurity();
		const store = keychainStore(security.run);

		await store.write("slack-credentials", '{"token":"xoxp-1"}');

		expect(await store.read("slack-credentials")).toBe('{"token":"xoxp-1"}');
		expect(await store.read("google-credentials")).toBeNull();
	});

	it("never puts the secret on a command line", async () => {
		const security = fakeSecurity();
		const store = keychainStore(security.run);

		await store.write("slack-credentials", "xoxp-secret");

		const encoded = Buffer.from("xoxp-secret").toString("base64");
		for (const call of security.calls) {
			expect(call.args.join(" ")).not.toContain("xoxp-secret");
			expect(call.args.join(" ")).not.toContain(encoded);
		}
		expect(
			security.calls.some((call) => call.input?.includes(encoded)),
			"the encoded value reaches security on stdin",
		).toBe(true);
	});

	it("splits a value too long for one line into chunks and joins them", async () => {
		const security = fakeSecurity();
		const store = keychainStore(security.run);
		const long = "x".repeat(CHUNK_LENGTH * 2);

		await store.write("google-credentials", long);

		expect(await store.read("google-credentials")).toBe(long);
		expect(security.items.size).toBeGreaterThan(2);
	});

	it("leaves no chunks of an older value behind", async () => {
		const security = fakeSecurity();
		const store = keychainStore(security.run);

		await store.write("google-credentials", "x".repeat(CHUNK_LENGTH * 2));
		await store.write("google-credentials", "short");

		expect(await store.read("google-credentials")).toBe("short");
		expect([...security.items.keys()]).toEqual(["google-credentials"]);
	});

	it("removes a value with its chunks, and removing nothing is no error", async () => {
		const security = fakeSecurity();
		const store = keychainStore(security.run);
		await store.write("google-credentials", "x".repeat(CHUNK_LENGTH * 2));

		await store.remove("google-credentials");
		await store.remove("google-credentials");

		expect(security.items.size).toBe(0);
	});

	it("says the Keychain can't be reached when security refuses", async () => {
		const store = keychainStore(async () => ({
			code: 36,
			stdout: "",
			stderr: "security: User interaction is not allowed.\n",
		}));

		await expect(store.read("slack-credentials")).rejects.toThrow(
			/The Keychain can't be reached: security: User interaction is not allowed/,
		);
	});

	it("says so when security isn't there", async () => {
		const store = keychainStore(async () => {
			throw new Error("spawn /usr/bin/security ENOENT");
		});

		await expect(store.read("slack-credentials")).rejects.toBeInstanceOf(
			KeyringUnavailable,
		);
	});

	it("refuses a write the Keychain did not keep", async () => {
		const security = fakeSecurity({ failAdd: true });
		const store = keychainStore(security.run);

		await expect(store.write("slack-credentials", "value")).rejects.toThrow(
			/did not keep/,
		);
	});

	it("never repeats what security -i echoed of a refused line", async () => {
		const encoded = Buffer.from("xoxp-secret").toString("base64");
		const echoes = (code: number): SecurityRunner => {
			const security = fakeSecurity({ failAdd: true });
			return async (args, input) =>
				args[0] === "-i"
					? { code, stdout: "", stderr: `refused: ${input ?? ""}` }
					: security.run(args, input);
		};

		for (const code of [1, 0]) {
			const failure = await keychainStore(echoes(code))
				.write("slack-credentials", "xoxp-secret")
				.then(
					() => undefined,
					(error: unknown) => error,
				);

			expect(failure).toBeInstanceOf(KeyringUnavailable);
			expect(String(failure)).not.toContain(encoded);
			expect(String(failure)).not.toContain("xoxp-secret");
		}
	});
});
