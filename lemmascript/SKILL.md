---
name: lemmascript
description: LemmaScript verification toolchain for TypeScript (Dafny backend only). Use when working inside any directory that holds any file or workflow involving LemmaScript. This is the main LemmaScript skill which precedes all others. You must load this skill before writing, annotating, generating, or verifying TypeScript code with LemmaScript, or when deciding whether a piece of TypeScript is a good candidate for verification.
---

# LemmaScript (Dafny Backend)

LemmaScript compiles annotated TypeScript to Dafny for formal verification. The TypeScript runs unchanged in production; the generated Dafny proves correctness properties.

**Use the Dafny backend.** Lean/Velvet exists but is _deprioritized_ — don't reach for Lean commands or setup unless the user explicitly asks. Pin each file to Dafny with a `//@ backend dafny` directive on line 1 (see Workflow) rather than relying on the CLI default.

The grammar is not repeated here — it varies per release and lives in the shipped [reference/SPEC.md](reference/SPEC.md). This skill teaches the loop and the traps and points to the spec for everything enumerable.

## Is this a fit for LemmaScript?

Before annotating, check two things:

- **In the fragment?** LemmaScript verifies pure, deterministic logic over data — arithmetic, collections, state machines, invariants. Out of model: regex, I/O, network, randomness, floating-point, the DOM/UI. You can wrap an out-of-fragment callee in `havoc`/`extern` and verify around it — but if the interesting part *is* the regex/IO, there's nothing to prove.
- **A property where correctness matters to the app domain?** Verification pays where a specific, non-obvious correctness fact matters: money never lost, an invariant never violated, a state machine never reaching a bad state, access never wrongly granted, etc. Glue with no property worth stating (formatting, field-shuffling, wiring) → skip it. The best candidates are ones where the proof captures the algorithmic insight or business logic, not plumbing.

For a whole app, the "verified core" is the domain logic; the shell (UI, I/O, auth) stays unverified — never claim "verified end-to-end." Turning that split into a spec is the [lemmascript-design-doc](../lemmascript-design-doc/SKILL.md) skill's job.

## Workflow

MUST Put `//@ backend dafny` on the first line of every source file. That pins the file to the Dafny backend (a run targeting another backend skips it), and Dafny is already the default — so you never pass `--backend` on the command line.

MUST Create a `LemmaScript-files.txt` in the root of your project with the paths to every file that should be verified or that has a `//@ verify` annotation (one path per line). Running `lsc gen|gen-check|check` with *no file argument* batches over it — this is what CI runs. Batch behavior and flags: SPEC §7.

Naming convention (recommended but not enforced -- a user can override by request):
- `foo.verify.ts` is the annotated source;
- `foo.verify.dfy.gen` is auto-generated Dafny (never edit), produced from `foo.verify.ts`;
- `foo.verify.dfy` is a copy of `.dfy.gen` plus your proof additions.
- The diff between `.dfy.gen` and `.dfy` must be **additions-only** — insert lemmas, ghost predicates, asserts, invariants; never modify or delete a generated line (`lsc check` enforces additions-only).

(`lsc` names artifacts off the source basename: `foo.verify.ts` → `foo.verify.dfy.gen` + `foo.verify.dfy`, both alongside the source. The `.verify` marker isn't required — plain `foo.ts` works too — but it makes verified sources easy to glob for `LemmaScript-files.txt` and to spot next to shell code.)

### Filesystem layout

Two ways to set up the verified code. Either way, the generated `.dfy.gen` and proof `.dfy` sit **next to** their `.verify.ts`, and the unverified shell (UI, hooks, edge/server functions, I/O) imports the verified functions **directly — no adapter layer**.

**Single-file** — all verified logic in one module. Simplest; good for one cohesive domain.

```
src/
  domain.verify.ts        annotated source (the program)
  domain.verify.dfy.gen   generated Dafny — never edit
  domain.verify.dfy       generated + your proofs (additions-only)
  app.tsx, useDomain.ts   unverified shell — imports from domain.verify.ts
LemmaScript-files.txt      lists: src/domain.verify.ts
```

**Modular** — several `*.verify.ts` modules, each with its own generated + proof pair, all listed in `LemmaScript-files.txt`. A call from one verified module into another is emitted as an opaque axiom carrying the callee's `//@ requires` / `//@ ensures` (SPEC §2.9), so each module is proved independently and callers reason against the *contract*, not the body. Good for true multi-module apps, or when a verified module is a library used by several shells. The shell imports the verified modules directly.

```
src/
  verified/
    booking.verify.ts     booking.verify.dfy.gen     booking.verify.dfy
    inventory.verify.ts   inventory.verify.dfy.gen   inventory.verify.dfy
  ui/  hooks/  server/    unverified shell — imports from verified/*.verify.ts
LemmaScript-files.txt      lists: src/verified/booking.verify.ts
                                  src/verified/inventory.verify.ts
```

Inside a file:
1. Write TypeScript with `//@` annotations (kinds: SPEC §2.1; expression grammar: SPEC §2.2 + §3).
2. `lsc check <foo.verify.ts>` — generates the Dafny (`foo.verify.dfy.gen`), seeds `foo.verify.dfy` on the first run, enforces the additions-only gate, and verifies. This is the loop, not raw `dafny verify`.
3. Iterate on the **proof**: add helpers (lemmas, invariants, asserts) in `foo.verify.dfy` and re-run `lsc check`. Editing only the `.dfy` is a `check`.
4. When you change the **`.ts`**, the generated Dafny changes — run `lsc regen <foo.verify.ts>`, which merges the new generated code into your `foo.verify.dfy` (preserving proof additions) and verifies. Run `regen` *before* any `check`: `check` regenerates `.dfy.gen` and destroys the merge base `regen` needs.

## Edit boundaries

The `.ts` is the source of truth for **the program**; the `.dfy` is the source of truth for **the proof**. The `.dfy.gen` is disposable — a wrong `.gen` is fixed in the `.ts`, never edited directly.

**Additions-only trap.** Appending a trailing comment to a generated line (e.g. `{  // note`) counts as a *modified* line and fails the gate — put comments on their own new line.

**Regen, don't rm.** Never `rm *.dfy* && lsc gen` — that drops every proof addition. `regen` does a three-way merge and preserves them.

**Stale `.dfy.base` cascade.** A failed `regen` (CONFLICT or verification FAILED) leaves a stale `foo.verify.dfy.base` on disk; the next `regen` anchors on it and mis-merges, appending duplicate declarations → a cascade of `Error: Duplicate member name: ...`. Fix: `rm -f *.dfy.base` and regen again. Keep `*.dfy.base` out of version control.

**`ensures` for caller composition.** A `//@ ensures` emits a separate `<fn>_ensures` *lemma*; the generated Dafny *function* carries only `requires`/`decreases`. A *function* caller can't invoke a lemma, so it can't see a callee's postcondition. Fix: hand-add the `ensures` to the generated function as an addition (own new lines, above the `{`) — Dafny discharges it inline against the body, even recursively.

## Verification iteration

- Single-lemma iteration is far faster than the whole file: `dafny verify --filter-symbol=<lemma> domain.verify.dfy`.
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

## Don't patch the toolchain

- **Never edit `reference/`.** It is a machine-synced, read-only snapshot of the release (spec + compiler source). Edits there have no effect on the installed binary.
- **Never patch the installed `lemmascript` package or a local compiler checkout** unless the user explicitly asks. A suspected `lsc`/compiler bug is a bug report, not a local patch (see the upstream-issues skill). Workarounds belong in your `.ts`/`.dfy`, never in the tool.
- If you find a suspected bug, minimize a repro and optionally (only with user consent) file an issue or PR against [midspiral/LemmaScript](https://github.com/midspiral/LemmaScript). 

## Reference

`reference/SPEC.md` is the grammar, type mapping, and backend behavior — consult it before using an annotation you haven't used before. `reference/src/` is the release's compiler source; consult it when the emitted Dafny is surprising. `lsc extract domain.verify.ts` prints the Raw IR JSON, which is what the pipeline's front end produced. If `lsc` is missing on PATH: `npm i -g lemmascript`.

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
