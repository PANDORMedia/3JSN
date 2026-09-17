import { spawnSync } from 'node:child_process';

console.log('3JSN research environment');
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`Node: ${process.version}`);
let missing = Number(process.versions.node.split('.')[0]) < 24;
for (const command of ['git', 'rustc', 'cargo']) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (result.status === 0) console.log(result.stdout.trim());
  else {
    missing = true;
    console.log(`${command}: unavailable; install it before using its part of the project.`);
  }
}
console.log('GPU rendering: npm run probe:gpu');
console.log('Rust device: cargo run --locked -p threejs-native-gpu-probe');
console.log('The probes are separate; native-window + JavaScript integration is the next milestone.');
process.exitCode = missing ? 1 : 0;
