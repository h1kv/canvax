# Contributing to DISPATCH.AI

Thanks for being here — contributions of every kind genuinely move this project
forward: code, bug reports, docs, tests, and ideas. DISPATCH.AI is built in the
open by a small team, so help matters more than usual.

## Ways to contribute

- **Report a bug** — open an issue with steps to reproduce, what you expected,
  and what happened (screenshots / console logs help a lot).
- **Suggest a feature** — open an issue describing the problem you're trying to
  solve, not just the solution.
- **Improve docs** — typos, clarifications, and examples are always welcome.
- **Send a PR** — see the workflow below.

## Development setup

```bash
git clone https://github.com/h1kv/dispatch-tooling.git
cd dispatch-tooling
npm install
cp .env.example .env     # add at least one provider key
npm run dev              # http://localhost:3000
```

You only need a model-provider key (OpenAI, Anthropic, or Google) to run chains.
Voice control and the Deploy node need their own optional keys — see
[`.env.example`](.env.example).

## Project layout

A quick map (full version in the [README](README.md#architecture)):

- `src/whiteboard/` — the React canvas app (components, hooks, render).
- `server/features/` — backend: `chat/`, `execution/`, `state/`, `ws/`.
- `shared/` — node registry + types shared by client and server.
- `skills/` — markdown definitions of node behaviour.
- `tests/` — the test suite (`node --test`).

## Pull request workflow

1. **Fork** and create a branch: `git checkout -b feat/short-description`.
2. **Make focused changes** — one logical change per PR is much easier to review.
3. **Run the checks** before pushing:
   ```bash
   npm test
   npx tsc --noEmit     # type-check
   ```
4. **Write a clear description** — what changed, why, and how to test it. Link
   any related issue.
5. **Open the PR** against `main`.

## Coding guidelines

- **TypeScript first.** Keep `npx tsc --noEmit` clean.
- **Match the surrounding style.** Read nearby code before adding new code.
- **Keep it small and clear.** Prefer readable code over clever code; avoid
  adding dependencies unless they clearly earn their place.
- **No secrets in commits.** `.env` is gitignored — never commit real keys.
- **Tests for behaviour changes.** Add or update a test when you change how
  something works.
- **Conventional-ish commits.** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:` prefixes keep the history readable.

## Adding or changing nodes

Node types live in [`shared/nodeRegistry.ts`](shared/nodeRegistry.ts); their
behaviour is described in [`skills/`](skills/). If you add a node, register it in
both places and add a short test.

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind.

## Questions

Open a [discussion or issue](https://github.com/h1kv/dispatch-tooling/issues) —
no question is too small.
