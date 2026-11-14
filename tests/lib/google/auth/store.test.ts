import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useSecretStore } from "../../../../lib/core/internal/keyring/secrets.ts";
import {
	moveToKeyring,
	readCredentials,
	writeCredentials,
} from "../../../../lib/google/auth/store.ts";
import { credentialsPath } from "../../../../lib/google/paths.ts";
import {
	type MemorySecretStore,
	memorySecretStore,
} from "../../../support/memory-secret-store.ts";

let keyring: MemorySecretStore;

beforeEach(() => {
	keyring = memorySecretStore();
	useSecretStore(keyring);
});

describe("google credentials store", () => {
	it("reads fresh defaults when nothing is stored", async () => {
		expect(await readCredentials()).toEqual({ accounts: [], tokens: {} });
	});

	it("fills in what a stored document leaves out", async () => {
		keyring.items.set("google-credentials", "{}");

		expect(await readCredentials()).toEqual({ accounts: [], tokens: {} });
	});

	it("keeps what it writes in the keyring", async () => {
		const data = {
			accounts: [{ name: "work", isDefault: true }],
			tokens: {},
		};

		await writeCredentials(data);

		expect(await readCredentials()).toEqual(data);
		expect(JSON.parse(keyring.items.get("google-credentials") ?? "")).toEqual(
			data,
		);
	});

	it("moves the old plain file into the keyring", async () => {
		const file = credentialsPath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ accounts: [], tokens: {} }));

		await moveToKeyring();

		expect(existsSync(file), "the plain file is gone").toBe(false);
		expect([...keyring.items.keys()]).toEqual(["google-credentials"]);
	});
});
