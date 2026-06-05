import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageConfigPath } from "../../../lib/internal/paths";

describe("packageConfigPath", () => {
	it("places config.json under the package brand using XDG_CONFIG_HOME", () => {
		const path = packageConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u");
		expect(path).toBe(join("/xdg", "pi", "agentic-harness.pi", "config.json"));
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
		const path = packageConfigPath({}, "/home/u");
		expect(path).toBe(
			join("/home/u", ".config", "pi", "agentic-harness.pi", "config.json"),
		);
	});

	it("treats an empty XDG_CONFIG_HOME as unset", () => {
		const path = packageConfigPath({ XDG_CONFIG_HOME: "" }, "/home/u");
		expect(path).toBe(
			join("/home/u", ".config", "pi", "agentic-harness.pi", "config.json"),
		);
	});
});
