---
name: lemmascript-proof-review
description: Audit verified proofs against the design document. Run in a clean agent with no prior context. Reads domain.ts, domain.dfy, domain.dfy.gen, and DESIGN.md. Produces PROOF_FINDINGS.md. Does not change code.
---

# Proof Review

Audit the verified domain proofs against the design document. This skill is
designed to run in a **fresh agent with no context** — it reads all files from scratch and produces an independent assessment. An example can be found in this folder: PROOF_FINDINGS.md

## Instructions

1. Read these files in order:
   - `DESIGN.md` (the spec: what was promised)
   - `src/domain.ts` (the annotated TypeScript: what was written)
   - `src/domain.dfy.gen` (the generated Dafny: what LemmaScript produced)
   - `src/domain.dfy` (the working Dafny: what proofs were added)

2. Run `dafny verify src/domain.dfy` and record the result.

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

### Design-Doc Claims: Status Table
A table mapping each claim from DESIGN.md §2 (the promise) and §7 (properties)
to one of:
- **Supported**: proof matches the claim
- **Partially supported**: proof covers part of the claim; state what's missing
- **Not yet supported**: no proof; state what would be needed

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
  - What the invariant (`wellFormed`) actually includes vs what the design says it should
  - What an `ensures` clause says vs what the design doc's spec sketch says
  - What's proven for the implemented model vs what the design defers to trusted shell
- Call out any `//@ assume` usage (these bypass proof obligations).
- Call out any `//@ havoc` usage (these mark code as unverified).
- Note if `wellFormed` is weaker than DESIGN.md's stated invariant conditions.
- Note if any property family from DESIGN.md has no corresponding verified function.
- If the design doc lists staged proofs with status markers, check that the
  "verified" stages actually verify (they're in the .dfy and pass).

## Tone

Technical and precise. Not adversarial — the goal is to help the team know
exactly what they can claim. Frame gaps as "not yet" rather than "missing."
