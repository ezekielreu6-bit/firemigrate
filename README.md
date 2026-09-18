# FireMigrate

FireMigrate is an open-source, CLI-first migration engine for moving Firebase Firestore and Firebase Authentication data into PostgreSQL.

## Principles

- Inspect before writing
- Generate a relational schema you can review
- Keep uncertain relationships visible
- Never treat Firebase passwords as plaintext
- Default to dry-run and non-destructive migration
- Verify the result read-only

## Commands

```bash
firemigrate init
firemigrate inspect
firemigrate schema
firemigrate migrate --dry-run
firemigrate verify
```

The web UI is an adapter around the same domain contracts used by the CLI. Core interfaces live in `packages/core/src/domain.ts`; concrete Firebase Admin and PostgreSQL drivers are intentionally isolated behind those interfaces until they can be implemented and tested with fixtures.

## Local development

```bash
pnpm install
pnpm dev
```

Copy `.env.example` to `.env.local` and provide credentials locally. Secrets must never be committed, logged, or sent to the browser.

## Architecture

`UI → API → migration engine → Firebase discovery / analyzer / schema generator / PostgreSQL adapter`

Migration artifacts are designed to include `schema.sql`, `data.sql`, `auth/users.json`, `storage/manifest.json`, and `migration-report.json`.

## Status

This repository contains the foundation and inspectable product shell. Concrete adapters, parameterized writes, persistent migration runs, and integration fixtures are the next implementation steps; the UI does not pretend those operations are complete.

MIT licensed.
