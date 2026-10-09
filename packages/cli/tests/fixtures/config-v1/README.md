# Pinned old CLI reader and force-init

`config.ts` and `commands/init.ts` are verbatim sources from `f927e62` (v0.1.1).
Do not update their behavior to make downgrade tests pass. Tests execute the old
`readConfig` and old `runInit --force`, not approximations of their schema checks
or removal decision. The small neighboring modules resolve their original
imports to compatible host/client helpers; `nodeFs.ts` supplies only the unchanged
state directory constant needed by the old config reader. This is a pinned source
execution fixture, not a claim to run every component of the old binary.
