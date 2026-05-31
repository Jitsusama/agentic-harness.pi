# Example personas

A persona is a charter for one review lens: a markdown file with
YAML frontmatter (identity) and a prose body (the charter). The
frontmatter carries only `name` and `description` — pure identity,
no mechanism. The model, thinking level and tools a persona runs
with live in `pr-workflow.json`, which references the persona by
its file-name id. The same persona can run cheap-and-fast for a
sanity pass or deep-and-thorough for a security-sensitive change
without the file changing at all.

The body is the distinctive charter only — the lens, the
disposition, what this reviewer notices and cares about. The
invariant scaffolding (the output contract, the diff-reading
rules) is wrapped on by the extension at dispatch, so a persona
never repeats it.

## Installing

pr-workflow reads personas from, in order:

1. `$PR_WORKFLOW_PERSONAS_DIR`
2. `$XDG_CONFIG_HOME/pi/personas`
3. `~/.config/pi/personas`

Copy the ones you want into that directory:

```sh
mkdir -p ~/.config/pi/personas
cp escalation.md contracts.md operability.md ~/.config/pi/personas/
```

The file-name stem becomes the persona id, so `escalation.md`
defines persona `escalation`. Reference it from a council reviewer
entry in `pr-workflow.json`:

```json
{
  "reviewers": [
    {
      "persona": "escalation",
      "model": "anthropic/claude-opus-4-7",
      "thinkingLevel": "high",
      "tools": ["read", "grep", "glob", "ls"]
    }
  ]
}
```

The reviewer id defaults to the persona id; set an explicit `id`
when you want two reviewers to share one persona at different
mechanism settings.

## The palette

- **escalation** — privilege-escalation hunter: traces every new
  capability to who can reach it.
- **contracts** — contract and invariant keeper: guards the
  promises a module makes to its callers.
- **operability** — operability realist: asks how the code behaves
  at 3am when it breaks.

## judge.md

`judge.md` is not a reviewer persona — the judge holds no lens. It
documents the judge's law charter as the canonical example, so it
reads and diffs alongside the reviewer personas. The extension
loads the judge charter itself; you do not select it from the
library.
