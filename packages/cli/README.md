# FireMigrate

CLI-first Firebase Firestore and Authentication migration foundation for PostgreSQL.

```bash
npx @ezekielreu6/firemigrate init
npx @ezekielreu6/firemigrate inspect
npx @ezekielreu6/firemigrate schema
npx @ezekielreu6/firemigrate migrate --dry-run
```

- `init` writes `firemigrate.config.json` (safe defaults, no credentials) and `.env.example`. It will not overwrite existing files unless you pass `--force`.
- `inspect` is read-only. Set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` (environment variables or `firemigrate.config.json`) and it reports your real Firestore collections, field types, mixed-type and relationship warnings, and a Firebase Auth summary. Without credentials it tells you what is missing and what to do next.
- `schema` prints a reviewable PostgreSQL schema from that inspection.
- `migrate` is dry-run only in this version. Database writes and `verify` are not implemented yet.

Never commit service-account keys. See the [repository README](https://github.com/ezekielreu6-bit/firemigrate#readme) for details and current status.
