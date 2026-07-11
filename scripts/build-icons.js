const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const OUT_DIR = path.join(ROOT, 'build');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const svgBuffer = fs.readFileSync(SVG);

  const png512 = await sharp(svgBuffer, { density: 384 }).resize(512, 512).png().toBuffer();
  const png1024 = await sharp(svgBuffer, { density: 384 }).resize(1024, 1024).png().toBuffer();

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

  const ico = png2icons.createICO(png1024, png2icons.BILINEAR, 0, false, true);
  if (ico) fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

  const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
  if (icns) fs.writeFileSync(path.join(OUT_DIR, 'icon.icns'), icns);

  console.log('生成完了:', OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
