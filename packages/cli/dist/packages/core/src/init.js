"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeProject = initializeProject;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const config_1 = require("./config");
const CONFIG_CONTENTS = `${JSON.stringify({ ...(0, config_1.defaultConfig)(), batchSize: config_1.DEFAULT_BATCH_SIZE }, null, 2)}\n`;
const ENV_CONTENTS = [
    '# Firebase service account (Firebase console > Project settings > Service accounts)',
    'FIREBASE_PROJECT_ID=',
    'FIREBASE_CLIENT_EMAIL=',
    '# Keep the literal \\n sequences from the downloaded JSON key',
    'FIREBASE_PRIVATE_KEY=',
    '# PostgreSQL destination (not needed for inspect)',
    'DATABASE_URL=',
    '',
].join('\n');
function initializeProject(args, cwd = process.cwd()) {
    const unknown = args.filter((arg) => arg !== '--force');
    if (unknown.length)
        throw new config_1.ConfigError(`Unknown option for init: ${unknown.join(' ')}. Supported: --force`);
    const force = args.includes('--force');
    const targets = [
        { name: config_1.CONFIG_FILE, contents: CONFIG_CONTENTS },
        { name: config_1.ENV_EXAMPLE_FILE, contents: ENV_CONTENTS },
    ].map((file) => ({ ...file, path: (0, node_path_1.resolve)(cwd, file.name) }));
    const existing = targets.filter((target) => (0, node_fs_1.existsSync)(target.path));
    if (existing.length && !force) {
        throw new config_1.ConfigError(`Refusing to overwrite existing file(s): ${existing.map((target) => target.name).join(', ')}. Nothing was written. Re-run with --force to overwrite.`);
    }
    const lines = targets.map((target) => {
        const existed = (0, node_fs_1.existsSync)(target.path);
        (0, node_fs_1.writeFileSync)(target.path, target.contents, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
        return `  ${existed ? 'overwrote' : 'created'}  ${target.path}`;
    });
    return [
        'FireMigrate project files:',
        ...lines,
        '',
        'Next steps:',
        `  1. Provide your Firebase service-account values as environment variables (see ${config_1.ENV_EXAMPLE_FILE}).`,
        `  2. Keep real credentials out of git. ${config_1.CONFIG_FILE} is safe to commit only while its credential fields stay empty.`,
        `  3. Run: ${config_1.PACKAGE_RUNNER} inspect`,
        '',
    ].join('\n');
}
