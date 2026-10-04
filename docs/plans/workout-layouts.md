# Workout layouts — 0.18.0 Alpha

Status: implemented, not deployed. Owner approved shipping for gym testing.

The user selects Guided, Set table, Notebook or Tap sets without changing the
underlying workout. Guided displays one exercise and one selected set with an
existing owned machine photo when available. No catalog illustration or video is
invented. Table is the planned-workout default; Guided is the quick-workout default.
Notebook favors compact text. Tap sets records a prepared weight/reps pair; missing
values or visible effort fields open the editor. A saved circle opens for correction.
Timed sets remain seconds, with warmup/top/backoff roles and load conventions intact.

Customize chooses RIR from the prescription or explicitly shows/hides it, set
notes, previous performance and optional +/- controls. Hidden fields keep their
values on save. Preferences are local to the account and program in that browser.
Defaults remain usable if storage is refused. Unsaved set drafts retain the existing
session-storage and machine-identity protections; layout changes do not remount them.

Edit workout exposes existing move, swap, remove, skip and set controls. Existing
server actions save each change to today's session; Done editing closes controls.
There is no new batch Apply operation. Future program changes use the program
editor or the existing From now on swap. Logged-data removal still confirms; empty
exercise removal keeps Undo. Finish and save failures retain existing safeguards.

The clock opens duration and alert preferences, remembered per account/browser.
Sound starts off and is enabled by a user gesture. The optional two-tone chime,
small timer shake or pulse can be tried immediately. Reduced motion disables
animation. Remaining time comes from timestamps and survives reload; a background
tab catches up when active. Browser audio/locking policies can delay or silence an
alert, so this is not a native background alarm. Expiration never closes editing.

No migration, auth, model, MCP or tunnel changes. Machine photo lookup returns only
owned confirmed photo IDs; image requests independently enforce ownership. One
SetRow saves all views, RestTimer owns the timer, and WorkoutControls owns display
preferences. Old set-entry markup is removed instead of retained as another logger.

Validation covers distinct drafts across all views, hidden zero RIR/notes through
save/reload, preferences across accounts/programs, storage refusal, timer expiry
while editing, 320/390px fit and existing live edit/photo/identity regressions.
Owner gym testing remains separate from automated and scratch-account acceptance.

After gym feedback, audit the remaining workout page orchestration and duplicate
presentation helpers. Measure slow or redundant tests before removing them; retain
ownership, OAuth, upload safety, history identity and draft-loss regressions.
