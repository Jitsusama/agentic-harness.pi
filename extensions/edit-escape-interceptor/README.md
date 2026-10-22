# Edit Escape Interceptor

Reads a `\uXXXX` escape in an edit as the character it names, when
the file shows that is what was meant.

## What It Does

A model editing a line that holds `→` or `§` sometimes spells the
character as its escape, `\u2192`, and the edit fails to match. On
18 October one session failed eleven edits that way, then learnt to
anchor its edits around the character. The same escape in the
replacement text goes in unnoticed, as six characters of text.

So when an edit's old text is not in the file as written, but is once
its escapes are read as characters, both its old and new text are read
that way before the edit runs. It leaves alone:

- an old text that matches as written, since source code may hold
  escapes on purpose;
- the new text, when the file itself holds escapes, since there they
  may be meant as text;
- an edit with no escape in its old text, which never reads the file.

It is silent, like the other interceptors: the edit goes in as the
model meant it, so there is nothing to tell it.

## Where It Lives

- `index.ts`: the `tool_call` handler for `edit`.
- `escapes.ts`: what counts as meant, kept apart so it tests alone.
