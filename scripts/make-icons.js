// build/icon.svg から build/icon.png と build/icon.ico を作る(GitHub Actions 用)
// build/icon.ico が最初からある場合は何もしません。
// 必要なもの: npm install --no-save sharp png-to-ico
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'build');
const svg = path.join(dir, 'icon.svg');
const png = path.join(dir, 'icon.png');
const ico = path.join(dir, 'icon.ico');

(async () => {
  if (fs.existsSync(png) && fs.existsSync(ico)) {
    console.log('アイコンはすでにあります');
    return;
  }
  const sharp = require('sharp');
  const pngToIco = require('png-to-ico');
  const render = (n) => sharp(svg, { density: 384 }).resize(n, n).png().toBuffer();
  fs.writeFileSync(png, await render(512));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(ico, await pngToIco(await Promise.all(sizes.map(render))));
  console.log('アイコンを作りました');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
