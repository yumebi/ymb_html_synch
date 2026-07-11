const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

let [major, minor, patch] = pkg.version.split('.').map(Number);

patch += 1;
if (patch > 9) {
  patch = 0;
  minor += 1;
}
if (minor > 9) {
  minor = 0;
  major += 1;
}

pkg.version = `${major}.${minor}.${patch}`;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(pkg.version);
