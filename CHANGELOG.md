# Changelog

All notable public changes to UKP will be documented in this file.

## [Unreleased]

### Changed

- Rename the `refresh` command and capability to `update`: the command is now
  `ukp update`, Service Manifests declare `[capabilities.update]`, and the
  `refresh` capability/provider route becomes `update/qmd`. The old spelling is
  removed rather than kept as an alias (no external users; same approach as the
  earlier `get` → `read` rename).
- Rename the provider timeout override environment variable to
  `UKP_UPDATE_TIMEOUT_MS`.
- Human output now reports `capability: update` and `status: updated`.

## [0.1.0] - 2026-08-22

### Added

- Prepare the first public `@catheadowl/ukp` package shape.
- Ship the local-first CLI surface for Service onboarding, diagnosis,
  registration, inspection, search, get, and refresh.
- Support QMD-backed `search`, `get`, and `refresh` provider adapters.
- Include agent-oriented JSON output and provider-native artifact references.
- Add public GitHub Actions templates for CI and npm trusted publishing.

### Notes

- This is an MVP/demo-but-usable release, not a stable 1.0 protocol.
- Remote endpoints, semantic search tier, API Search, full Client Scope, and
  standalone binary distribution are not included yet.
