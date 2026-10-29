# Trusted account access

## Problem and scope

Public signup did not verify email ownership, but `TESTER_EMAILS` granted both testing tools and owner access.
A local synthetic signup matching that allowlist could read `/api/stats` immediately. A regression expecting
404 reproduced the issue against upstream `134045a` before this change (actual response: 200).

## Changes

- Replace email-based grants with exact existing account IDs in `TESTER_USER_IDS` and `OWNER_USER_IDS`.
- Restrict usage, private feedback reads, and feedback close/reopen (including the legacy DELETE endpoint)
  to owners on the server. Testers retain demo tools and the capacity-limit bypass. Owners include tester access.
- Add a separate owner flag to `/api/me` and clear it on failed authentication refresh.
- Keep demo controls under Settings → Testing; show Usage and Feedback inbox only under Administration for owners.
- Document deliberate provisioning after trusted confirmation of an existing account ID. No email migration,
  schema change, production configuration, or new dependency is included.
- Replace synthetic email fixtures with synthetic ID grants and add signup, role separation, exact matching,
  revocation, and feedback authorization regression coverage.

## Validation

- Before the fix: the unverified-email signup regression failed because `/api/stats` returned 200.
- After the fix: focused signup, role separation, private feedback, and usage tests passed (4/4).
- `npm test`: 180 tests passed, no failures. `git diff --check` passed.
- Local Chrome component smoke used the real Worker with an in-memory D1 fixture and the actual Settings modules
  and styles. Verified guest and ordinary signup have no privileged controls, tester gets demo but no private
  inbox/usage, owner gets both, and revocation disables access and demo on refresh. Opened the inbox and usage
  panels successfully. No browser exceptions occurred. External requests were blocked; map boot was omitted.
- Checked 375 × 812 portrait and 812 × 375 landscape with reduced motion; Settings retained its width with
  enlarged root text and owner buttons were at least 44 CSS pixels high. Existing UI styles are unchanged.

## Owner review / rollout

The maintainer must confirm and provision trusted IDs as described in README before expecting privileged tools
to be available. Existing email grants intentionally stop working. No privileged account is inferred from a
stored email; no CLA is signed, deployment made, or production secret changed by this patch.
