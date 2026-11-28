import { describe, expect, it } from "vitest";
import { MAX_SOCKET_PATH_BYTES } from "../../../../host/service/address.ts";
import { hostSocket, longestChildSocket, sealParent } from "./seal.ts";

const REALM = "sealed-abcdef";

/** A folder whose longest child socket comes to exactly `bytes`. */
function folderGiving(bytes: number): string {
	const base = longestChildSocket("/", REALM).length;
	return `/${"x".repeat(bytes - base - 1)}`;
}

/** A folder whose host socket comes to exactly `bytes`. */
function folderGivingHost(bytes: number): string {
	const base = hostSocket("/", REALM).length;
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

	it("names the host's own socket beside its children's slot folder", () => {
		expect(hostSocket("/tmp", REALM)).toBe(
			"/tmp/e-XXXXXXl/r/pi-host/sealed-abcdef-background.sock",
		);
	});

	// 27 November (#2334's F25): a sandbox with no writable /tmp has no
	// short folder, and refusing there failed every case in beforeEach.
	it("stays under the run's temp folder when no short folder fits its children but the host's own socket fits", () => {
		const near = folderGivingHost(MAX_SOCKET_PATH_BYTES);
		expect(
			Buffer.byteLength(longestChildSocket(near, REALM)),
			"a child's socket past the limit",
		).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
		expect(sealParent(REALM, near, undefined), "no short folder").toBe(near);
		expect(sealParent(REALM, near, near), "the short one too long").toBe(near);
	});

	it("finds no folder when not even the host's own socket fits", () => {
		const near = folderGivingHost(MAX_SOCKET_PATH_BYTES + 1);
		expect(sealParent(REALM, near, undefined), "no short folder").toBe(
			undefined,
		);
		expect(sealParent(REALM, near, near), "the short one too long").toBe(
			undefined,
		);
	});
});
