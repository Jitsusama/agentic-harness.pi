/**
 * The account's own temporary folder on a Mac is asked of getconf once
 * a process, and asked again after a failure, since the fence guards
 * the jiti and node caches there and one failed ask must not leave it
 * unguarded for the host's life.
 */

import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: vi.fn() };
});

const asked = vi.mocked(execFileSync);
afterEach(() => asked.mockReset());

it("asks again after getconf failed, then keeps the answer it gave", async () => {
	// A fresh copy, since the setup files load the module before this
	// file's mock, and with it the real getconf.
	vi.resetModules();
	const { accountsTemporary } = await import("../../../lib/internal/paths.ts");
	asked.mockImplementationOnce(() => {
		throw new Error("EAGAIN");
	});
	expect(accountsTemporary(), "named after a failed ask").toBeUndefined();
	expect(asked, "getconf wasn't asked").toHaveBeenCalledTimes(1);
	asked.mockReturnValueOnce("/var/folders/xy/T/\n");
	expect(accountsTemporary()).toBe("/var/folders/xy/T/");
	expect(accountsTemporary()).toBe("/var/folders/xy/T/");
	expect(asked).toHaveBeenCalledTimes(2);
});
