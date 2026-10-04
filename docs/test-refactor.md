# Test suite refactor, first pass

The first pass changes test infrastructure only. It does not change app behavior, database schema, deployed runtime or account data.

## Retained coverage

- Every existing browser journey remains: authentication/CSRF, account isolation, photos and safety, workout logging/editing, program editing, Trash, reports and MCP.
- The 22 route patterns still render under production CSP, with a 390 px initial viewport and a desktop resize. Status and path checks prevent a redirect to a 200 login page from masquerading as coverage.
- The route count falls because separate layout and CSP visits are combined. A deliberately blocked script and app style attribute prove the shared observer actually detects violations. Temporarily suppressing observed violations must fail that canary.
- The SvelteKit announcer remains the only tolerated style attribute. Shared DOM inspection now catches application style attributes in the other browser suites too.
- Each page still has an isolated context, and each suite retains its own server/database fixture lifecycle. No state is shared across suites to gain speed.
- The full local and CI release gates remain mandatory. Focused commands in CONTRIBUTING make the editing loop smaller.

## Next cuts, after this pass

1. Review route-level and database-level assertions by behavior. Consolidate genuine duplication only after naming which remaining test catches the same failure.
2. Extract photo orchestration and exercise editing from the large workout page in separate changes, keeping the existing saved-set, hidden-field and cross-account regressions. Avoid a simultaneous rewrite of the editor and logger.
3. Profile test DB resets and module import cost before splitting or parallelizing suites. Today they share one isolated test database; enabling parallel files without isolation is unsafe.
4. Replace unnecessary browser idle waits with explicit readiness checks where a scenario demonstrates the replacement is reliable. Keep the authentication and throttle timing tests, whose waits are the behavior under test.

Record before/after timings on the same host and build; counts alone are not a performance metric.
