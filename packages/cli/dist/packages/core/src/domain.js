"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
        '  migrate   Apply the generated schema and stream Firestore documents into PostgreSQL (--dry-run by default)',
        '  verify    Check PostgreSQL connectivity and migration state',
        '',
    ].join('\n');
}
function requireConfiguration(command, config, configPath, needsDatabase) { (0, config_1.assertConfigured)(command, config, configPath, needsDatabase); }
class PostgresAdapter {
    databaseUrl;
    name = 'postgresql';
    pool;
    constructor(databaseUrl) {
        this.databaseUrl = databaseUrl;
    }
    async connect() {
        if (!this.databaseUrl)
            throw new Error('DATABASE_URL is required');
        const { Pool } = await Promise.resolve().then(() => __importStar(require('pg')));
        this.pool = new Pool({ connectionString: this.databaseUrl, max: 4, connectionTimeoutMillis: 10000 });
        await this.pool.query('SELECT 1');
    }
    async applySchema(schema, options) {
        if (!schema.sql)
            throw new Error('Schema SQL is empty');
        if (!options.dryRun)
            await this.pool?.query('BEGIN').then(() => this.pool.query(schema.sql)).then(() => this.pool.query('COMMIT')).catch(async (error) => { await this.pool?.query('ROLLBACK').catch(() => undefined); throw error; });
    }
    async insert(table, rows) {
        if (!this.pool || rows.length === 0)
            return 0;
        const columns = Object.keys(rows[0]).filter((column) => column !== 'id' || rows.some((row) => row.id !== undefined));
        if (!columns.length)
            return 0;
        const values = [];
        const tuples = rows.map((row, rowIndex) => `(${columns.map((column, columnIndex) => { values.push(serializePostgresValue(row[column])); return `$${rowIndex * columns.length + columnIndex + 1}`; }).join(', ')})`).join(', ');
        const quotedTable = quoteIdentifier(table);
        const quotedColumns = columns.map(quoteIdentifier).join(', ');
        await this.pool.query(`INSERT INTO ${quotedTable} (${quotedColumns}) VALUES ${tuples} ON CONFLICT ("id") DO UPDATE SET ${columns.filter((column) => column !== 'id').map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ') || '"id" = EXCLUDED."id"'}`, values);
        return rows.length;
    }
    async verify() {
        if (!this.pool)
            return { mismatches: 0, errors: ['Database is not connected'] };
        try {
            await this.pool.query('SELECT current_database()');
            return { mismatches: 0, errors: [] };
        }
        catch (error) {
            return { mismatches: 1, errors: [error instanceof Error ? error.message : String(error)] };
        }
    }
    async close() { await this.pool?.end(); this.pool = undefined; }
}
exports.PostgresAdapter = PostgresAdapter;
function quoteIdentifier(value) { return `"${value.replace(/"/g, '""')}"`; }
function serializePostgresValue(value) {
    if (value === undefined)
        return null;
    if (value instanceof Date)
        return value;
    if (value !== null && typeof value === 'object') {
        const candidate = value;
        if (typeof candidate.toDate === 'function')
            return candidate.toDate();
        return JSON.stringify(value);
    }
    return value;
}
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
    const report = createEmptyMigrationReport();
    report.dryRun = options.dryRun;
    await services.destination.connect();
    try {
        const inspection = await services.discovery.inspect();
        assertFirestoreReadable(inspection);
        const schema = await services.schema.generate(inspection);
        await services.destination.applySchema(schema, options);
        for (const collection of inspection.collections) {
            const rows = [];
            for await (const document of services.discovery.streamDocuments(collection.path)) {
                report.discovered += 1;
                rows.push(document);
                if (rows.length >= options.batchSize) {
                    if (options.dryRun)
                        report.skipped += rows.length;
                    else
                        report.migrated += await services.destination.insert(collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), rows.splice(0));
                }
            }
            if (rows.length) {
                if (options.dryRun)
                    report.skipped += rows.length;
                else
                    report.migrated += await services.destination.insert(collection.name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(), rows);
            }
        }
        const verification = await services.destination.verify();
        report.mismatches = verification.mismatches;
        report.errors.push(...verification.errors);
        report.notes = options.dryRun ? ['Dry run: no data was written.'] : ['Schema and document batches were committed to PostgreSQL.'];
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
    if (command === 'verify') {
        const { config, configPath } = (0, config_1.loadConfig)();
        requireConfiguration(command, config, configPath, true);
        const active = services ?? createServices(undefined, config);
        await active.destination.connect();
        try {
            return JSON.stringify(await active.destination.verify(), null, 2);
        }
        finally {
            await active.destination.close();
        }
    }
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
