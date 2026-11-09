/** Hook installation happens in each runner's repository, not the host's. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import attributionExtension from "../../../extensions/attribution-interceptor/index.ts";
import { extensionRunner } from "../../support/extension-runner.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";

const repos: string[] = [];
const runners: ReturnType<typeof extensionRunner>[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stop();
	for (const repo of repos.splice(0)) disposeRepo(repo);
});

it("installs each repo's hook only when its conversation starts", async () => {
	const a = await freshRepo(),
		b = await freshRepo();
	repos.push(a, b);
	const first = extensionRunner(attributionExtension, a);
	const second = extensionRunner(attributionExtension, b);
	runners.push(first, second);
	const hookA = join(a, ".git/hooks/prepare-commit-msg"),
		hookB = join(b, ".git/hooks/prepare-commit-msg");
	expect(existsSync(hookA), "A has no hook before its runner starts").toBe(
		false,
	);
	expect(existsSync(hookB), "B has no hook before its runner starts").toBe(
		false,
	);
	await first.start();
	expect(existsSync(hookA), "A startup installs A's hook").toBe(true);
	expect(existsSync(hookB), "A startup leaves B's hook absent").toBe(false);
	await second.start();
	expect(existsSync(hookB), "B startup installs B's hook").toBe(true);
	expect(first.errors).toEqual([]);
	expect(second.errors).toEqual([]);
});
