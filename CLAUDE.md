# Working on A2B with Claude

These rules are for Claude sessions working in this repository. Contributors: see CONTRIBUTING.md.

## Changes go through pull requests

- Never push to `main`; it's protected and only the owner merges into it.
- Make each change on its own branch (`claude/<short-topic>`), push the branch, and open a pull request against
  `main` that fills in `.github/pull_request_template.md`.
- Before opening it: `npm test` passes, and anything visual or on the road has been tried in a browser.
- Tell the owner the pull request link, and what to look at, in the chat.

## Deploying

- The live app (https://a2b-beta.pages.dev) only ever runs what's on `main`. Deploy after the owner has merged
  the pull request: check out `main`, pull, run `npm test`, then `npm run deploy`.
- The shop search files in `public/places/` aren't in git. Before deploying from a fresh checkout, build them
  (`pip install duckdb && npm run places`), or the deploy removes shop search from the live app. The predeploy
  step prints which data it found.
- Database changes go in a new file in `migrations/`; apply it with `npx wrangler d1 migrations apply a2b --remote`
  before deploying code that needs it.
- Never print, echo or commit the Cloudflare API token or other secrets.

## Monthly map data

A scheduled task checks for a new Overture Maps release each month. When there is one, it rebuilds the data on a
branch, opens a pull request, and deploys only after the owner merges it.
