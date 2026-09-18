# FireMigrate

FireMigrate is an open-source, CLI-first migration engine for moving Firebase Firestore and Firebase Authentication data into PostgreSQL.

The web frontend lives in a separate repository: [firemigrate-web](https://github.com/ezekielreu6-bit/firemigrate-web).

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

## Repository layout

- `packages/core` — shared migration domain contracts
- `packages/cli` — the `firemigrate` command-line interface

## Local development

```bash
pnpm install
pnpm build
```

Copy `.env.example` to your local environment when adapters require credentials. Secrets must never be committed, logged, or sent to the browser.

## Migration artifacts

Migration runs are designed to produce `schema.sql`, `data.sql`, `auth/users.json`, `storage/manifest.json`, and `migration-report.json`.

## Status

This repository contains the CLI and domain foundation. Concrete adapters, parameterized writes, persistent migration runs, and integration fixtures are the next implementation steps.

MIT licensed.

## Publishing

The CLI package is configured for npm publication from `packages/cli`:

```bash
cd packages/cli
pnpm build
npm publish
```
