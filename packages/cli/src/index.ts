#!/usr/bin/env node
import { assertConfigured, loadConfig } from '../../core/src/config'
import { createServices, runCli } from '../../core/src/domain'
import { buildTableManifest } from '../../core/src/tables'

const args = process.argv.slice(2)

const run = args[0] === 'tables'
  ? listTables()
  : runCli(args)

run
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

async function listTables(): Promise<string> {
  const { config, configPath } = loadConfig()
  assertConfigured('tables', config, configPath, false)
  const services = createServices(undefined, config, { onProgress: (message) => { process.stderr.write(`${message}\n`) } })
  const report = await services.discovery.inspect()
  if (report.sources && !report.sources.firestore.ok) {
    process.exitCode = 1
    throw new Error(`Firestore could not be read: ${report.sources.firestore.error ?? 'unknown error'}`)
  }
  const schema = await services.schema.generate(report)
  return JSON.stringify(buildTableManifest(report, schema), null, 2)
}
