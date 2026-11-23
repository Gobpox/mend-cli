# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Gobpox/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Gobpox/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. Models write edits as
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A
patches and JSON tool calls; mend reads all four to one specification
(`SPEC.md`), finds the lines each edit names at the first of three matching
tiers — exact, trailing-whitespace drifted, indentation drifted — and
writes every change or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the root of the tree of text files. The patch
comes from the PATCH file, or from standard input when PATCH is absent or
`-`. `--format` is one of `unified`, `search-replace`, `v4a`, `json` or
the default `auto` (detect from the patch text). `--check` reports what
would change without writing; `--strict` matches lines exactly only.

Output is one line per changed path (`A`, `D`, `M`, or `R old -> new` for
a move) followed by `ok: <n> files`; a failed patch prints one
`error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`
and writes nothing. Usage, unreadable-patch, format and parse failures are
single `error: …` lines at exit 2.

## Layout

- `main.ts` — the whole CLI: Node 22, standard library only.
- `runner.ts` — the make.fun kit's trial runner (kept as handed out);
  `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs `main.ts` against the public practice set.
- `SPEC.md` — the specification mend implements, section by section.

Scores 100/100 on the public practice checks.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ab6123w1&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
