<!--
Title: a Conventional Commit, e.g. `feat(core): add audit log export`.
It becomes the squashed commit on main and the release note.
We don't accept outside pull requests.
-->

## What and why

## How it was tested

## Checklist

- [ ] `vp check` and `vp test` pass
- [ ] Schema changes are expand-only (no drops or renames in the same release)
- [ ] New external calls go through connect; new model calls through the model gateway
- [ ] No secrets, client names or client configuration
- [ ] Risky or user-visible changes ship behind a feature flag
