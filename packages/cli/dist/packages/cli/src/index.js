#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const domain_1 = require("../../../packages/core/src/domain");
(0, domain_1.runCli)(process.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
});
