#!/usr/bin/env node
import { runCli } from '../../core/src/domain'

runCli(process.argv.slice(2))
  .then((output) => {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    
    setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
  })
