---
name: lemmascript-claimcheck
description: Audit a LemmaScript function's plain-English `//@ contract` against its formal `//@ requires`/`//@ ensures` via an LLM round-trip. Use when writing `//@ contract` intent, checking that a verified spec actually means what it claims, or running/interpreting `lsc claimcheck`.
---

# LemmaScript claimcheck

LemmaScript proves the formal spec; it can't prove the spec *means* what you intended. A function can verify green yet guarantee less — or other — than its prose describes. `claimcheck` finds and closes that gap: it informalizes the `//@ requires`/`//@ ensures` back to English **blind** (without seeing your `//@ contract`), then compares the back-translation to the contract.

This is a companion to the core [lemmascript](../lemmascript/SKILL.md) skill — read that first for the verify loop.

## Prerequisite: verify first

Every run writes a `*.guarantees.*` file, and a guarantee only exists once verification has passed — so run `lsc check` and get the file green **before** claimchecking. claimcheck vets meaning, not proofs; a confirmed verdict on an unverified file is a claim about the spec, not the code, and the output file's name would overstate it.

Verdicts are a pure function of the annotations: no re-run is needed after later proof work **unless a `//@ contract`/`//@ requires`/`//@ ensures` line changed** — and if proving forced a spec change (a discovered `requires`, a weakened `ensures`), that's exactly when to re-run.

## The `//@ contract` annotation

Contracts are written when the spec is authored, alongside the `//@ requires`/`//@ ensures` — by the time you run claimcheck they should already be in the file. claimcheck only *checks*; it never writes or suggests annotations. Iteration on the annotations happens afterward, based on its verdicts.

A `//@ contract` is one plain-English line beside the formal spec. It's natural language, not a spec expression — the provers ignore it entirely (it never reaches the generated Dafny). `lsc extract` carries it in the Raw IR (SPEC §2.13).

```ts
//@ contract Clamps x into the inclusive range [lo, hi]; the result never falls outside it.
//@ verify
//@ requires lo <= hi
//@ ensures \result >= lo && \result <= hi
export function clamp(x: number, lo: number, hi: number): number { ... }
```

Multiple `//@ contract` lines are collected in order (like `//@ requires`). Write the intent you'd defend to a stakeholder — the point is to catch a spec that quietly promises less.

## Run

```sh
lsc claimcheck <file.verify.ts> [--out <dir>] [--json] [--claims-only] [<claimcheck flags>]
```

`lsc claimcheck` forwards to `lemmascript-claimcheck`, which shells `lsc extract` for the contracts and runs the blind round-trip. For `domain.verify.ts` it writes a trust manifest next to the source: `domain.verify.guarantees.md` (human-readable) + `domain.verify.guarantees.json` (machine-readable), and prints a one-line summary (`N confirmed, M disputed, K gaps`).

**Dry run:** `--claims-only` prints the claims that *would* be sent (and any gaps) as JSON and makes **no API call** — use it to inspect what claimcheck sees before spending tokens. Gaps are detected here, offline.

## Backend setup

The round-trip needs an LLM. The backend is claimcheck's concern; pick one and pass it through — the leading `<file>` positional is consumed by `lsc claimcheck`, every other flag forwards to claimcheck:

- **Direct API** — set `ANTHROPIC_API_KEY` in the environment (no flag).
- **`--claude-code`** — reuse your Claude Code auth (no key needed).
- **`--bedrock` / `--vertex`** — cloud provider auth.
- **`CLAIMCHECK_ARGS`** — env var for persistent default flags, e.g. `export CLAIMCHECK_ARGS="--bedrock"`; per-run CLI flags override it.

Other model/mode flags (`--model`, `--single-prompt`, …) forward to claimcheck — run `claimcheck --help` for the current set rather than memorizing them.

## Verdicts and how to fix each

| Verdict | Meaning | Fix |
| --- | --- | --- |
| **confirmed** | the spec faithfully expresses the contract | nothing — record it as a vetted guarantee |
| **disputed** | the spec says less/other than the contract (report gives a `weakeningType` + the discrepancy) | an **intent question — surface it to the user**, don't auto-resolve: show them the report's back-translation (what the formal spec actually says in English) next to their contract. Default direction: treat the `//@ contract` as ground truth and strengthen the formal spec toward it; never soften the contract to match the spec without the user's sign-off (you'd be making both sides agree about the wrong thing) |
| **gap** | a `//@ contract` with no `//@ requires`/`//@ ensures` backing it | mechanical — draft the `//@ requires`/`//@ ensures` that back the claim, or drop the contract |
| **unchecked** | a backed contract with no verdict — its round-trip result never came back (LLM/backend failure) | re-run claimcheck; an unchecked contract is not vetted |

The loop: `lsc check` (green) → `lsc claimcheck` → fix each **gap**, resolve each **disputed** with the user → `lsc check` again (any spec change must re-verify) → re-run claimcheck until only **confirmed** remains.

## Caveats

- **Exit code does not reflect findings.** A run with disputed contracts or gaps still exits `0` — non-zero is reserved for usage/file errors. CI **cannot gate on the exit code**; parse `*.guarantees.json` (`summary.disputed`, `summary.gaps`) instead.
- **Meaning, not proof.** claimcheck never runs Dafny. Green claimcheck on an unverified file proves nothing — always `lsc check` first.
- **It's an LLM judgment.** Verdicts are a model round-trip, not a theorem. Treat a **disputed** as a prompt to look, not a proof of a bug; a **confirmed** narrows, but doesn't eliminate, the intent–proof gap.
