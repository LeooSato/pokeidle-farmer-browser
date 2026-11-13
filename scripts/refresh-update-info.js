// Depois de assinar o instalador o arquivo muda, então o latest.yml e o .blockmap
// precisam ser refeitos; senão o auto-update recusa o download (sha512 diferente).
// Uso: node scripts/refresh-update-info.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { version } = require('../package.json');
const dist = path.join(__dirname, '..', 'dist');
const name = `PokeIdle-Farm-Setup-${version}.exe`;
const exe = path.join(dist, name);

const appBuilder = require('app-builder-bin').appBuilderPath;
execFileSync(appBuilder, ['blockmap', '--input', exe, '--output', `${exe}.blockmap`]);

const buf = fs.readFileSync(exe);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const size = buf.length;

const yml = path.join(dist, 'latest.yml');
const old = fs.readFileSync(yml, 'utf8');
const releaseDate = (old.match(/releaseDate:\s*'?([^'\n]+)'?/) || [])[1] || new Date().toISOString();
fs.writeFileSync(yml, [
  `version: ${version}`,
  'files:',
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  ''
].join('\n'));
console.log(`latest.yml atualizado: ${name} ${size} bytes`);
