"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigError = exports.PACKAGE_RUNNER = exports.DEFAULT_BATCH_SIZE = exports.ENV_EXAMPLE_FILE = exports.CONFIG_FILE = void 0;
exports.defaultConfig = defaultConfig;
exports.normalizePrivateKey = normalizePrivateKey;
exports.loadConfig = loadConfig;
exports.missingFirebaseCredentials = missingFirebaseCredentials;
exports.missingConfiguration = missingConfiguration;
exports.describeMissingConfiguration = describeMissingConfiguration;
exports.assertConfigured = assertConfigured;
exports.scrubSecrets = scrubSecrets;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.CONFIG_FILE = 'firemigrate.config.json';
exports.ENV_EXAMPLE_FILE = '.env.example';
exports.DEFAULT_BATCH_SIZE = 500;
exports.PACKAGE_RUNNER = 'npx @ezekielreu6/firemigrate';
class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
exports.ConfigError = ConfigError;
function defaultConfig() {
    return {
        dryRun: true,
        destructive: false,
        batchSize: exports.DEFAULT_BATCH_SIZE,
        firebase: { projectId: '', clientEmail: '', privateKey: '' },
        postgres: { databaseUrl: '' },
    };
}
const PLACEHOLDER_HINTS = ['your-firebase-project-id', 'service-account@example.com', 'replace-me', 'user:password@localhost'];
function text(value) {
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    return PLACEHOLDER_HINTS.some((hint) => trimmed.includes(hint)) ? '' : trimmed;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function normalizePrivateKey(key) {
    const unquoted = key.length >= 2 && key.startsWith('"') && key.endsWith('"') ? key.slice(1, -1) : key;
    return unquoted.replace(/\\n/g, '\n');
}
function loadConfig(cwd = process.cwd(), env = process.env) {
    const path = (0, node_path_1.resolve)(cwd, exports.CONFIG_FILE);
    let raw = {};
    let configPath = null;
    if ((0, node_fs_1.existsSync)(path)) {
        try {
            raw = asRecord(JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8')));
        }
        catch {
            throw new ConfigError(`${exports.CONFIG_FILE} is not valid JSON. Fix the file, or regenerate it with: ${exports.PACKAGE_RUNNER} init --force`);
        }
        configPath = path;
    }
    const firebase = asRecord(raw.firebase);
    const postgres = asRecord(raw.postgres);
    const batchSize = typeof raw.batchSize === 'number' && Number.isInteger(raw.batchSize) && raw.batchSize > 0 ? raw.batchSize : exports.DEFAULT_BATCH_SIZE;
    const config = {
        dryRun: raw.dryRun !== false,
        destructive: raw.destructive === true,
        batchSize,
        firebase: {
            projectId: text(env.FIREBASE_PROJECT_ID) || text(firebase.projectId),
            clientEmail: text(env.FIREBASE_CLIENT_EMAIL) || text(firebase.clientEmail),
            privateKey: normalizePrivateKey(text(env.FIREBASE_PRIVATE_KEY) || text(firebase.privateKey)),
        },
        postgres: { databaseUrl: text(env.DATABASE_URL) || text(postgres.databaseUrl) || text(raw.databaseUrl) },
    };
    return { config, configPath };
}
function missingFirebaseCredentials(config) {
    const missing = [];
    if (!config.firebase.projectId)
        missing.push('FIREBASE_PROJECT_ID');
    if (!config.firebase.clientEmail)
        missing.push('FIREBASE_CLIENT_EMAIL');
    if (!config.firebase.privateKey)
        missing.push('FIREBASE_PRIVATE_KEY');
    return missing;
}
function missingConfiguration(config, needsDatabase) {
    const missing = missingFirebaseCredentials(config);
    if (needsDatabase && !config.postgres.databaseUrl)
        missing.push('DATABASE_URL');
    return missing;
}
function describeMissingConfiguration(command, missing, configPath) {
    const steps = [];
    if (!configPath)
        steps.push(`No ${exports.CONFIG_FILE} found in this directory. Create one with: ${exports.PACKAGE_RUNNER} init`);
    steps.push('In the Firebase console open Project settings > Service accounts and generate a private key.');
    steps.push(`Provide the values as environment variables (names are listed in ${exports.ENV_EXAMPLE_FILE}) or in the "firebase"/"postgres" sections of ${exports.CONFIG_FILE}. Never commit real credentials.`);
    steps.push(`Run again: ${exports.PACKAGE_RUNNER} ${command}`);
    return [`${command} cannot run yet. Missing configuration: ${missing.join(', ')}.`, '', 'Next steps:', ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join('\n');
}
function assertConfigured(command, config, configPath, needsDatabase) {
    const missing = missingConfiguration(config, needsDatabase);
    if (missing.length)
        throw new ConfigError(describeMissingConfiguration(command, missing, configPath));
}
function scrubSecrets(message, config) {
    let out = message.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]');
    const secrets = [config.firebase.privateKey, config.firebase.privateKey.replace(/\n/g, '\\n'), config.postgres.databaseUrl];
    for (const secret of secrets)
        if (secret.length >= 8)
            out = out.split(secret).join('[redacted]');
    return out;
}
