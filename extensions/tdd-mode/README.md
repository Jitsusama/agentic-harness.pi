# TDD Mode Extension

Red → green → refactor state machine with phase enforcement.

The [TDD workflow skill](../../skills/tdd-workflow/) teaches the
methodology. This extension enforces the discipline.

## How It Works

During the **red** phase, writes to implementation files require
confirmation (test files are unrestricted). After each **green**,
a refactor gate pauses for your input. After **refactor**, a
commit is proposed and reviewed by git-guardian.

## Commands

| Command | Description |
|---------|-------------|
| `/tdd [plan-file]` | Toggle TDD mode, optionally pointing at a plan |

## Keyboard Shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+T` | Toggle TDD mode |
