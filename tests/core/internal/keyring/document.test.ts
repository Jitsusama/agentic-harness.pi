import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsDocument } from "../../../../lib/core/internal/keyring/document.ts";
import {
	type KeyringNotice,
	onKeyringNotice,
	resetKeyringNotices,
} from "../../../../lib/core/internal/keyring/notices.ts";
import {
	type MemorySecretStore,
	memorySecretStore,
} from "../../../support/memory-secret-store.ts";

interface Doc {
	token?: string;
}

describe("credentialsDocument", () => {
	let dir: string;
	let file: string;
	let store: MemorySecretStore;
	let notices: KeyringNotice[];

	function document() {
		return credentialsDocument<Doc>({
			account: "test-credentials",
			label: "Test credentials",
			filePath: () => file,
			empty: () => ({}),
			store: () => store,
		});
	}

	function plainFile(data: unknown): void {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(data));
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "keyring-document-"));
		file = join(dir, "test", "credentials.json");
		store = memorySecretStore();
		resetKeyringNotices();
		notices = [];
		onKeyringNotice((notice) => notices.push(notice));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads empty when nothing is stored anywhere", async () => {
		expect(await document().read()).toEqual({});
		expect(notices).toEqual([]);
	});

	it("keeps what it writes in the keyring, never in a file", async () => {
		await document().write({ token: "t1" });

		expect(await document().read()).toEqual({ token: "t1" });
		expect(store.items.get("test-credentials")).toBe('{"token":"t1"}');
		expect(existsSync(file)).toBe(false);
	});

	it("moves the plain file into the keyring and removes it, saying so", async () => {
		plainFile({ token: "from-file" });

		expect(await document().read()).toEqual({ token: "from-file" });

		expect(store.items.get("test-credentials")).toBe('{"token":"from-file"}');
		expect(existsSync(file)).toBe(false);
		expect(notices).toEqual([
			expect.objectContaining({
				level: "info",
				message: expect.stringMatching(/moved into The test keyring/),
			}),
		]);
	});

	it("keeps the file when the keyring does not give the value back", async () => {
		plainFile({ token: "from-file" });
		const forgetful = memorySecretStore();
		forgetful.write = async () => {};
		store = forgetful;

		expect(await document().read()).toEqual({ token: "from-file" });

		expect(existsSync(file)).toBe(true);
		expect(notices[0]?.message).toMatch(/stay in the plain file/);
	});

	it("reads the file, keeps it and says why when the keyring is locked", async () => {
		plainFile({ token: "from-file" });
		store.unreachable = "the collection is locked";

		expect(await document().read()).toEqual({ token: "from-file" });

		expect(existsSync(file)).toBe(true);
		expect(notices).toEqual([
			expect.objectContaining({
				level: "warning",
				message: expect.stringMatching(
					/The test keyring can't be reached: the collection is locked\. Test credentials stay in the plain file/,
				),
			}),
		]);
	});

	it("writes the file, readable only by its owner, while the keyring can't be reached", async () => {
		plainFile({ token: "old" });
		chmodSync(file, 0o644);
		store.unreachable = "no Secret Service";

		await document().write({ token: "refreshed" });

		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
			token: "refreshed",
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(notices[0]?.level).toBe("warning");
	});

	it("moves what the fallback wrote once the keyring answers again", async () => {
		await document().write({ token: "old" });
		store.unreachable = "locked";
		await document().write({ token: "newer" });
		store.unreachable = undefined;

		expect(await document().read()).toEqual({ token: "newer" });
		expect(existsSync(file)).toBe(false);
	});

	it("says a notice once, however many reads find the keyring locked", async () => {
		store.unreachable = "locked";

		await document().read();
		await document().read();

		expect(notices).toHaveLength(1);
	});

	it("holds a notice said before anyone listens for the first listener", async () => {
		resetKeyringNotices();
		plainFile({ token: "from-file" });
		await document().read();

		const heard: KeyringNotice[] = [];
		onKeyringNotice((notice) => heard.push(notice));

		expect(heard).toHaveLength(1);
	});

	it("moves the file at once when asked, and does nothing without one", async () => {
		await document().moveIfPresent();
		expect(store.items.size).toBe(0);

		plainFile({ token: "from-file" });
		await document().moveIfPresent();
		expect(existsSync(file)).toBe(false);
		expect(store.items.size).toBe(1);
	});

	it("moves the file once when many sessions read together", async () => {
		plainFile({ token: "from-file" });
		let writes = 0;
		const write = store.write;
		store.write = async (account, value) => {
			writes++;
			await write(account, value);
		};
		const doc = document();

		const reads = await Promise.all([doc.read(), doc.read(), doc.read()]);

		expect(reads).toEqual([
			{ token: "from-file" },
			{ token: "from-file" },
			{ token: "from-file" },
		]);
		expect(writes).toBe(1);
	});
});
