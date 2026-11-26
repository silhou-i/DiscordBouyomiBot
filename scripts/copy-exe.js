// ビルド後の仕上げ: exe をこのフォルダ直下にだけ置き、dist フォルダ(win-unpacked などを含む)は削除する
//   ./DiscordBouyomiBot.exe
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const exeSrc = path.join(dist, 'DiscordBouyomiBot.exe');
const exeDst = path.join(root, 'DiscordBouyomiBot.exe');

const fail = (msg, err) => {
  console.error(`${msg}${err ? `: ${err.message}` : ''}`);
  console.error('(起動中の DiscordBouyomiBot.exe がある場合は終了してから、もう一度実行してください)');
  process.exit(1);
};

if (!fs.existsSync(exeSrc)) fail(`exe が見つかりません: ${exeSrc}`);

try {
  fs.rmSync(exeDst, { force: true });
  fs.copyFileSync(exeSrc, exeDst);
  fs.rmSync(dist, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  fs.rmSync(path.join(root, 'win-unpacked'), { recursive: true, force: true }); // 以前のビルドの残りがあれば削除
} catch (err) {
  fail('exe の配置に失敗しました', err);
}
console.log(`作成しました: ${exeDst}`);
