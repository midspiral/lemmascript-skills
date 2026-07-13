---
name: lemmascript
description: LemmaScript verification toolchain for TypeScript (Dafny backend only). Use when writing, annotating, generating, or verifying TypeScript code with LemmaScript.
---

# LemmaScript (Dafny Backend)

LemmaScript compiles annotated TypeScript to Dafny for formal verification. The TypeScript runs unchanged in production; the generated Dafny proves correctness properties.

**Use the Dafny backend.** Lean/Velvet exists but is _deprioritized_ — don't reach for Lean commands or setup unless the user explicitly asks. Pass `--backend=dafny` explicitly on every command (the default has been flipped before).

The grammar is not repeated here — it varies per release and lives in the shipped [reference/SPEC.md](reference/SPEC.md). This skill teaches the loop and the traps and points to the spec for everything enumerable.

## Workflow

1. Write TypeScript with `//@` annotations (kinds: SPEC §2.1; expression grammar: SPEC §2.2 + §3).
2. `lsc check --backend=dafny domain.ts` — generates the Dafny, enforces the additions-only gate, and verifies. This is the loop, not raw `dafny verify`.
3. Iterate: fix annotations in the `.ts`, or add proof helpers (lemmas, invariants, asserts) in the `.dfy`. Re-run `lsc check`.
4. After changing the TS, `lsc regen --backend=dafny domain.ts` merges the new generated code into your `.dfy`, preserving proof additions.

For every project, create a `LemmaScript-files.txt` file in the root with the paths to every file that should be verified or that has a `//@ verify` annotation (one path per line); running `lsc gen|gen-check|check` with *no file argument* batches over it — this is what CI runs. Batch behavior and flags: SPEC §7.

## File layout and edit boundaries

- `domain.ts` — annotated source; the source of truth for **the program**.
- `domain.dfy.gen` — auto-generated Dafny. **Never edit** (the `.gen` extension is the signal). A wrong `.gen` is fixed in the `.ts`, not here.
- `domain.dfy` — a copy of `.dfy.gen` plus your proof additions; the source of truth for **the proof**.

The diff between `.dfy.gen` and `.dfy` must be **additions-only** — insert lemmas, ghost predicates, asserts, invariants; never modify or delete a generated line. `lsc check` enforces this. Trap: appending a trailing comment to a generated line (e.g. `{  // note`) counts as a *modified* line — put comments on their own new line.

**Regen, don't rm.** Never `rm *.dfy* && lsc gen` — that drops every proof addition. `regen` does a three-way merge and preserves them.

**Stale `.dfy.base` cascade.** A failed `regen` (CONFLICT or verification FAILED) leaves a stale `domain.dfy.base` on disk; the next `regen` anchors on it and mis-merges, appending duplicate declarations → a cascade of `Error: Duplicate member name: ...`. Fix: `rm -f *.dfy.base` and regen again. Keep `*.dfy.base` out of version control.

**`ensures` for caller composition.** A `//@ ensures` emits a separate `<fn>_ensures` *lemma*; the generated Dafny *function* carries only `requires`/`decreases`. A *function* caller can't invoke a lemma, so it can't see a callee's postcondition. Fix: hand-add the `ensures` to the generated function as an addition (own new lines, above the `{`) — Dafny discharges it inline against the body, even recursively.

## Verification iteration

- Single-lemma iteration is far faster than the whole file: `dafny verify --filter-symbol=<lemma> domain.dfy`.
- Final pass: run whole-file once and read the summary with `tail -50` — not `grep`, which can hide errors outside your pattern.
- `--isolate-assertions` breaks down which conjunct of a multi-part lemma fails; `--verification-time-limit=<sec>` when 30s isn't enough.

### Nonlinear arithmetic

Goals multiplying/dividing variables (`(m*p)/p == m`, `x<=y ==> x*p<=y*p`) are nondeterministic in Z3 and hand-rolled induction doesn't rescue them. Import Dafny's standard library instead of proving them yourself:

```dafny
import opened Std.Arithmetic.Mul
import opened Std.Arithmetic.DivMod
```

`lsc` auto-adds `--standard-libraries` whenever the `.dfy` text contains the substring `Std.`, so the `import opened` (inserted as an addition) is all you need. Euclidean identities and small distributivity are reliable inline; reserve the library for cancellation and monotonicity.

## Annotation pitfalls

- **`assume` is not a proof shortcut.** It tells the verifier to trust `P` unconditionally. Legitimate only to constrain a `havoc`'d value (whose true behavior is outside the LS fragment). Don't use it to paper over an obligation, or `assume false` to silence a `throw` path — characterize the valid domain in `requires` instead.
- **`havoc` / `assume` are Dafny-only.** `havoc` marks a RHS nondeterministic; the Lean backend rejects it. Pair with `assume` to constrain the result (SPEC §2.10).
- **`extern` is the deterministic cousin of `havoc`** — for callees out of model (regex, IO, parsers) that callers should reason *parametric over*; the axiom is extensional, so `f(x) == f(x)` holds (SPEC §2.11).
- **No `\old(...)` in annotations.** In `ensures`, `this.field` is the post-state; add pre-state `old(this.field)` as a `.dfy` addition (SPEC §2.8).
- **Empty lemma body means *proven*.** `lemma foo() ensures P {}` is discharged by Z3 — not skipped. Only `assume`/`havoc`/weak specs side-step the verifier.
- **Regex is out of the model.** `RegExp`/`.match`/`.replace(regex,…)` can't be verified — rewrite without regex, or wrap it behind `havoc`/`extern` and verify the surrounding logic.

## Brownfield (existing TS)

- Add `//@ verify` to the functions you want checked. As soon as *any* function has it, `lsc` switches to opt-in mode and silently skips the rest (types and `const`s are always extracted). SPEC §2.6.
- For out-of-fragment callees you still want to reason about: `//@ extern` (deterministic) or `//@ havoc` (nondeterministic).
- **In-place means in-place.** Add annotations only — don't refactor, restructure control flow, or rename. The verified function and the shipping function stay byte-for-byte identical.

## Verified-core pattern

Domain logic lives in one or more verified modules imported *directly* by the UI, hooks, and edge functions — no adapter layer between verified core and callers. Modular is fine; it need not be a single `domain.ts`.

## Don't patch the toolchain

- **Never edit `reference/`.** It is a machine-synced, read-only snapshot of the release (spec + compiler source). Edits there have no effect on the installed binary.
- **Never patch the installed `lemmascript` package or a local compiler checkout** unless the user explicitly asks. A suspected `lsc`/compiler bug is a bug report, not a local patch (see the upstream-issues skill). Workarounds belong in your `.ts`/`.dfy`, never in the tool.

## Reference

`reference/SPEC.md` is the grammar, type mapping, and backend behavior — consult it before using an annotation you haven't used before. `reference/src/` is the release's compiler source; consult it when the emitted Dafny is surprising. `lsc extract domain.ts` prints the Raw IR JSON, which is what the pipeline's front end produced. If `lsc` is missing on PATH: `npm i -g lemmascript`.

## Examples

Worked, currently-verifying case studies under github.com/midspiral. Consult one at your discretion when the emitted Dafny surprises you or you need the idiom for a specific shape — each is picked for a *distinct* technique, so open the one whose row matches your problem. Not required reading.

| Repo | Read it for |
| --- | --- |
| [balanced-match-lemmascript](https://github.com/midspiral/balanced-match-lemmascript/blob/HEAD/src/index.ts) | Smallest complete example: in-place brownfield of a real npm lib (one `src/index.ts` + `.dfy`); regex path handled out-of-model. |
| [quorum-lemmascript](https://github.com/midspiral/quorum-lemmascript/blob/HEAD/src/domain.ts) | Greenfield app core, multi-module (`domain.ts` + `grid.ts`); a counting/aggregation kernel proven exact; one verified core runs in browser and server. |
| [quota-lemmascript](https://github.com/midspiral/quota-lemmascript/blob/HEAD/src/domain.ts) | Greenfield capacity/contention core: the load-bearing fact is a *bound* (never oversold), inductive `ensures` composed in the companion `.dfy`. |
| [hono-rate-limiter-with-lemmascript](https://github.com/midspiral/hono-rate-limiter-with-lemmascript/blob/HEAD/src/core.verified.ts) | A temporal-arithmetic invariant ("never more than `limit` in any window `W`", incl. the boundary seam); good for arithmetic-heavy bounds. |
| [node-casbin-lemmascript](https://github.com/midspiral/node-casbin-lemmascript/blob/HEAD/src/util/keyMatch.ts) | Large modular brownfield of a real access-control library (util/model/effect); string-matching helpers show the `extern`/`havoc` fragment boundary. |
| [guardians-lemmascript](https://github.com/midspiral/guardians-lemmascript/blob/HEAD/src/taint_core.ts) | Security/taint tracking with source→sink; tool behavior passed as higher-order params so theorems hold for *any* assignment (parametric proofs). |
| [henri-lemmascript](https://github.com/midspiral/henri-lemmascript/blob/HEAD/src/permissions.ts) | Carving a pure verified decision-core out of effectful agent glue; permission soundness, path-traversal containment, grant monotonicity. |
| [flue-lemmascript](https://github.com/midspiral/flue-lemmascript/blob/HEAD/packages/runtime/src/conversation-reducer.ts) | How a verified core sits inside a real multi-package monorepo (`packages/runtime`): reducers, compaction, usage. |
