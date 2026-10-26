import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCookieValue } from "../../../../lib/core/web/cookies/extract.ts";

function keyFrom(password: string): Buffer {
	return crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

/** Encrypt a value the way Chrome does, hash prefix included. */
function encrypted(version: string, key: Buffer, value: string): Buffer {
	const cipher = crypto.createCipheriv(
		"aes-128-cbc",
		key,
		Buffer.alloc(16, 0x20),
	);
	const plain = Buffer.concat([Buffer.alloc(32, 7), Buffer.from(value)]);
	return Buffer.concat([
		Buffer.from(version),
		cipher.update(plain),
		cipher.final(),
	]);
}

const peanuts = keyFrom("peanuts");
const keyring = keyFrom("from the keyring");

describe("decryptCookieValue", () => {
	it("opens a v10 cookie with the v10 key", () => {
		const keys = { v10: peanuts, v11: null };

		expect(decryptCookieValue(encrypted("v10", peanuts, "ok"), keys)).toEqual({
			value: "ok",
		});
	});

	it("opens a v11 cookie with the keyring's key, not the v10 one", () => {
		const keys = { v10: peanuts, v11: keyring };

		expect(
			decryptCookieValue(encrypted("v11", keyring, "token"), keys),
		).toEqual({ value: "token" });
	});

	it("says a key is missing rather than wrong when v11 has none", () => {
		const keys = { v10: peanuts, v11: null };

		expect(
			decryptCookieValue(encrypted("v11", keyring, "token"), keys),
		).toEqual({ missing: "v11" });
	});

	it("says the key is wrong when it cannot open the cookie", () => {
		const keys = { v10: peanuts, v11: peanuts };

		expect(
			decryptCookieValue(encrypted("v11", keyring, "token"), keys),
		).toEqual({ failed: true });
	});

	it("passes an unencrypted value through", () => {
		const keys = { v10: null, v11: null };

		expect(decryptCookieValue(Buffer.from("plain"), keys)).toEqual({
			value: "plain",
		});
	});
});
