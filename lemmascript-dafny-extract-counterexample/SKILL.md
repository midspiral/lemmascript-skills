---
name: lemmascript-dafny-extract-counterexample
description: Diagnose failed LemmaScript Dafny proofs with --extract-counterexample. Use when investigating a failed proof, interpreting candidate inputs or intermediate states, or checking whether a counterexample reproduces a TypeScript bug.
---

# Counterexamples for failed proofs

Use Dafny's `--extract-counterexample` to inspect candidate states behind a failed proof:

```sh
dafny verify --extract-counterexample --filter-symbol=foo_ensures foo.dfy
```

Run this on the existing **proof `.dfy`**, including its proof additions. This command does not regenerate anything; use `gen`/`regen` first when the TS and proof artifacts need updating. When invoking Dafny directly, include `--standard-libraries` if the proof imports `Std.*`.

Select the actual emitted name in the proof file. A pure function's postcondition usually lives in `<fn>_ensures`; body obligations such as array bounds live in the function itself. Imperative functions carry their obligations in the Dafny method. Names can be escaped or freshened, so inspect the declarations rather than assuming the spelling. Omit `--filter-symbol` to inspect the whole file, or add `--isolate-assertions` to separate failures.

- **Treat the model as a diagnostic candidate.** It can expose a code bug, a missing invariant, or information lost through `havoc`/extern contracts. It can also be inconsistent or invalid; it is not proof of a runtime bug.
- **Read intermediate states and related locations.** Loop states can be hypothetical states allowed by the invariant. For example, `i = 1, count = 0` after a loop that increments both together suggests the missing invariant `count == i`. The entry input alone would hide that clue. Keep the synthetic loop guards when interpreting conditional states.
- **Validate concrete inputs before claiming a reproduced bug.** Check the original preconditions and replay the actual code when possible. Models may describe only part of an array and need not choose small values; distinguish printed values from values you supply to complete an input. A replay that satisfies the contract can still leave a useful proof-debugging candidate.
- **Do not paste the printed `assume` statements into the proof to make it pass.** Use the states to identify the needed code, contract, or proof change. No model, a timeout, or an unsuccessful extraction does not establish correctness; inspect the verifier's result.

Add `--json-output` for machine-readable diagnostics. In the tested Dafny 4.11.0, these are newline-delimited JSON records with structured error locations; the counterexample itself remains text inside the diagnostic's `defaultFormatMessage`.
