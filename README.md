# FireMigrate

FireMigrate moves Firebase Firestore, subcollections, Auth users, and Storage metadata into PostgreSQL. Nothing is written until you pass `--write` and set `"dryRun": false`.

Supabase is a valid destination because it is PostgreSQL. Use the direct database connection string as `DATABASE_URL`, not the project HTTP URL. This writes ordinary tables. It does not insert into Supabase `auth.users` or copy Storage file bytes.

```bash
npx @ezekielreu6/firemigrate init
npx @ezekielreu6/firemigrate inspect
npx @ezekielreu6/firemigrate tables
npx @ezekielreu6/firemigrate schema
npx @ezekielreu6/firemigrate migrate --dry-run
```

When the dry run counts look right:

```bash
npx @ezekielreu6/firemigrate migrate --write
npx @ezekielreu6/firemigrate verify
```

## Agent table list

`tables` is for an agent that will query or finish the migration. It prints JSON only on stdout. Progress stays on stderr. Call only the table names in this list.

```json
{
  "version": 1,
  "instruction": "Use only these PostgreSQL table names.",
  "tableCount": 2,
  "tables": [
    {
      "table": "users__posts",
      "sourcePath": "users/*/posts",
      "kind": "subcollection",
      "parentTable": "users",
      "primaryKey": "id",
      "columns": ["id", "_path", "_parent_id", "_parent_path", "title", "_extra"],
      "read": "SELECT \"id\", \"title\" FROM \"users__posts\"",
      "write": "INSERT INTO \"users__posts\" (...) ON CONFLICT (\"id\") DO UPDATE"
    }
  ]
}
```

`kind` is `collection`, `subcollection`, `auth`, or `storage`. Auth is `firebase_auth_users`. Storage metadata is `firebase_storage_objects`.

## What is written

- Top-level collections become tables, upserted by document `id`. Each row also gets `_path`.
- Every subcollection is found by listing subcollections on every parent document, then nested documents, up to 20 levels. `users/*/posts/*/comments` becomes `users__posts__comments`, with `_parent_id`, `_parent_path`, and `_path`. A parent foreign key is proposed but not applied, so an orphan cannot abort the load.
- Fields that were not in the sampled schema are kept in `_extra`, so a later field is not dropped.
- Auth users go to `firebase_auth_users`. Password hashes and salts are stored when the Admin SDK returns them, and are never printed. If you set the Firebase password-hash parameters, `supabase_password_hash` is filled in `$fbscrypt$` form for a later Supabase Auth import.
- Storage object names, size, content type, and checksum go to `firebase_storage_objects`. File bytes stay in Firebase.

Skip a piece with `--skip-auth`, `--skip-storage`, or `--skip-subcollections`.

## Production cutover

1. Run `inspect`, `tables`, and `schema` against a copy of the database first. Column types are inferred from a sample; anything outside that sample is still written to `_extra`.
2. Use a Firebase service account that can read Firestore, Auth, and Storage. Password hashes are returned only when that account is allowed to read Auth user credentials.
3. For Supabase, copy the direct or session connection string. Prefer `sslmode=verify-full` if `pg` warns about `sslmode`.
4. Keep `"dryRun": true` until a dry run has been reviewed. A write also requires `--write`.
5. Re-running is safe: rows are upserted by `id`. Existing tables are not altered. If a table was created by an older version, create the new table yourself or the new columns will be missing.
6. Subcollection discovery walks every parent document. A full scan is slower than a sample, and a subcollection deeper than 20 levels is reported and not scanned.
7. Copy password-hash parameters from Firebase console > Authentication > Users > menu > Password hash parameters. Without them, raw `password_hash` and `password_salt` are still stored and `supabase_password_hash` stays null.
8. After the data load, rewrite Firestore rules as Row Level Security, import Auth into Supabase Auth if you need password login, and copy Storage bytes separately. Then compare `verify` before you point the app at Postgres.

## Commands

`init [--force]` creates `firemigrate.config.json` and `.env.example`. It never writes credentials, and it refuses to overwrite existing files unless you pass `--force`.

`inspect [--sample=<n>]` is read-only. It counts collections, walks every document for subcollections, summarizes Auth, and lists Storage metadata. `--sample` is 1 to 1000, default 100, and only affects field inference.

`tables` prints the agent JSON manifest of every destination table. It writes nothing.

`schema` prints the proposed SQL and applies nothing.

`migrate` defaults to `--dry-run`. `--write` applies `CREATE TABLE IF NOT EXISTS` and upserts every streamed row. `--destructive` is still refused.

`verify` compares PostgreSQL row counts with the counts from the write. Estimated subcollection and Storage sample counts are not treated as failures.

## Configuration

Environment variables win over `firemigrate.config.json`.

| Variable | Used by |
| --- | --- |
| `FIREBASE_PROJECT_ID` | inspect, tables, schema, migrate, verify |
| `FIREBASE_CLIENT_EMAIL` | inspect, tables, schema, migrate, verify |
| `FIREBASE_PRIVATE_KEY` | inspect, tables, schema, migrate, verify |
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

- Subcollections are scanned to 20 levels. Deeper paths are reported and skipped.
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
