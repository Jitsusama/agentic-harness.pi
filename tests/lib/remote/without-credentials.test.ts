import { describe, expect, it } from "vitest";
import { withoutCredentials } from "../../../lib/remote/index.js";

describe("withoutCredentials", () => {
	it("drops the userinfo a token is carried in", () => {
		expect(
			withoutCredentials(
				"https://x-access-token:gho_secret@github.com/owner/repo.git",
			),
		).toBe("https://github.com/owner/repo.git");
	});

	it("drops a token carried as the user, with no password at all", () => {
		// GitHub accepts the token in either position, so keeping the user
		// and dropping only the password would leak exactly this form.
		expect(withoutCredentials("https://gho_secret@github.com/owner/repo")).toBe(
			"https://github.com/owner/repo",
		);
	});

	it("leaves a remote that carries no credential alone", () => {
		expect(withoutCredentials("https://github.com/owner/repo.git")).toBe(
			"https://github.com/owner/repo.git",
		);
	});

	it("leaves scp-style ssh alone, where git is a user and not a secret", () => {
		expect(withoutCredentials("git@github.com:owner/repo.git")).toBe(
			"git@github.com:owner/repo.git",
		);
	});

	it("drops the user from ssh written as a url", () => {
		expect(withoutCredentials("ssh://git@github.com/owner/repo.git")).toBe(
			"ssh://github.com/owner/repo.git",
		);
	});

	it("leaves an at sign in the path alone", () => {
		// The userinfo ends at the first slash, so a path can hold an at
		// sign without the host being mistaken for a credential.
		expect(withoutCredentials("https://github.com/owner/repo@v1")).toBe(
			"https://github.com/owner/repo@v1",
		);
	});

	it("leaves a local path alone", () => {
		expect(withoutCredentials("/Users/someone/src/repo")).toBe(
			"/Users/someone/src/repo",
		);
	});

	it("says nothing about an empty remote", () => {
		expect(withoutCredentials("")).toBe("");
	});
});
