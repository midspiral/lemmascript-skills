---
name: lemmascript-proof-review
description: Milestone audit of verified LemmaScript proofs against the design document — run at a stopping point (before release, sealing, or making external claims; after a major proof push), not in the edit-prove loop. Runs in a clean agent with no prior context, after lsc check is green and claimcheck has been run. Re-verifies, inventories the trust surface (assume/havoc/extern/skip/autohavoc/selective verify), checks //@ contract coverage and claimcheck artifacts, and produces PROOF_FINDINGS.md. Does not change code.
---

# Proof Review

Audit the verified domain proofs against the design document. This skill is
designed to run in a **fresh agent with no context** — it reads all files from
scratch and produces an independent assessment. An example report is in this
folder (`PROOF_FINDINGS.md`); it illustrates the format and tone, but predates
the Trust Surface and Intent Coverage sections below — follow the structure
here, not the example's.

## When to run

This is a **milestone audit**, not an inner-loop check. It sits at the end of
the chain, after the cheaper gates have already passed:

1. `lsc check` green — code ⊨ spec (every edit; the inner loop)
2. `lsc claimcheck` clean — spec ⊨ intent, per function (when annotations change)
3. **Proof review** — the whole chain ⊨ the product promise (at stopping points)

Run it when the answer matters and the state is stable:

- Before making an **external claim** about what's verified (README, marketing,
  a customer conversation) — Safe External Wording is the deliverable
- Before a **release or sealing** the verified files
- After a **major proof push** lands (a new property family, a stage of the
  design doc's roadmap flips to "verified")
- When the **design doc changes materially** — the claims table is stale the
  moment the promise moves

Do not run it per-edit or per-proof-iteration: it re-reads everything from
scratch by design, so its cost is only justified when the codebase is at a
stopping point. Findings between audits belong in the loop (fix the proof,
re-run claimcheck), not in a fresh PROOF_FINDINGS.md.

## Instructions

1. Read these, in order:
   - The design document (the spec: what was promised)
   - Every verified `.ts` file — the project's `LemmaScript-files.txt` lists
     them; otherwise glob for files with `//@` annotations
   - For each verified file, its `.dfy.gen` (what LemmaScript produced) and
     `.dfy` (what proofs were added)
   - Any `*.guarantees.{json,md}` claimcheck artifacts, if present

2. Re-verify with `lsc check` — with no file argument it batches over
   `LemmaScript-files.txt`; otherwise run it per file. Record the result.
   **Do not substitute raw `dafny verify`**: it can pass on a stale `.dfy`
   that no longer corresponds to the current `.ts`, certifying proofs about
   code that isn't the code. `lsc check` regenerates, enforces the
   additions-only gate, and then verifies — that is the only honest baseline
   for an audit.

3. Produce `PROOF_FINDINGS.md` in the project root. Do not modify any code.

## PROOF_FINDINGS.md structure

### Executive Summary
2-3 paragraphs: what is proven, what is not, and the overall assessment.

### What Is Safely Guaranteed
One subsection per verified property family. For each:
- State what the proof establishes in precise language
- Reference the specific contracts (function names, ensures clauses)
- Note important limitations or caveats
- Distinguish between what the proof says and what the design doc claims

### Trust Surface Inventory
Everything that weakens or bypasses the verification model, each with its
justification or a flag. The annotation semantics live in the shipped
`reference/SPEC.md` (§ references below); consult its §2.1 table for the
full current annotation surface — don't assume this list is complete:

- `//@ assume` — bypasses a proof obligation (SPEC §2.3). Legitimate use is
  constraining a `//@ havoc`'d value; anything else deserves scrutiny.
- `//@ havoc` / `//@ havoc <key>` — value replaced by nondeterminism (§2.10)
- `//@ extern` — body replaced by an axiom (§2.11)
- Cross-file calls — auto-externed as opaque axioms (§2.9); the proof rests
  on the callee's *own* verification, so state which callees are trusted
- `//@ skip` — statement dropped from the model
- `//@ autohavoc` — every unmodellable expression havoc'd (§2.12)
- Selective `//@ verify` mode (§2.6) — **the silent one**: if any function in
  a file has `//@ verify`, every unmarked function is skipped entirely.
  "N verified, 0 errors" can hide that half the domain was never in the
  model. State what fraction of each file is actually verified.
- `//@ backend` (§2.7) — a file restricted to another backend is silently
  skipped under the current one; report any such files as unverified here

### Intent Coverage
The formal spec can verify and still not mean what the prose claims. Report:
- `//@ contract` coverage: which verified functions have a formal spec
  (`ensures`) but **no** `//@ contract`? Their specs have never been vetted
  against any stated intent — list them.
- If claimcheck artifacts (`*.guarantees.{json,md}`) exist: are they fresh
  (verdicts are a pure function of the annotation text — compare the
  contracts/requires/ensures in the artifact against the current source)?
  Fold any **disputed** or **gap** verdicts into the findings.
- If no claimcheck artifact exists, report that as a finding. Do **not** run
  `lsc claimcheck` yourself — it needs an LLM backend and spends tokens; the
  review is a read-only audit.

### Design-Doc Claims: Status Table
A table mapping each claim from the design doc's *promise* section and its
*properties catalog* (whatever sections play those roles — don't assume
numbering) to one of:
- **Supported**: proof matches the claim
- **Partially supported**: proof covers part of the claim; state what's missing
- **Not yet supported**: no proof; state what would be needed

Before marking a claim **Supported**, check it isn't vacuous:
- Is the `requires` satisfiable? A contract with an unsatisfiable
  precondition verifies everything and guarantees nothing.
- Is the `ensures` non-trivial — could it hold for a wrong implementation?
- **Co-vacuity**: were the design claim and the formal spec derived from the
  same guess? Two artifacts that agree can both be wrong; an independent
  fresh-context review exists precisely to catch this. Re-derive what the
  property *should* say from the product intent before comparing.

### Main Gaps
Numbered list of what's missing before the full product promise can be made.
For each gap, briefly state what would need to be proved.

### Safe External Wording
Draft a precise claim that matches exactly what the proofs establish. Then list
what should NOT be claimed yet.

## Rules

- **Do not change any code.** This is a read-only audit.
- Be precise: "the proof shows X" is different from "the code does X."
  Proofs are about the Dafny model. The TypeScript runs the same logic but
  the trust boundary is the TS→Dafny translation.
- Distinguish between:
  - What the invariant actually includes vs what the design says it should
  - What an `ensures` clause says vs what the design doc's spec sketch says
  - What's proven for the implemented model vs what the design defers to
    trusted shell code
- Note if any property family from the design doc has no corresponding
  verified function.
- If the design doc lists staged proofs with status markers, check that the
  "verified" stages actually verify (they're in the `.dfy` and pass).

## Tone

Technical and precise. Not adversarial — the goal is to help the team know
exactly what they can claim. Frame gaps as "not yet" rather than "missing."
