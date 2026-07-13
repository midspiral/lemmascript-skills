---
name: lemmascript-claimcheck
description: Audit a LemmaScript function's plain-English `//@ contract` against its formal `//@ requires`/`//@ ensures` via an LLM round-trip. Use when writing `//@ contract` intent, refining a spec before proof work begins, checking that a spec actually means what it claims, or running/interpreting `lsc claimcheck`.
---

# LemmaScript claimcheck

LemmaScript proves the formal spec; it can't prove the spec *means* what you intended. A function can verify green yet guarantee less — or other — than its prose describes. `claimcheck` finds and closes that gap: it informalizes the `//@ requires`/`//@ ensures` back to English **blind** (without seeing your `//@ contract`), then compares the back-translation to the contract.

This is a companion to the core [lemmascript](../lemmascript/SKILL.md) skill — read that first for the verify loop.

## Run it before proof work, not after

claimcheck reads **only the TS annotations** — it never runs Dafny and needs no generated artifacts, so it works on a file before any proof exists (even with stub bodies). Its verdicts are a pure function of the `//@ contract`/`//@ requires`/`//@ ensures` lines.

Use that: vet the spec against the intent **before** investing in proofs. A spec change post-proof is the most expensive edit in the pipeline (regen, merge, proof rework); a spec change pre-proof is a one-line edit. The order is: write annotations → `lsc claimcheck` → fix disputes/gaps → then `lsc check` and prove a spec that's been vetted against intent.

Two things follow:

- A **confirmed** verdict pre-proof means the formal spec matches the English intent — it becomes a *guarantee* only once `lsc check` passes. The output file is named `*.guarantees.*` either way (current-version quirk): treat a pre-proof run's output as a spec review, not a trust manifest, until verification is green.
- No re-run is needed after proof work **unless the annotations changed**. If proving forced a spec change (a discovered `requires`, a weakened `ensures`), that's exactly when to re-run.

## Write the contract

Put one plain-English `//@ contract` line beside the formal spec. It's natural language, not a spec expression — the provers ignore it entirely (it never reaches the generated Dafny). `lsc extract` carries it in the Raw IR (SPEC §2.13).

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

`lsc claimcheck` forwards to `lemmascript-claimcheck`, which shells `lsc extract` for the contracts and runs the blind round-trip. For `domain.verify.ts` it writes `domain.verify.guarantees.md` (human-readable) + `domain.verify.guarantees.json` (machine-readable) next to the source, and prints a one-line summary (`N confirmed, M disputed, K gaps`). Pre-proof, that output is your spec review; once `lsc check` is green on the same annotations, it doubles as the trust manifest.

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
| **confirmed** | the spec faithfully expresses the contract | nothing — the spec is vetted; it becomes a guarantee when `lsc check` passes |
| **disputed** | the spec says less/other than the contract (report gives a `weakeningType` + the discrepancy) | an **intent question — surface it to the user**, don't auto-resolve. Default direction: treat the `//@ contract` as ground truth and strengthen the formal spec toward it; never soften the contract to match the spec without the user's sign-off (you'd be making both sides agree about the wrong thing) |
| **gap** | a `//@ contract` with no `//@ requires`/`//@ ensures` backing it | mechanical — draft the `//@ requires`/`//@ ensures` that back the claim, or drop the contract |

The loop: write annotations → `lsc claimcheck` → fix each **gap**, resolve each **disputed** with the user → re-run until only **confirmed** remains → `lsc check` and prove. If proof work later changes any annotation, re-run claimcheck.

## Caveats

- **Exit code does not reflect findings.** A run with disputed contracts or gaps still exits `0` — non-zero is reserved for usage/file errors. CI **cannot gate on the exit code**; parse `*.guarantees.json` (`summary.disputed`, `summary.gaps`) instead.
- **Meaning, not proof.** claimcheck never runs Dafny. Confirmed verdicts vet the spec against the intent; only a green `lsc check` turns them into guarantees.
- **It's an LLM judgment.** Verdicts are a model round-trip, not a theorem. Treat a **disputed** as a prompt to look, not a proof of a bug; a **confirmed** narrows, but doesn't eliminate, the intent–proof gap.
