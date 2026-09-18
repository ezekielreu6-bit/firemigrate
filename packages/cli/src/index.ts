#!/usr/bin/env node
import { runCli } from '../../../packages/core/src/domain'

runCli(process.argv.slice(2))
  .then((output) => process.stdout.write(output))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`)
    process.exitCode = 1
  })
