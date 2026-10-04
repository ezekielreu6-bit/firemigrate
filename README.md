# FireMigrate

FireMigrate moves Firebase Firestore, subcollections, Auth users, and Storage metadata into PostgreSQL. Nothing is written until you pass `--write` and set `"dryRun": false`.

Supabase is a valid destination because it is PostgreSQL. Use the direct database connection string as `DATABASE_URL`, not the project HTTP URL. This writes ordinary tables. It does not insert into Supabase `auth.users` or copy Storage file bytes.

```bash
npx @ezekielreu6/firemigrate init
npx @ezekielreu6/firemigrate inspect
npx @ezekielreu6/firemigrate schema
npx @ezekielreu6/firemigrate migrate --dry-run
```

When the dry run counts look right:

```bash
npx @ezekielreu6/firemigrate migrate --write
npx @ezekielreu6/firemigrate verify
```

## What is written

- Top-level collections become tables, upserted by document `id`. Each row also gets `_path`.
- Subcollections become `parent__child` tables with `_parent_id`, `_parent_path`, and `_path`. A parent foreign key is proposed but not applied, so an orphan document cannot abort the load. Add the constraint yourself after you have checked orphans.
- Auth users go to `firebase_auth_users`. Password hashes and salts are stored when the Admin SDK returns them, and are never printed. If you set the Firebase password-hash parameters, `supabase_password_hash` is filled in `$fbscrypt$` form for a later Supabase Auth import.
- Storage object names, size, content type, and checksum go to `firebase_storage_objects`. File bytes stay in Firebase.

Skip a piece with `--skip-auth`, `--skip-storage`, or `--skip-subcollections`.

## Production cutover

1. Run `inspect` and `schema` against a copy of the database first. The schema is inferred from a sample, so fields that appear only later are skipped and reported.
2. Use a Firebase service account that can read Firestore, Auth, and Storage. Password hashes are returned only when that account is allowed to read Auth user credentials.
3. For Supabase, copy the direct or session connection string. Prefer `sslmode=verify-full` if `pg` warns about `sslmode`.
4. Keep `"dryRun": true` until a dry run has been reviewed. A write also requires `--write`.
5. Re-running is safe: rows are upserted by `id`. Existing tables are not altered. If a table was created by an older version, create the new table yourself or the new columns will be missing.
6. Subcollections are found by probing the first documents of each parent. A subcollection that never appears there is missed. Raise the probe with a fresh inspect only by changing code; the default probe is 25 documents.
7. Copy password-hash parameters from Firebase console > Authentication > Users > menu > Password hash parameters. Without them, raw `password_hash` and `password_salt` are still stored and `supabase_password_hash` stays null.
8. After the data load, rewrite Firestore rules as Row Level Security, import Auth into Supabase Auth if you need password login, and copy Storage bytes separately. Then compare `verify` before you point the app at Postgres.

## Commands

`init [--force]` creates `firemigrate.config.json` and `.env.example`. It never writes credentials, and it refuses to overwrite existing files unless you pass `--force`.

`inspect [--sample=<n>]` is read-only. It counts collections, probes subcollections, summarizes Auth, and lists Storage metadata. `--sample` is 1 to 1000, default 100.

`schema` prints the proposed SQL and applies nothing.

`migrate` defaults to `--dry-run`. `--write` applies `CREATE TABLE IF NOT EXISTS` and upserts. `--destructive` is still refused.

`verify` compares PostgreSQL row counts with the counts from the write. Estimated subcollection and Storage sample counts are not treated as failures.

## Configuration

Environment variables win over `firemigrate.config.json`.

| Variable | Used by |
| --- | --- |
| `FIREBASE_PROJECT_ID` | inspect, schema, migrate, verify |
| `FIREBASE_CLIENT_EMAIL` | inspect, schema, migrate, verify |
| `FIREBASE_PRIVATE_KEY` | inspect, schema, migrate, verify |
| `DATABASE_URL` | migrate, verify |
| `FIREBASE_HASH_SIGNER_KEY` | optional, builds `supabase_password_hash` |
| `FIREBASE_HASH_SALT_SEPARATOR` | optional |
| `FIREBASE_HASH_ROUNDS` | optional, default 8 |
| `FIREBASE_HASH_MEM_COST` | optional, default 14 |
| `FIREBASE_STORAGE_BUCKET` | optional |

```json
{
  "dryRun": true,
  "destructive": false,
  "batchSize": 500,
  "subcollections": true,
  "firebase": { "projectId": "", "clientEmail": "", "privateKey": "" },
  "postgres": { "databaseUrl": "" },
  "auth": {
    "migrate": true,
    "includePasswordHashes": true,
    "hash": { "signerKey": "", "saltSeparator": "", "rounds": 8, "memCost": 14 }
  },
  "storage": { "migrateMetadata": true, "bucket": "" }
}
```

Never commit service-account keys, hash signer keys, or connection strings. Error messages redact private keys, connection strings, and `$fbscrypt$` values.

## Limits

- One level of parent is stored. Deeper documents are still copied when their collection-group id matches, with the immediate parent only.
- Auth is a Postgres table, not a Supabase Auth import.
- Storage bytes are not copied.
- Destructive migrations and altering existing tables are not supported.

## Development

```bash
pnpm install
pnpm build
node packages/cli/dist/packages/cli/src/index.js init
```

MIT licensed.
