#!/usr/bin/env node
import { buildProject } from './build.mjs';
import { BuildError } from './contract.mjs';
import { checkProject } from './check.mjs';

const usage = '3jsn build <project> --runtime <player> --out <new-directory> --experimental [--targets <host-target>] [--font <font.woff2> (DOM profiles)] [--html-parser <preserved|restricted> (compiled-dom-window-v1 only)] [--bundle-web-fonts [--web-fonts-state <directory>] [--offline]]';
const checkUsage = '3jsn check <project> [--targets <comma-separated-targets>]';
const controller = new AbortController();
let interruptedBy;
const interrupt = signal => { interruptedBy ??= signal; controller.abort(); };
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  const [command, project, ...args] = process.argv.slice(2);
  if (!['build', 'check'].includes(command) || !project || project.startsWith('--')) throw new BuildError('USAGE', `${checkUsage}\n${usage}`);
  const options = { project, signal: controller.signal };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const key = (command === 'check' ? { '--targets': 'targets' } : { '--runtime': 'runtime', '--out': 'out', '--targets': 'targets', '--experimental': 'experimental', '--font': 'font',
      '--bundle-web-fonts': 'bundleWebFonts', '--web-fonts-state': 'webFontsState', '--offline': 'offline', '--html-parser': 'htmlParser' })[flag];
    if (!key || Object.hasOwn(options, key)) throw new BuildError('USAGE', command === 'check' ? checkUsage : usage);
    if (['experimental', 'bundleWebFonts', 'offline'].includes(key)) options[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new BuildError('USAGE', command === 'check' ? checkUsage : usage);
      options[key] = value;
    }
  }
  if (command === 'check') {
    const report = await checkProject(options);
    console.log(JSON.stringify(report));
    process.exitCode = report.exitCode === 130 && interruptedBy === 'SIGTERM' ? 143 : report.exitCode;
  } else console.log(JSON.stringify(await buildProject(options)));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'BUILD_FAILED', message: error.message,
    ...(error.receipt ? { receipt: error.receipt } : {}),
    ...(error.sourcePreserved !== undefined ? { sourcePreserved: error.sourcePreserved } : {}),
    ...(error.receiptError ? { receiptError: error.receiptError } : {}),
    ...(error.cleanupErrors ? { cleanupErrors: error.cleanupErrors } : {}),
  } }));
  process.exitCode = error.code === 'CANCELLED' ? (interruptedBy === 'SIGTERM' ? 143 : 130)
    : ['USAGE', 'UNSUPPORTED_TARGET', 'UNSUPPORTED_HOST', 'EXPERIMENTAL_REQUIRED'].includes(error.code) ? 2 : 1;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
