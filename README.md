# lemmascript-skills

Agent skills for the [LemmaScript](https://github.com/midspiral/LemmaScript) toolchain — plain `SKILL.md` (frontmatter + markdown) directories, readable by any agent harness that understands the format, and by anything else as ordinary markdown.

## Skills

- **`lemmascript`** — the core skill: annotation grammar, the gen/verify/regen workflow, and `reference/` (see below).
- **`lemmascript-design-doc`** — create a DESIGN.md for a verified app.
- **`lemmascript-proof-review`** — audit verified proofs against the design document.
- **`lemmascript-verified-codebase-rules`** — rules that bind any change (UI, API, refactor) in a codebase containing verified files, so the verification boundary doesn't erode. (Replaces the deprecated `lemmascript-verified-codebase`.)

All shipped skills are `lemmascript*`-prefixed: consumers can keep their own skills alongside without collisions, and ownership is legible in a directory listing.

## Consumption

Mount this repo at your skills directory (e.g. `.claude/skills/`) as a git submodule or subtree. Updating is your normal git discipline: bump the submodule / `subtree pull`, review the diff.

Prerequisite: the tools themselves — `npm i -g lemmascript` puts `lsc` (and `lsc claimcheck`) on PATH.

## `lemmascript/reference/` is machine-owned

`lemmascript/reference/` holds a read-only snapshot of a LemmaScript release: `SPEC.md` (verbatim) and `src/` (the compiler's `tools/src`). It is written only by the release sync from [midspiral/LemmaScript](https://github.com/midspiral/LemmaScript) — humans never edit it, and PRs should not touch it. Sync commits are titled `sync from lemmascript vX.Y.Z`; once LemmaScript's release CI lands, this repo is tagged in lockstep with each release.
