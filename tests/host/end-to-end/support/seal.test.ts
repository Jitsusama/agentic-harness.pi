import { describe, expect, it } from "vitest";
import { MAX_SOCKET_PATH_BYTES } from "../../../../host/service/address.ts";
import { longestChildSocket, sealParent } from "./seal.ts";

const REALM = "sealed-abcdef";

/** A folder whose longest child socket comes to exactly `bytes`. */
function folderGiving(bytes: number): string {
	const base = longestChildSocket("/", REALM).length;
	return `/${"x".repeat(bytes - base - 1)}`;
}

describe("where a seal goes", () => {
	it("names a child's socket under the slot folder its host keeps", () => {
		expect(longestChildSocket("/tmp", REALM)).toBe(
			"/tmp/e-XXXXXXl/r/pi-host/sealed-abcdef-background.d/00000000-0000-4000-8000-000000000000.sock",
		);
	});

	it("stays under the run's temp folder when its longest child socket fits", () => {
		const near = folderGiving(MAX_SOCKET_PATH_BYTES);
		expect(
			Buffer.byteLength(longestChildSocket(near, REALM)),
			"the socket at the limit",
		).toBe(MAX_SOCKET_PATH_BYTES);
		expect(sealParent(REALM, near, "/tmp/vs-abcdef")).toBe(near);
	});

	it("goes under the run's short folder when a child's socket would pass the limit", () => {
		const near = folderGiving(MAX_SOCKET_PATH_BYTES + 1);
		expect(sealParent(REALM, near, "/tmp/vs-abcdef")).toBe("/tmp/vs-abcdef");
	});

	it("finds no folder when neither fits, or there is no short one", () => {
		const near = folderGiving(MAX_SOCKET_PATH_BYTES + 1);
		expect(sealParent(REALM, near, undefined), "no short folder").toBe(
			undefined,
		);
		expect(sealParent(REALM, near, near), "the short one too long").toBe(
			undefined,
		);
	});
});
