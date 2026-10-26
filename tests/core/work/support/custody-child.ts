/**
 * A second session taking and giving up its share of one tree.
 *
 * Run as its own process by the custody test, because the fault it
 * looks for is two processes rewriting one record: inside one process
 * each rewrite runs to its end before another starts.
 *
 * Arguments: the memory directory, the held tree as JSON, how many
 * times to take and give up a share, and a file to wait for before
 * starting, so every child starts together.
 */

import { existsSync } from "node:fs";
import type { ProcessFacts } from "../../../../lib/core/process/index.ts";
import type { HeldTree } from "../../../../lib/core/work/broker.ts";
import { createTreeMemory } from "../../../../lib/core/work/memory.ts";

const [dir, heldJson, roundsText, goFile] = process.argv.slice(2);
if (!dir || !heldJson || !roundsText || !goFile) {
	throw new Error("usage: custody-child <dir> <held> <rounds> <go-file>");
}
const held: HeldTree = JSON.parse(heldJson);
const rounds = Number(roundsText);

// Answered without asking the machine, so the only time spent between
// reading the record and writing it is the code under test.
const facts: ProcessFacts = {
	startedAt: async (pid) => 1_000 + pid,
	alive: () => true,
};

while (!existsSync(goFile)) {
	await new Promise((resolve) => setTimeout(resolve, 2));
}

const memory = createTreeMemory(dir);
for (let round = 0; round < rounds; round += 1) {
	await memory.rememberHeldByUs(held, facts);
	await memory.forgetUsAsHolder(held.path, facts);
}
// Holding it at the end, which is what the parent checks for.
await memory.rememberHeldByUs(held, facts);
