/**
 * Sending to `need` from the fixture's session, and what every answer
 * it gets must never say, shared by the tests of where a need goes and
 * of what a lost one's refusal points at.
 */

import { expect } from "vitest";
import type { startSession } from "./mesh.ts";

/** The fixture's session, 7M6JKG, as the node keeps it. */
export const asker = { key: "cell:7M6JKG", title: "A Web, Not a Funnel" };

/** Send through the session's mesh_send, answering its words. */
export async function sending(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	params: Record<string, unknown>,
): Promise<string> {
	const answer = await tools.get("mesh_send")?.execute("call-1", params);
	return answer?.content[0]?.text ?? "";
}

/**
 * A refusal is read at the moment a need fails, and the note's next step
 * is to ask whoever is above who owns it, so no refusal may say a need
 * never goes to an orchestrator. Naming whom to ask there is still free.
 */
export function expectNoBarAbove(said: string): void {
	expect(said).not.toMatch(
		/never sent to an orchestrator|(goes|went) to no orchestrator/,
	);
}
