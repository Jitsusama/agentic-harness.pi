import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useSecretStore } from "../../../../lib/core/internal/keyring/secrets.ts";
import {
	moveToKeyring,
	readCredentials,
	writeCredentials,
} from "../../../../lib/slack/auth/store.ts";
import { credentialsPath } from "../../../../lib/slack/paths.ts";
import {
	type MemorySecretStore,
	memorySecretStore,
} from "../../../support/memory-secret-store.ts";

let keyring: MemorySecretStore;

beforeEach(() => {
	keyring = memorySecretStore();
	useSecretStore(keyring);
});

describe("slack credentials store", () => {
	it("reads nothing when nothing is stored", async () => {
		expect(await readCredentials()).toEqual({});
	});

	it("keeps what it writes in the keyring", async () => {
		const data = {
			token: {
				accessToken: "xoxp-1",
				userId: "U1",
				teamId: "T1",
				scopes: "",
			},
		};

		await writeCredentials(data);

		expect(await readCredentials()).toEqual(data);
		expect([...keyring.items.keys()]).toEqual(["slack-credentials"]);
	});

	it("moves the old plain file into the keyring", async () => {
		const file = credentialsPath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ token: null }));

		await moveToKeyring();

		expect(existsSync(file), "the plain file is gone").toBe(false);
		expect(keyring.items.get("slack-credentials")).toBe('{"token":null}');
	});
});
