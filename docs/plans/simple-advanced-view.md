# Simple and Advanced workout views

First pass for 0.17.0 Alpha. On a phone, the lifter can switch at the top of any
screen without leaving the workout or discarding an unsaved entry.

Simple is the default. Weight, reps/seconds and a labeled Save set button remain
visible. Notes and effort (RIR) are available through one expandable control.
Saved optional values remain in the form and survive saves while collapsed;
switching view is never a data conversion. Suggestion reasoning stays visible,
and existing progression policies keep their current behavior.

Advanced exposes effort entry and program tools by default. Both views retain
program access, machine identity and weight convention, history, reports, live
editing, safety checks and agent connections. The workout home folds program
creation into Program tools in Simple. A fresh account also has a direct link to
starter programs. The gym step and empty workout explain the next action.

The setting is stored locally under an account-specific browser key. It does not
sync between devices. Storage refusal falls back to an in-memory choice; Account
explains this. A layout-local Svelte state object avoids shared server state and
resets at account changes. There is no database, API, auth or schema change.

Acceptance: production-build browser tests switch with distinct unsaved weight,
reps, zero RIR and notes, save in Simple, verify database values, and reload into
Advanced. A shared browser changes accounts and must not carry the prior account's
view; blocked storage still permits switching. Existing 390px/CSP and photo/logging
tests remain required. This is a first UI pass, not the complete beginner journey,
desktop editor, new signup flow or privacy/deletion release.
