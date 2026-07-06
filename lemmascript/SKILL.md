---
name: lemmascript
description: LemmaScript verification toolchain for TypeScript (Dafny backend only). Use when writing, annotating, generating, or verifying TypeScript code with LemmaScript.
---

# LemmaScript (Dafny Backend)

LemmaScript compiles annotated TypeScript to Dafny for formal verification. The TypeScript runs unchanged in production; the Dafny path proves correctness properties.

**This project uses the Dafny backend exclusively.** Do not use Lean-related commands or setup.

## Workflow

1. Write TypeScript with `//@` annotations
2. Generate Dafny: `npx lsc gen --backend=dafny src/domain.ts`
3. Verify: `dafny verify src/domain.dfy`
4. Iterate: fix annotations or add proof helpers in `.dfy`
5. Regenerate (preserves proofs): `npx lsc regen --backend=dafny src/domain.ts`

## Key Annotations

```typescript
//@ verify              // selective mode: verify ONLY marked fns (brownfield). Omit entirely for whole-file (greenfield).
//@ requires <expr>     // precondition
//@ ensures <expr>      // postcondition (\result = return value)
//@ invariant <expr>    // loop invariant
//@ decreases <expr>    // termination metric
//@ type <var> nat      // type override
//@ ghost let x = e     // proof-only variable
//@ assert <expr>       // inline assertion
```

## Expression Syntax in Annotations

- Implication: `A ==> B`
- Quantifiers: `forall(k, P)`, `exists(k: nat, P)`
- Return value: `\result`
- Standard operators: `===`, `!==`, `&&`, `||`, `!`, `>=`, `<=`, `>`, `<`

## File Layout (Dafny Backend)

- `file.ts` — annotated TypeScript source
- `file.dfy.gen` — auto-generated Dafny (never edit)
- `file.dfy` — working file for proofs (add lemmas here)

**Never** delete both `.dfy` files and regenerate — use `regen` to preserve proofs.

## Web App Pattern

Single `domain.ts` with verified logic imported directly by React UI, hooks, and edge functions. No adapter layer.

## Full Specification

For the complete annotation grammar, type mapping rules, and backend-specific behavior, see [reference/SPEC.md](reference/SPEC.md).

## Reference: spec and compiler source

`reference/` is a read-only snapshot of the LemmaScript release — the spec plus the compiler source. It is machine-maintained (synced from each release): never edit it. Edits there have no effect on the installed binary; if `lsc` seems wrong, that's a bug report or a version pin, not a local patch.

When the spec doesn't answer why `lsc` emitted something, read the pipeline source in `reference/src/`:

- `extract.ts` — TypeScript → Raw IR (what `lsc extract` prints)
- `resolve.ts`, `narrow.ts` — name resolution and Option narrowing rules
- `transform.ts` — IR → backend AST (`autohavoc.ts`, `peephole.ts` are companion passes)
- `dafny-emit.ts` — Dafny text emission; `dafny-commands.ts` — the gen/check/regen loop
- `lsc.ts` — CLI entry and commands

If `lsc` is missing on PATH: `npm i -g lemmascript` (also provides `lsc claimcheck`, which vets `//@ contract` prose against the formal spec).

## Example
One example of the domain.ts can be found in domain-example.ts
Other case studies exist in the following public repos:
- https://github.com/midspiral/equality-game-lemmascript/
- https://github.com/midspiral/henri-lemmascript


