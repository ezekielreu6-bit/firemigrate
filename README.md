# FireMigrate

FireMigrate is an open-source, CLI-first foundation for moving Firebase Firestore and Firebase Authentication data into PostgreSQL. The package is **not on npm until it is published**; the intended package name is `firemigrate` (not the unrelated `fire-migrate`).

## Commands

```bash
firemigrate init [--force]
firemigrate inspect
firemigrate schema
firemigrate migrate --dry-run
firemigrate migrate --write
firemigrate verify
```

`init` creates `firemigrate.config.json` with safe defaults (`dryRun: true`, `destructive: false`) and `.env.example`. Existing files are never overwritten unless `--force` is passed.

Required environment variables:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `DATABASE_URL`

Inspect, schema, migrate, and verify currently report missing configuration and use honest stubs. Concrete Firebase adapters, live inspection, parameterized writes, persistent migration runs, and integration fixtures are not implemented yet. Do not treat marketing-site sample counts as real inspection output.

## Local development

```bash
pnpm install
pnpm build
```

To run the local CLI after building:

```bash
node packages/cli/dist/packages/cli/src/index.js init
```

## Repository layout

- `packages/core` — shared migration domain contracts
- `packages/cli` — the `firemigrate` command-line interface

## Publishing

From the repository root, run the following exact steps:

```bash
pnpm install
pnpm build
cd packages/cli
npm pack --dry-run
npm publish
```

`npm pack --dry-run` should include the compiled `dist/packages/cli/src/index.js`, `README.md`, and `LICENSE`.

MIT licensed.
