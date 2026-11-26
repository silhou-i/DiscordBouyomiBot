// 棒読みちゃんの接続確認と自動起動
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MISSING_MESSAGE = '棒読みちゃんを確認できません。設定から参照ファイルを確認してください。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP連携のポートに接続できるかを確認する(読み上げは発生しない)
function canConnect(baseUrl, timeout = 1500) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(baseUrl);
    } catch {
      return resolve(false);
    }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const sock = net.connect({ host: u.hostname, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// 棒読みちゃんが起動していなければ、指定のexeを起動して接続できるまで待つ。
// 戻り値: { child, ready }  child はこのソフトが起動したプロセス(起動しなかった場合は null)
async function ensureBouyomi({ url, exePath, log, waitMs = 15000 }) {
  if (await canConnect(url)) return { child: null, ready: true };

  const p = String(exePath || '').trim();
  if (!p) return { child: null, ready: false }; // パス未設定なら何もしない(手動起動を想定)

  let stat = null;
  try {
    stat = fs.statSync(p);
  } catch {}
  if (!stat || !stat.isFile()) {
    log('error', MISSING_MESSAGE);
    return { child: null, ready: false };
  }

  let child;
  let spawnError = null;
  try {
    child = spawn(p, [], { cwd: path.dirname(p), detached: true, stdio: 'ignore' });
  } catch (err) {
    log('error', `棒読みちゃんを起動できません: ${err.message}`);
    return { child: null, ready: false };
  }
  child.once('error', (err) => {
    spawnError = err;
  });
  child.unref();
  log('info', '棒読みちゃんを起動しています…');

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (spawnError) {
      log('error', `棒読みちゃんを起動できません: ${spawnError.message}`);
      return { child: null, ready: false };
    }
    if (await canConnect(url)) {
      log('info', '棒読みちゃんに接続できました');
      return { child, ready: true };
    }
  }
  log('warn', '棒読みちゃんの起動を待ちましたが、まだ接続できません(HTTP連携プラグインを確認してください)');
  return { child, ready: false };
}

module.exports = { canConnect, ensureBouyomi, MISSING_MESSAGE };
