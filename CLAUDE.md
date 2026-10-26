# Working on A2B with Claude

These rules are for Claude sessions working in this repository. Contributors: see CONTRIBUTING.md.

## Changes go straight to `main` (while the repository is private)

The owner has asked for direct pushes for now, until A2B is made public again.

- Commit to `main` and push it. Keep each commit to one change, with a message that says what and why.
- Before pushing: `npm test` passes, and anything visual or on the road has been tried in a browser.
- Tell the owner in the chat what changed and what was deployed.
- When the owner makes the repository public again, go back to pull requests: each change on its own
  `claude/<short-topic>` branch, a pull request against `main` that fills in `.github/pull_request_template.md`,
  and deploying only after the owner merges.

## Deploying

- The live app (https://a2b-beta.pages.dev) only ever runs what's on `main`. Deploy from `main` once the change
  is pushed: pull, run `npm test`, then `npm run deploy`.
- The shop search files in `public/places/` aren't in git. Before deploying from a fresh checkout, build them
  (`pip install duckdb && npm run places`), or the deploy removes shop search from the live app. The predeploy
  step prints which data it found.
- Database changes go in a new file in `migrations/`; apply it with `npx wrangler d1 migrations apply a2b --remote`
  before deploying code that needs it.
- Never print, echo or commit the Cloudflare API token or other secrets.

## Monthly map data

A scheduled task checks for a new Overture Maps release each month. When there is one, it rebuilds the data,
commits it to `main`, deploys, and reports back (while the repository is private; once public, it opens a pull
request and deploys after the owner merges it).
