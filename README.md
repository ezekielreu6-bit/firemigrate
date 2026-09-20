# FireMigrate

FireMigrate is an open-source, CLI-first tool for moving Firebase Firestore data into PostgreSQL. It inspects your project, proposes a relational schema, and migrates deliberately: nothing is written until you explicitly ask for it.

The package is [`@ezekielreu6/firemigrate`](https://www.npmjs.com/package/@ezekielreu6/firemigrate) (not the unrelated `fire-migrate`). No install is needed:

```bash
npx @ezekielreu6/firemigrate init
```

## Requirements

- Node.js 20 or newer
- A Firebase service account with read access to Firestore and Firebase Authentication
- A PostgreSQL database (only needed for `migrate` and `verify`)

## Quick start

```bash
npx @ezekielreu6/firemigrate init         # create the config files
# add your Firebase credentials (see Configuration), then:
npx @ezekielreu6/firemigrate inspect      # read-only analysis of your project
npx @ezekielreu6/firemigrate schema       # print the proposed PostgreSQL schema
npx @ezekielreu6/firemigrate migrate --dry-run   # preview, writes nothing
```

When the preview looks right, set `"dryRun": false` in `firemigrate.config.json` and run:

```bash
npx @ezekielreu6/firemigrate migrate --write
npx @ezekielreu6/firemigrate verify
```

## Commands

### `init [--force]`

Creates `firemigrate.config.json` (safe defaults: `dryRun: true`, `destructive: false`, `batchSize: 500`, empty credential fields) and `.env.example`, and prints the paths it wrote. If either file already exists, nothing is written unless you pass `--force`. It never writes credentials.

### `inspect [--sample=<n>]`

Read-only. Needs the three `FIREBASE_*` variables only.

- Lists top-level Firestore collections and counts their documents.
- Reads up to `n` documents per collection (default 100, maximum 1000, in document-ID order) to infer field types and how often each field appears.
- Warns about fields with mixed types and about relationships it cannot be sure of.
- Summarizes Firebase Auth: user count and sign-in providers. Password hashes are never read or printed.
- Detects subcollections by probing the first documents of each collection and lists them as warnings. They are not analyzed yet.

Exits with code 1 if Firestore or Auth could not be read.

### `schema`

Prints a reviewable PostgreSQL schema built from the same inspection. Needs the three `FIREBASE_*` variables only. Nothing is applied.

- One table per top-level collection, with `id text` as the primary key.
- Fields with mixed types become `jsonb`. Maps and arrays become `jsonb`. Timestamps become `timestamptz`.
- Firestore document references become foreign keys only when the target collection is known and the match is certain. Guesses based on names alone (for example `userId` pointing at `users`) are reported as warnings, never as foreign keys.
- A document field literally named `id` collides with the id column, so it is skipped and reported.

### `migrate [--dry-run | --write]`

Needs all four variables.

- **`--dry-run` (the default)** streams every document and reports counts without writing to PostgreSQL. Firestore reads still apply and are billed as usual.
- **`--write`** applies the schema in a single transaction, then upserts documents by `id` in batches of `batchSize`, so re-running is safe. Existing tables are not altered. If a batch fails, it retries document by document and reports exactly which documents failed. Afterwards it compares PostgreSQL row counts with the documents streamed from Firestore. Exits with code 1 on any failure or mismatch.
- Writing needs two explicit opt-ins: the `--write` flag and `"dryRun": false` in `firemigrate.config.json`.
- `--destructive` needs `--write` and `"destructive": true`, but destructive migrations are refused in this version.

### `verify`

Needs all four variables. Connects to PostgreSQL and compares each table's row count with the document count of its Firestore collection. Reports any missing table or count mismatch and exits with code 1 if it finds one.

## Configuration

Environment variables take precedence over `firemigrate.config.json`.

| Variable | Used by |
| --- | --- |
| `FIREBASE_PROJECT_ID` | inspect, schema, migrate, verify |
| `FIREBASE_CLIENT_EMAIL` | inspect, schema, migrate, verify |
| `FIREBASE_PRIVATE_KEY` | inspect, schema, migrate, verify |
| `DATABASE_URL` | migrate, verify |

The private key may contain literal `\n` sequences, exactly as it appears in the downloaded service-account JSON.

```json
{
  "dryRun": true,
  "destructive": false,
  "batchSize": 500,
  "firebase": { "projectId": "", "clientEmail": "", "privateKey": "" },
  "postgres": { "databaseUrl": "" }
}
```

Never commit service-account keys or connection strings. Prefer environment variables, and keep `firemigrate.config.json` out of git as soon as it holds any credential. FireMigrate removes key material from its error messages.

## Limits in this version

- Only top-level collections are migrated. Subcollections are detected but not analyzed.
- The schema is inferred from a sample (the first 100 documents per collection). Fields that appear only outside the sample are skipped and reported, so review the warnings.
- Firebase Auth users are summarized but not migrated, and Firebase Storage is not covered.
- Destructive migrations are not supported.

## Troubleshooting

- **"cannot run yet. Missing configuration"** lists the exact variables to set.
- **A `pg` warning about `sslmode`** comes from connection strings that use `sslmode=require`. To keep today's strict behavior and silence it, use `sslmode=verify-full`.
- **`inspect` fails while other commands work,** so check that the service account has permission to read Firestore and Firebase Authentication.

## Development

```bash
pnpm install
pnpm build
```

To run the local build:

```bash
node packages/cli/dist/packages/cli/src/index.js init
```

Repository layout:

- `packages/core`: config loading, inspection, schema generation and migration logic
- `packages/cli`: the `@ezekielreu6/firemigrate` command-line interface

## Releasing

From `packages/cli`, after `pnpm build` and `npm pack --dry-run` look right:

```bash
npm publish --access public
```

The tarball should include `dist/packages/cli/src/index.js`, `README.md` and `LICENSE`.

MIT licensed.
