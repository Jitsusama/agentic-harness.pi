import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatewayKey } from "../../../host/service/gateway-key.ts";

const NOON = Date.parse("2026-11-09T12:00:00-05:00");

describe("gatewayKey", () => {
	let dir: string;
	let stampFile: string;
	let issued: string[];
	const resolve = () => {
		const key = `key-${issued.length + 1}`;
		issued.push(key);
		return Promise.resolve(key);
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "gateway-key-"));
		stampFile = join(dir, "expires_at");
		issued = [];
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const stamp = (iso: string) => writeFile(stampFile, `${iso}\n`);
	const renewing = (now = () => NOON) =>
		gatewayKey({ env: {}, resolve, stampFile, now });

	describe("inherited from the host's environment", () => {
		it("takes the launcher's order and never renews", async () => {
			const key = gatewayKey({
				env: {
					PI_PROXY_API_KEY: " legacy ",
					PI_PROXY_AUTH_HEADER: "Bearer bearer",
					SHOPIFY_PROXY_KEY: "canonical",
				},
				resolve,
				stampFile,
			});
			key.refused();
			expect(await key.current()).toBe("legacy");
			expect(key.inherited, "an inherited key is marked fixed").toBe(true);
			expect(issued).toEqual([]);
		});

		it("skips blank and bang values as the launcher does", async () => {
			const key = gatewayKey({
				env: {
					PI_PROXY_API_KEY: "  ",
					PI_PROXY_AUTH_HEADER: "Bearer !op://vault/key",
					SHOPIFY_PROXY_KEY: "canonical",
				},
				resolve,
				stampFile,
			});
			expect(await key.current()).toBe("canonical");
		});

		it("resolves the personal key when nothing usable is inherited", async () => {
			await stamp("2026-11-10T07:00:00-05:00");
			const key = gatewayKey({
				env: { SHOPIFY_PROXY_KEY: "!unset" },
				resolve,
				stampFile,
				now: () => NOON,
			});
			expect(await key.current()).toBe("key-1");
			expect(key.inherited, "a resolved key is marked renewing").toBe(false);
		});
	});

	describe("renewed from the dev cache", () => {
		it("keeps one key while its stamp holds and is far off", async () => {
			await stamp("2026-11-10T07:00:00-05:00");
			const key = renewing();
			expect(await key.current()).toBe("key-1");
			expect(await key.current()).toBe("key-1");
			expect(issued).toEqual(["key-1"]);
		});

		it("resolves again once the daemon rewrites the stamp", async () => {
			await stamp("2026-11-10T07:00:00-05:00");
			const key = renewing();
			await key.current();
			await stamp("2026-11-11T07:00:00-05:00");
			expect(await key.current()).toBe("key-2");
		});

		it("resolves again inside the renewal lead", async () => {
			await stamp("2026-11-09T12:09:00-05:00");
			const key = renewing();
			expect(await key.current()).toBe("key-1");
			expect(await key.current()).toBe("key-2");
		});

		it("resolves again once after the gateway refuses the key", async () => {
			await stamp("2026-11-10T07:00:00-05:00");
			const key = renewing();
			await key.current();
			key.refused();
			expect(await key.current()).toBe("key-2");
			expect(await key.current()).toBe("key-2");
		});

		it("trusts no key when nothing dates it", async () => {
			const key = renewing();
			expect(await key.current()).toBe("key-1");
			expect(await key.current()).toBe("key-2");
		});

		it("shares one resolve between requests made at once", async () => {
			await stamp("2026-11-10T07:00:00-05:00");
			const key = renewing();
			const keys = await Promise.all([key.current(), key.current()]);
			expect(keys).toEqual(["key-1", "key-1"]);
			expect(issued).toEqual(["key-1"]);
		});

		it("fails the request on a failed resolve and tries again next time", async () => {
			await stamp("2026-11-10T07:00:00-05:00");
			let fail = true;
			const key = gatewayKey({
				env: {},
				stampFile,
				now: () => NOON,
				resolve: () =>
					fail
						? Promise.reject(new Error("Gateway key could not be resolved"))
						: resolve(),
			});
			await expect(key.current()).rejects.toThrow(
				"Gateway key could not be resolved",
			);
			fail = false;
			expect(await key.current()).toBe("key-1");
		});
	});
});
