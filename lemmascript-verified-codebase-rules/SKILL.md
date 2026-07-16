---
name: lemmascript-verified-codebase-rules
description: Rules for working in a codebase that contains LemmaScript-verified files. Applies to ANY change in such a repo — UI, API endpoints, hooks, refactors, config — not just verification work; the edits most likely to erode the verification boundary are the ones that never mention it. If the repo has a LemmaScript-files.txt, files with //@ annotations, or .dfy files alongside TypeScript, these rules bind.
---

# Rules for a Verified Codebase

A LemmaScript codebase is split in two: a **verified core** whose behavior is
mathematically proven against its specs, and an **unverified shell** (UI,
network, storage, routing) that calls it. The proofs only mean something as
long as the shell actually routes every decision through the core. These
rules keep that true. They bind whatever you were asked to do — a button fix
or an endpoint can erode the boundary just as surely as a bad proof.

This skill covers working *around* the boundary. For working *inside* it —
annotations, proofs, `lsc` workflow — use the core `lemmascript` skill. If there are no verified files yet and you are asked to build something verified, start with `lemmascript-design-doc`.

## Detecting the boundary

The repo declares it — don't guess:

- **`LemmaScript-files.txt`** (project root) is the machine-readable
  boundary: every file listed is verified core; everything else is shell.
- Secondary signals if it's missing: `//@` annotations in a `.ts` file, or
  `.dfy` / `.dfy.gen` siblings next to a source file. (A common convention
  is a `.verify.ts` suffix, but the list, not the name, is authoritative.)

These rules apply at any stage — the boundary exists as soon as the first
annotated file does, whether or not the whole codebase is "done."

## The rules

### 1. Derivations come from the core

If shell code needs a count, a comparison, a filter, a ranking, or any other
derivation from state, it calls a function exported from the verified core.
Never recompute it in a component, hook, endpoint, or utility file — a
`filtered.length` in the shell is a second, unverified implementation of a
verified fact, and the two will drift. Do not allow this to happen. 

### 2. State changes only through verified transition functions

If the core exports transition/apply functions, they are the only place
state mutates. Shell code constructs the operation data and hands it over
(e.g. a store's `dispatch` calling a verified `applyOp`); it never mutates
state directly or maintains its own derived copy of it.

### 3. Import the core directly — typically no wrapper

Shell code (UI, hooks, edge/server functions) typically imports verified
functions directly, with no adapter layer (see the core `lemmascript`
skill). Don't introduce a wrapper on your own initiative: one that reshapes,
filters, or "adjusts" a core result inserts unverified logic between the
proof and its use — the caller now trusts the wrapper, not the theorem.
Legitimate exceptions exist: 
- the user explicitly asks for a wrapper
- runtime checks at the boundary (e.g. `lemmascript-guard`, the runtime guard
plugin, works through a wrapper), or similar
- Thin re-exports and view formatting

A wrapper that changes what the value *means* is not your decision, the user needs to approve.

### 4. New decision-making logic goes inside the boundary

If the change you're making needs new logic that *decides* something about
domain state, it belongs in a verified file, annotated and verified **before**
the shell uses it — follow the core `lemmascript` skill for the whole
workflow. Don't land it in the shell "for now"; unverified logic never
migrates inward on its own.

### 5. Never shrink the boundary to unblock yourself

- Do not move code out of a verified file, remove a file from
`LemmaScript-files.txt`, or weaken a spec (`ensures`, an invariant) to get
past a failing proof or to make shell work easier. Each of those deletes a
guarantee someone may be relying on. If a proof genuinely blocks you, that's a decision for the user, not an agent workaround — surface it.

### 6. Leave the gate green

`lsc check` with no argument batches over `LemmaScript-files.txt`; that is
the CI gate. Whatever you changed, it must still pass before you're done —
including changes that "couldn't possibly" affect the core (moves, renames,
tsconfig, dependency bumps all can).

## Common mistakes

- Recomputing a derived value in the shell (an `array.reduce` in a
  component instead of the core's verified query) — rule 1
- A second source of truth for derived state (a "count" variable maintained
  in the UI alongside the core's state) — rules 1–2
- Wrapping the core in an unverified "helper" that post-processes its
  results before the shell sees them, without being asked to — rule 3
- Landing decision logic in a hook/endpoint "temporarily" — rule 4
- "Fixing" a failing build by dropping a file from `LemmaScript-files.txt`
  or commenting out an annotation — rule 5
