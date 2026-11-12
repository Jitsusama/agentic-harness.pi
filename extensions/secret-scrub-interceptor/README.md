# Secret Scrub Interceptor

Puts every credential in a tool's answer out of sight before the model
reads it or pi writes it to the session's log. In its place go words
naming what it was, such as `[secret scrubbed: GitHub token]`.

## What It Does

An agent's tools print what they find, and some of it is a credential:
a token in a shell's history, a key in a file read, a service's JSON
answer. Once in a result, it sat in the model's context, went to the
provider with every later turn, and stayed in the session's log. On
7 November, 84 of one machine's 625 session logs held a token-shaped
string, and a backup copied those logs off the machine every hour.

So every answer's text, its details and its structured answer are read
for the shapes in `lib/internal/secrets.ts`, and each one found is
replaced:

- **Shapes a service gives its credentials:** GitHub, GitLab, npm,
  Anthropic, OpenAI, AWS, Google, Slack and Shopify tokens, age
  identities, JSON web tokens and private keys in PEM form.
- **The session's own secrets, by value:** a gateway's token or a
  proxy's key has no shape, so the value of each variable whose name
  ends in TOKEN, SECRET, PASSWORD, AUTH_HEADER or `_KEY` (a PUBLIC_KEY
  aside), or starts with CLOUDSMITH_, is scrubbed wherever it appears,
  and the mark names the variable. A value under 16 characters, without
  a letter and a digit, or that is a path or an address, is left alone.
  These are pi's own variables: a token that only a command's own
  environment holds, as direnv or dev's exported tokens give a shell, is
  caught by its shape alone.
- **Places a credential sits:** a shell variable whose name ends in
  TOKEN, SECRET, PASSWORD, API_KEY or ACCESS_KEY, an npmrc's
  `_authToken`, an AWS credentials file's `aws_secret_access_key` and
  `aws_session_token`, a JSON field such as `refresh_token`, an
  `Authorization` header, `Bearer` or any other scheme, and the password
  in an address, as a git remote or a registry's holds it after the
  user's name. The name stays and only the value goes. The value has to be
  16 characters or more, with a letter and a digit, and not start with
  `$`, so a variable passed on or a function's name is left alone.

- **A command that prints the environment:** `env` or `printenv` on
  their own, a shell's `export -p`, `declare -x` or `set`, systemd's
  `show-environment`, `launchctl print`, `getenv` or `export`, a
  process's `environ` and `ps eww`, over SSH or not. Every value in its
  answer long and mixed enough to be a credential is scrubbed, whatever
  its variable is called, and the mark names the variable. On 12
  November a `launchctl print` over SSH put two of another machine's
  work tokens into an agent's context and log: neither name was one the
  places knew, and the session didn't hold either value. A path or an
  address reads as it did, and `env FOO=1 cargo test` is a command run,
  not a dump.

The places take a name and its value however a tool sets them apart:
`NAME=value`, `NAME => value` as launchctl prints it, or `NAME: value`
and `"NAME": "value"` in YAML and JSON, for names ending in TOKEN,
SECRET, PASSWORD, AUTH_HEADER or `_KEY` (a PUBLIC_KEY aside).

A picture is handed on as it is, and an answer with nothing to hide is
handed on untouched.

The answer isn't the only copy, so two files are scrubbed too:

- **A long command's whole output:** pi's bash saves it to a file in the
  temporary folder and names it in the answer's details. That file is
  rewritten scrubbed, whatever the answer itself held, since a
  credential can sit in the part the answer left out. In a shared host
  the bash is pi-durable's, which saves to `pi-output-<uuid>.log` in a
  `tmp-` folder of its own and names it in the structured answer; that
  file is rewritten the same way. Only a file named as pi or pi-durable
  names them, in the temporary folder or pi-durable's folder directly
  in it, is touched.
- **Stored results:** a tool that answers with a handle writes its
  payload during its own run, before this scrub sees the answer, so the
  result store scrubs each payload as it writes it
  (`lib/core/result/spill.ts`).

A shared host also scrubs what a tool streams while it runs, and the
result it commits, in its tool round (`host/engine/tool-round.ts`),
before any of it reaches a viewer or the durable store, whether or not
the conversation loads this extension. The scrub is pure and
idempotent, so a result this extension already scrubbed is handed on
as it is.

A file read through a scrubbed span can't be edited through that span,
since the mark in the agent's copy doesn't match what the file holds.
The mark says why, so the agent edits around it or asks the person.

Silent, like every interceptor: the mark tells the agent a secret was
there, so it knows not to ask for it again. An agent that needs a
credential passes it by reference (a file, a variable, a helper) rather
than reading it.
