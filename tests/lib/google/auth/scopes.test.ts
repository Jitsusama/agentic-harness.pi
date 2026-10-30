/**
 * What a Google sign-in asks for.
 *
 * Programs beyond pi read the sign-in's file and can do only what it
 * grants, so a scope one of them needs has to be asked for here: the
 * desktop's file picker saves into Drive with drive.file, which writes
 * only files made there, beside drive.readonly, which reads the rest.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { initiateDeviceFlow } from "../../../../lib/google/auth/oauth.ts";

const CONFIG = { clientId: "id", clientSecret: "secret" };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the scopes a Google sign-in asks for", () => {
	it("asks to write the files it makes in Drive, and to read the rest", async () => {
		const fetch = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						device_code: "dc",
						user_code: "ABCD-EFGH",
						verification_url: "https://www.google.com/device",
						interval: 5,
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetch);

		await initiateDeviceFlow(CONFIG);

		const body = new URLSearchParams(String(fetch.mock.calls[0]?.[1]?.body));
		const asked = (body.get("scope") ?? "").split(" ");
		expect(asked).toContain("https://www.googleapis.com/auth/drive.file");
		expect(asked).toContain("https://www.googleapis.com/auth/drive.readonly");
	});
});
