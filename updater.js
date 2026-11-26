// 更新の確認とダウンロード(GitHub の Releases を使う)
//   - 新しい版があるかを、GitHub の最新リリースで確認する
//   - ダウンロードした exe に、終了後に入れ替えて再起動する
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');

const REPO = 'silhou-i/DiscordBouyomiBot';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const EXE_NAME = 'DiscordBouyomiBot.exe';
const MIN_EXE_BYTES = 10 * 1024 * 1024; // これより小さい exe は壊れているとみなす

// タグは「v1.0.0-b12」の形(バージョン + ビルド番号)。大小の比較に使う
function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)-b(\d+)$/.exec(String(tag || '').trim());
  return m ? m.slice(1, 5).map(Number) : null;
}

function isNewer(latest, current) {
  for (let i = 0; i < 4; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

function currentOf(pkg) {
  const [a, b, c] = String(pkg.version || '0.0.0').split('.').map((x) => Number(x) || 0);
  return [a, b, c, Number((pkg.buildInfo || {}).build) || 0];
}

// リリースの情報から、更新に必要なものを取り出す(想定外の内容なら null)
function pickRelease(rel) {
  if (!rel || typeof rel !== 'object' || rel.draft || rel.prerelease) return null;
  const ver = parseTag(rel.tag_name);
  if (!ver) return null;
  const asset = (rel.assets || []).find((a) => a && a.name === EXE_NAME);
  if (!asset || typeof asset.browser_download_url !== 'string') return null;
  if (!asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  return {
    ver,
    tag: rel.tag_name,
    name: String(rel.name || rel.tag_name),
    notes: String(rel.body || '').slice(0, 2000),
    url: asset.browser_download_url,
    size: Number(asset.size) || 0,
    sha256: m ? m[1].toLowerCase() : null,
  };
}

async function checkUpdate(pkg, fetchImpl = fetch) {
  const res = await fetchImpl(API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DiscordBouyomiBot' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return { available: false, latest: null }; // まだリリースがない
  if (!res.ok) throw new Error(`GitHub から情報を取得できませんでした (${res.status})`);
  const latest = pickRelease(await res.json());
  if (!latest) return { available: false, latest: null };
  return { available: isNewer(latest.ver, currentOf(pkg)), latest };
}

// 新しい exe を destPath へダウンロードする。壊れていたら例外を投げて、ファイルは残さない
async function download(latest, destPath, onProgress, fetchImpl = fetch) {
  if (!latest.url.startsWith(DOWNLOAD_PREFIX)) throw new Error('ダウンロード先が正しくありません');
  const res = await fetchImpl(latest.url, {
    headers: { 'User-Agent': 'DiscordBouyomiBot' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗しました (${res.status})`);
  const total = Number(res.headers.get('content-length')) || latest.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(destPath);
  let received = 0;
  let head = Buffer.alloc(0);
  try {
    await new Promise((resolve, reject) => {
      const src = Readable.fromWeb(res.body);
      src.on('data', (chunk) => {
        hash.update(chunk);
        if (head.length < 2) head = Buffer.concat([head, chunk]).subarray(0, 2);
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      src.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      src.pipe(out);
    });
    if (received < MIN_EXE_BYTES) throw new Error('ダウンロードしたファイルが小さすぎます');
    if (latest.size && received !== latest.size) throw new Error('ダウンロードしたファイルの大きさが一致しません');
    if (head.toString('latin1') !== 'MZ') throw new Error('ダウンロードしたファイルが exe ではありません');
    if (latest.sha256 && hash.digest('hex') !== latest.sha256) throw new Error('ダウンロードしたファイルが壊れています(チェックサム不一致)');
  } catch (err) {
    out.destroy();
    fs.rmSync(destPath, { force: true });
    throw err;
  }
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell の文字列リテラル

// 終了後に exe を入れ替えて、起動し直す PowerShell(日本語のパスでも壊れないよう Base64 で渡す)
function swapScript(oldExe, newExe) {
  return [
    `$old = ${psq(oldExe)}`,
    `$new = ${psq(newExe)}`,
    '$ok = $false',
    'for ($i = 0; $i -lt 120; $i++) {',
    '  Start-Sleep -Milliseconds 500',
    '  try { Move-Item -LiteralPath $new -Destination $old -Force -ErrorAction Stop; $ok = $true; break } catch {}',
    '}',
    'if ($ok) { Start-Process -FilePath $old }',
  ].join('\n');
}

function launchSwap(oldExe, newExe) {
  const encoded = Buffer.from(swapScript(oldExe, newExe), 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => {});
  child.unref();
}

// 単体 exe(ポータブル版)で動いているときの、exe 自身の場所。開発中(npm start)などは null
const selfExe = () => process.env.PORTABLE_EXECUTABLE_FILE || null;
const tempPathFor = (exe) => path.join(path.dirname(exe), 'DiscordBouyomiBot.update.exe');

module.exports = {
  REPO,
  RELEASES_PAGE,
  parseTag,
  isNewer,
  currentOf,
  pickRelease,
  checkUpdate,
  download,
  swapScript,
  launchSwap,
  selfExe,
  tempPathFor,
};
