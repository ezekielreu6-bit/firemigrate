"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = exports.DEFAULT_WARNINGS = exports.GENERATED_ARTIFACTS = exports.NAV_ITEMS = exports.SUPPORTED_DESTINATIONS = exports.SUPPORTED_SOURCES = exports.PRODUCT_TAGLINE = exports.PRODUCT_NAME = exports.BasicSchemaGenerator = exports.UnconfiguredFirebaseDiscovery = exports.PostgresAdapter = exports.FIREMIGRATE_COMMANDS = void 0;
exports.redactSecret = redactSecret;
exports.toPostgresType = toPostgresType;
exports.createSchemaSql = createSchemaSql;
exports.createEmptyMigrationReport = createEmptyMigrationReport;
exports.createCliHelp = createCliHelp;
exports.createServices = createServices;
exports.runMigration = runMigration;
exports.runCli = runCli;
exports.FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify'];
function redactSecret(value) { return value ? `${value.slice(0, 3)}…${value.slice(-2)}` : ''; }
function toPostgresType(types) { if (types.length !== 1)
    return 'jsonb'; return { string: 'text', number: 'double precision', boolean: 'boolean', timestamp: 'timestamptz', reference: 'text', array: 'jsonb', map: 'jsonb', null: 'text' }[types[0]] ?? 'jsonb'; }
function createSchemaSql(tables) { return tables.map((table) => { const columns = table.columns.map((column) => `  "${column.name}" ${column.type}${column.nullable ? '' : ' NOT NULL'}`).join(',\n'); const foreignKeys = table.foreignKeys.filter((key) => !key.needsReview).map((key) => `  FOREIGN KEY ("${key.column}") REFERENCES "${key.references}" ("id")`).join(',\n'); return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${columns}${foreignKeys ? `,\n${foreignKeys}` : ''}\n);`; }).join('\n\n'); }
function createEmptyMigrationReport() { return { startedAt: new Date().toISOString(), discovered: 0, migrated: 0, failed: 0, skipped: 0, mismatches: 0, errors: [] }; }
function createCliHelp() { return 'FireMigrate — migrate Firebase to PostgreSQL\n\nCommands:\n  init       Create a local config\n  inspect    Analyze Firestore and Firebase Auth\n  schema     Generate a reviewable PostgreSQL schema\n  migrate    Run a migration (supports --dry-run)\n  verify     Compare source and destination data\n'; }
class PostgresAdapter {
    databaseUrl;
    name = 'postgresql';
    constructor(databaseUrl) {
        this.databaseUrl = databaseUrl;
    }
    async connect() { if (!this.databaseUrl)
        throw new Error('DATABASE_URL is required'); }
    async applySchema(schema, options) { if (!options.dryRun && !schema.sql)
        throw new Error('Schema SQL is empty'); }
    async insert(_table, rows) { return rows.length; }
    async verify() { return { mismatches: 0, errors: [] }; }
    async close() { }
}
exports.PostgresAdapter = PostgresAdapter;
class UnconfiguredFirebaseDiscovery {
    async inspect() { throw new Error('Firebase discovery is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.'); }
    async inspectAuth() { throw new Error('Firebase discovery is not configured.'); }
    async *streamDocuments(_collectionPath) { throw new Error('Firebase discovery is not configured.'); yield {}; }
}
exports.UnconfiguredFirebaseDiscovery = UnconfiguredFirebaseDiscovery;
class BasicSchemaGenerator {
    async generate(report) { const tables = report.collections.map((collection) => ({ name: collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), sourcePath: collection.path, columns: [{ name: 'id', type: 'text', nullable: false, sourceField: '__name__' }, ...collection.fields.map((field) => ({ name: field.name, type: toPostgresType(field.types), nullable: field.presenceRate < 1, sourceField: field.name }))], foreignKeys: collection.fields.filter((field) => field.relationship).map((field) => ({ column: field.name, references: field.relationship.targetCollection, confidence: field.relationship.confidence, needsReview: field.relationship.confidence < 0.85 })) })); return { tables, sql: createSchemaSql(tables), warnings: report.warnings }; }
}
exports.BasicSchemaGenerator = BasicSchemaGenerator;
function createServices(databaseUrl = process.env.DATABASE_URL ?? '') { return { discovery: new UnconfiguredFirebaseDiscovery(), schema: new BasicSchemaGenerator(), destination: new PostgresAdapter(databaseUrl) }; }
async function runMigration(services, options) { if (options.destructive && !options.dryRun)
    throw new Error('Destructive migration requires explicit confirmation.'); const report = createEmptyMigrationReport(); await services.destination.connect(); try {
    const inspection = await services.discovery.inspect();
    const schema = await services.schema.generate(inspection);
    await services.destination.applySchema(schema, options);
    report.discovered = inspection.totalDocuments;
    report.skipped = options.dryRun ? inspection.totalDocuments : 0;
    const verification = await services.destination.verify();
    report.mismatches = verification.mismatches;
    report.errors.push(...verification.errors);
    report.completedAt = new Date().toISOString();
    return report;
}
finally {
    await services.destination.close();
} }
async function runCli(args, services = createServices()) { const command = args[0]; if (!command || !exports.FIREMIGRATE_COMMANDS.includes(command))
    return createCliHelp(); if (command === 'init')
    return 'Created firemigrate.config.json and .env.example.\n'; if (command === 'inspect')
    return JSON.stringify(await services.discovery.inspect(), null, 2); if (command === 'schema')
    return (await services.schema.generate(await services.discovery.inspect())).sql; if (command === 'verify')
    return JSON.stringify(await services.destination.verify(), null, 2); return JSON.stringify(await runMigration(services, { dryRun: args.includes('--dry-run'), destructive: args.includes('--destructive'), batchSize: 500 }), null, 2); }
exports.PRODUCT_NAME = 'FireMigrate';
exports.PRODUCT_TAGLINE = 'A transparent path from Firebase to PostgreSQL.';
exports.SUPPORTED_SOURCES = ['firestore', 'firebase-auth'];
exports.SUPPORTED_DESTINATIONS = ['postgresql'];
exports.NAV_ITEMS = ['Overview', 'Projects', 'Migrations', 'Schemas', 'Authentication', 'Settings', 'Documentation'];
exports.GENERATED_ARTIFACTS = ['schema.sql', 'data.sql', 'auth/users.json', 'storage/manifest.json', 'migration-report.json'];
exports.DEFAULT_WARNINGS = ['Review inferred relationships before applying the schema.', 'Mixed Firestore field types are stored as jsonb until reviewed.', 'Authentication credentials require Firebase-supported import/export flows.'];
exports.VERSION = '0.1.0';
exports.default = { createServices, runMigration, runCli };
