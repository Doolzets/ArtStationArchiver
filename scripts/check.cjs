const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
for (const folder of ['app', 'scripts', 'test']) {
  for (const name of fs.readdirSync(folder)) {
    if (/\.(cjs|js)$/.test(name)) execFileSync(process.execPath, ['--check', `${folder}/${name}`], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax checks passed.');
