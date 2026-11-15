/** How the mesh's tools say a time gone by and what a peer waits on. */

import type { Message } from "../../../lib/mesh/message.ts";
import type { WantKind } from "../../../lib/mesh/want.ts";

/** How long ago a message was sent, in minutes, or hours past two. */
export function since(message: Message, now: number): string {
	return lastedText(now - Date.parse(message.at));
}

/** A span of time in minutes, or hours past two. */
export function lastedText(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

export function capitalized(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A want's kind, as mesh_groups says it. */
export const WANTING: Record<WantKind, string> = {
	question: "asked",
	approval: "held at an approval",
	blocked: "blocked",
};
