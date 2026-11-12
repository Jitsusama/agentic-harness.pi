# Verbs

The things the launcher offers to ask of a model over what the person
has selected, one markdown file each, named for the verb. The verbs
server (`scripts/pi-verbs.ts`) reads this folder, then the person's own
(`~/.config/pi/agentic-harness.pi/verbs/`), whose files take a name over
these, and tells the launcher each verb as it changes.

A verb's front matter says:

- `words`: what the launcher lists it as.
- `says`: a line saying what it does, or nothing.
- `result`: `say` shows the answer, `replace` puts it over the
  selection, and `hand` gives the prompt to an agent session rather
  than a model.
- `disruptive`: `true` when it should wait for Return, as a hand
  does, since what an agent is told can't be taken back.
- `args`: what else it asks for, each a `name` and the `words` it's
  asked with.
- `prompt`: what is asked, naming `{{selection}}` and each argument
  in double braces; the selection alone when it says none.

The body is the system prompt. A selection or argument that looks like
a secret is refused before any prompt is built.
