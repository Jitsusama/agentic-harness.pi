/**
 * What the person typed to this session, held for the process, since
 * one review_ask tool is registered per process. `ask-tool.ts` hears
 * it from the start, so a round asked for later knows what they said
 * before it; `ask.ts` reads it when a round chooses its roster.
 */

import { personsWords } from "../../../lib/internal/session/asked-models.ts";

/** What the person has typed to this session, most recent last. */
export const person = personsWords();
