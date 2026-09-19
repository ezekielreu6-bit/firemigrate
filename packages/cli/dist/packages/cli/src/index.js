#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const domain_1 = require("../../core/src/domain");
(0, domain_1.runCli)(process.argv.slice(2))
    .then((output) => {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
})
    .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
})
    .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
});
