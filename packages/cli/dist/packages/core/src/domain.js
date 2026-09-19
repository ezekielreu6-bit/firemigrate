"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = exports.DEFAULT_WARNINGS = exports.GENERATED_ARTIFACTS = exports.NAV_ITEMS = exports.SUPPORTED_DESTINATIONS = exports.SUPPORTED_SOURCES = exports.PRODUCT_TAGLINE = exports.PRODUCT_NAME = exports.BasicSchemaGenerator = exports.UnconfiguredFirebaseDiscovery = exports.PostgresAdapter = exports.FIREMIGRATE_COMMANDS = exports.initializeProject = void 0;
exports.redactSecret = redactSecret;
exports.toPostgresType = toPostgresType;
exports.createSchemaSql = createSchemaSql;
exports.createEmptyMigrationReport = createEmptyMigrationReport;
exports.createCliHelp = createCliHelp;
exports.requireConfiguration = requireConfiguration;
exports.createServices = createServices;
exports.resolveMigrateOptions = resolveMigrateOptions;
exports.runMigration = runMigration;
exports.runCli = runCli;
exports.parseInspectArgs = parseInspectArgs;
const config_1 = require("./config");
const firebase_source_1 = require("./firebase-source");
const format_1 = require("./format");
const init_1 = require("./init");
Object.defineProperty(exports, "initializeProject", { enumerable: true, get: function () { return init_1.initializeProject; } });
const inspect_1 = require("./inspect");
exports.FIREMIGRATE_COMMANDS = ['init', 'inspect', 'schema', 'migrate', 'verify'];
function redactSecret(value) { return value ? `${value.slice(0, 3)}…${value.slice(-2)}` : ''; }
function toPostgresType(types) { if (types.length !== 1)
    return 'jsonb'; return { string: 'text', number: 'double precision', boolean: 'boolean', timestamp: 'timestamptz', reference: 'text', array: 'jsonb', map: 'jsonb', null: 'text' }[types[0]] ?? 'jsonb'; }
function createSchemaSql(tables) { return tables.map((table) => { const columns = table.columns.map((column) => ` "${column.name}" ${column.type}${column.nullable ? '' : ' NOT NULL'}`).join(',\n'); const foreignKeys = table.foreignKeys.filter((key) => !key.needsReview).map((key) => ` FOREIGN KEY ("${key.column}") REFERENCES "${key.references}" ("id")`).join(',\n'); return `CREATE TABLE IF NOT EXISTS "${table.name}" (\n${columns}${foreignKeys ? `,\n${foreignKeys}` : ''}\n);`; }).join('\n\n'); }
function createEmptyMigrationReport() { return { startedAt: new Date().toISOString(), discovered: 0, migrated: 0, failed: 0, skipped: 0, mismatches: 0, errors: [] }; }
function createCliHelp() {
    return [
        'FireMigrate — migrate Firebase to PostgreSQL',
        '',
        'Commands:',
        '  init      Create firemigrate.config.json and .env.example (--force overwrites existing files)',
        '  inspect   Read-only analysis of Firestore collections and Firebase Auth (--sample=<n>, default 100 documents per collection)',
        '  schema    Generate a reviewable PostgreSQL schema from the inspection',
        '  migrate   Dry run only in this version (--dry-run is the default; database writes are not implemented yet)',
        '  verify    Not implemented yet',
        '',
    ].join('\n');
}
function requireConfiguration(command, config, configPath, needsDatabase) { (0, config_1.assertConfigured)(command, config, configPath, needsDatabase); }
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
    missing;
    constructor(missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
        this.missing = missing;
    }
    failure() { return new Error(`Firebase credentials are not configured (missing: ${this.missing.join(', ')}). Provide them as environment variables or in firemigrate.config.json, then run again.`); }
    async inspect() { throw this.failure(); }
    async inspectAuth() { throw this.failure(); }
    async *streamDocuments(_collectionPath) { throw this.failure(); yield {}; }
}
exports.UnconfiguredFirebaseDiscovery = UnconfiguredFirebaseDiscovery;
class BasicSchemaGenerator {
    async generate(report) { const tables = report.collections.map((collection) => ({ name: collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), sourcePath: collection.path, columns: [{ name: 'id', type: 'text', nullable: false, sourceField: '__name__' }, ...collection.fields.map((field) => ({ name: field.name, type: toPostgresType(field.types), nullable: field.presenceRate < 1, sourceField: field.name }))], foreignKeys: collection.fields.filter((field) => field.relationship).map((field) => ({ column: field.name, references: field.relationship.targetCollection, confidence: field.relationship.confidence, needsReview: field.relationship.confidence < 0.85 })) })); return { tables, sql: createSchemaSql(tables), warnings: report.warnings }; }
}
exports.BasicSchemaGenerator = BasicSchemaGenerator;
function createServices(databaseUrl, config = (0, config_1.loadConfig)().config, extras = {}) {
    const missing = (0, config_1.missingFirebaseCredentials)(config);
    const discovery = missing.length
        ? new UnconfiguredFirebaseDiscovery(missing)
        : new inspect_1.SourceBackedDiscovery(() => (0, firebase_source_1.openFirebaseAdmin)(config), { ...inspect_1.DEFAULT_INSPECT_OPTIONS, ...extras.inspect }, (message) => (0, config_1.scrubSecrets)(message, config), extras.onProgress);
    return { discovery, schema: new BasicSchemaGenerator(), destination: new PostgresAdapter(databaseUrl ?? config.postgres.databaseUrl) };
}
function assertFirestoreReadable(report) {
    if (report.sources && !report.sources.firestore.ok)
        throw new Error(`Firestore could not be read: ${report.sources.firestore.error ?? 'unknown error'}`);
}
function resolveMigrateOptions(args, config) {
    const allowed = ['--dry-run', '--write', '--destructive'];
    const unknown = args.filter((arg) => !allowed.includes(arg));
    if (unknown.length)
        throw new config_1.ConfigError(`Unknown option for migrate: ${unknown.join(' ')}. Supported: ${allowed.join(', ')}`);
    const wantsWrite = args.includes('--write');
    if (wantsWrite && args.includes('--dry-run'))
        throw new config_1.ConfigError('Choose either --dry-run or --write, not both.');
    if (args.includes('--destructive') && !wantsWrite)
        throw new config_1.ConfigError('--destructive only applies to writes. Pass --write --destructive, or drop --destructive for a dry run.');
    if (wantsWrite && config.dryRun)
        throw new config_1.ConfigError('--write refused: firemigrate.config.json has "dryRun": true. Set it to false to allow writes.');
    if (args.includes('--destructive') && !config.destructive)
        throw new config_1.ConfigError('--destructive refused: firemigrate.config.json has "destructive": false. Set it to true to allow destructive writes.');
    return { dryRun: !wantsWrite, destructive: wantsWrite && args.includes('--destructive'), batchSize: config.batchSize };
}
async function runMigration(services, options) {
    if (options.destructive && !options.dryRun)
        throw new Error('Destructive migration requires explicit confirmation.');
    if (!options.dryRun)
        throw new Error('Database writes are not implemented in this version. Re-run with --dry-run to preview.');
    const report = createEmptyMigrationReport();
    report.dryRun = true;
    await services.destination.connect();
    try {
        const inspection = await services.discovery.inspect();
        assertFirestoreReadable(inspection);
        const schema = await services.schema.generate(inspection);
        await services.destination.applySchema(schema, options);
        report.discovered = inspection.totalDocuments;
        report.skipped = inspection.totalDocuments;
        report.notes = ['Dry run: no data was written.', 'Verification was not performed.'];
        report.completedAt = new Date().toISOString();
        return report;
    }
    finally {
        await services.destination.close();
    }
}
async function runCli(args, services) {
    const command = args[0];
    if (!command || !exports.FIREMIGRATE_COMMANDS.includes(command))
        return createCliHelp();
    const rest = args.slice(1);
    if (command === 'init')
        return (0, init_1.initializeProject)(rest);
    if (command === 'verify')
        throw new Error('verify is not implemented yet: no comparison between Firebase and PostgreSQL is performed in this version.');
    const { config, configPath } = (0, config_1.loadConfig)();
    if (command === 'inspect') {
        const inspectOptions = parseInspectArgs(rest);
        if (!services)
            requireConfiguration(command, config, configPath, false);
        const discovery = services?.discovery ?? createServices(undefined, config, { inspect: inspectOptions, onProgress: (message) => { process.stderr.write(`${message}\n`); } }).discovery;
        const report = await discovery.inspect();
        if (report.sources && !(report.sources.firestore.ok && report.sources.auth.ok))
            process.exitCode = 1;
        return (0, format_1.formatInspection)(report, { projectId: config.firebase.projectId });
    }
    if (command === 'schema') {
        if (!services)
            requireConfiguration(command, config, configPath, false);
        const active = services ?? createServices(undefined, config);
        const report = await active.discovery.inspect();
        assertFirestoreReadable(report);
        return (await active.schema.generate(report)).sql;
    }
    const options = resolveMigrateOptions(rest, config);
    if (!services)
        requireConfiguration(command, config, configPath, true);
    return JSON.stringify(await runMigration(services ?? createServices(undefined, config), options), null, 2);
}
function parseInspectArgs(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        const inline = arg.startsWith('--sample=') ? arg.slice('--sample='.length) : undefined;
        if (inline === undefined && arg !== '--sample')
            throw new config_1.ConfigError(`Unknown option for inspect: ${arg}. Supported: --sample=<n>`);
        const raw = inline ?? args[++index];
        const value = Number(raw);
        if (!raw || !Number.isInteger(value) || value < 1 || value > 1000)
            throw new config_1.ConfigError('--sample must be an integer between 1 and 1000.');
        options.sampleSize = value;
    }
    return options;
}
exports.PRODUCT_NAME = 'FireMigrate';
exports.PRODUCT_TAGLINE = 'A transparent path from Firebase to PostgreSQL.';
exports.SUPPORTED_SOURCES = ['firestore', 'firebase-auth'];
exports.SUPPORTED_DESTINATIONS = ['postgresql'];
exports.NAV_ITEMS = ['Overview', 'Projects', 'Migrations', 'Schemas', 'Authentication', 'Settings', 'Documentation'];
exports.GENERATED_ARTIFACTS = ['schema.sql', 'data.sql', 'auth/users.json', 'storage/manifest.json', 'migration-report.json'];
exports.DEFAULT_WARNINGS = ['Review inferred relationships before applying the schema.', 'Mixed Firestore field types are stored as jsonb until reviewed.', 'Authentication credentials require Firebase-supported import/export flows.'];
exports.VERSION = '0.1.1';
exports.default = { createServices, runMigration, runCli };
