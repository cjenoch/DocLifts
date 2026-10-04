# Main branch merge gate

GitHub enforces [Main: pull requests and green CI](https://github.com/cjenoch/DocLifts/rules/24469066)
on main. The repository ruleset is active, with no standing bypass actors.

## Normal changes

- Use a branch and pull request. Direct pushes to main are refused.
- The final CI check named test must succeed and must come from GitHub Actions.
  Documentation-only changes use the fast lint path; application changes use
  the full gate. CI chooses the path and the final job validates its result.
- The PR must be tested against the latest main. If main advances, update the
  branch and wait for checks again.
- Merge commits preserve the project history; squash and rebase merges are
  disabled for main by this ruleset.
- No second human approval, code-owner approval or approval of the last push is
  required. The solo maintainer can merge after the checks pass.
- Force-pushing and deleting main are refused.
- The local validation rules in CLAUDE.md still apply. GitHub cannot enforce a
  local test run, backup verification or production acceptance.

The maintainer and automation currently share a GitHub identity, so adding an
automatic admin bypass would also let automation bypass the gate. Ordinary
development/deployment authorization does not authorize weakening these rules
to merge a failing or unchecked change.

## Emergency recovery

The repository owner retains administrative control of the ruleset. If an
incident genuinely requires bypassing a check, make that an explicit owner
decision and record the incident, reason, affected PR and exact commit.

Prefer repairing CI or updating the branch. If that cannot meet the incident
need, the owner can temporarily change only the necessary ruleset setting in
GitHub Settings, Rules, Rulesets. Preserve the original settings first.
Restore them immediately afterward, verify the active rules and no bypass
actors, and complete the skipped checks and incident follow-up. Do not leave
a permanent bypass behind. This is an emergency procedure, not a faster
routine merge path.

## Verification

On October 4, 2026 the same active ruleset temporarily covered a disposable
branch. GitHub refused a direct push (PR required and test check expected),
a force push and branch deletion using the maintainer's own credentials.
The probe never changed main. Its branch was removed after limiting the
ruleset back to main.
