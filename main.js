const { app, BrowserWindow, ipcMain, safeStorage, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { BouyomiBot, speak } = require('./bot-core');
const { canConnect, ensureBouyomi } = require('./bouyomi-launcher');
const updater = require('./updater');

const DEFAULTS = {
  token: '',
  bouyomiUrl: 'http://localhost:50080',
  channelIds: '',
  readName: true,
  maxLength: 255,
  autoStart: false,
  fontSize: 18, // 表示サイズ(px) 12〜24
  theme: 'dark', // 'dark' | 'light'
  bouyomiPath: '', // 棒読みちゃんの実行ファイル
  closeBouyomiOnStop: true, // 停止時に、このソフトが起動した棒読みちゃんも終了する
  testText: 'テスト読み上げです', // 「テスト」ボタンで読み上げる文章
  // ログの表示項目
  logShowDate: true,
  logShowTime: true,
  logShowServer: true,
  logShowChannel: true,
  logShowUser: true,
  logRoleColor: true,
  // ドラッグで変えた各枠の高さ(px)。null = 既定のまま
  treeHeight: null,
  selHeight: null, // 対象チャンネル一覧
  logHeight: null,
  // ホーム画面のカテゴリー(枠)の並び順
  homeOrder: ['run', 'tree', 'ids', 'log'],
  // 「読み上げるサーバー・チャンネル」のサーバーの並び順(サーバーIDの配列。空 = 既定の順)
  guildOrder: [],
};
const HOME_CARDS = DEFAULTS.homeOrder;

const MIN_WIDTH = 600;
const MIN_HEIGHT = 680;

let win = null;
let bot = null;
let starting = false;
let bouyomiChild = null; // このソフトが起動した棒読みちゃん
// 画面が後から読み込まれても現在の状態を渡せるよう、最新の状態を保持する
let state = { status: 'stopped', applied: null };

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const windowStatePath = () => path.join(app.getPath('userData'), 'window-state.json');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// meta = 発言者の情報(読み上げログ用)
function log(level, message, meta) {
  const now = new Date();
  send('log', {
    level,
    message,
    meta,
    date: now.toLocaleDateString('ja-JP'), // 例: 2026/11/25
    time: now.toLocaleTimeString('ja-JP'),
  });
}

function setState(status, applied) {
  state = { status, applied };
  send('status', state);
}

function createBot() {
  const b = new BouyomiBot(
    log,
    (status) => setState(status, status === 'stopped' ? null : b.settings),
    (channels) => send('channels', channels),
  );
  return b;
}

// 範囲外・不正な値を補正する(含まれている項目だけ)
function sanitize(s) {
  const out = { ...s };
  if ('fontSize' in out) {
    out.fontSize = Math.min(24, Math.max(12, Math.round(Number(out.fontSize)) || DEFAULTS.fontSize));
  }
  if ('theme' in out) out.theme = out.theme === 'light' ? 'light' : 'dark';
  if ('bouyomiPath' in out) out.bouyomiPath = String(out.bouyomiPath || '').trim();
  if ('testText' in out) out.testText = String(out.testText || '').trim() || DEFAULTS.testText;
  for (const k of ['closeBouyomiOnStop', 'logShowDate', 'logShowTime', 'logShowServer', 'logShowChannel', 'logShowUser', 'logRoleColor']) {
    if (k in out) out[k] = !!out[k];
  }
  if ('homeOrder' in out) {
    // 知っているカテゴリーだけを重複なく残し、足りないものは既定の位置順で後ろに足す
    const given = Array.isArray(out.homeOrder) ? out.homeOrder.filter((k, i, a) => HOME_CARDS.includes(k) && a.indexOf(k) === i) : [];
    out.homeOrder = [...given, ...HOME_CARDS.filter((k) => !given.includes(k))];
  }
  if ('guildOrder' in out) {
    const a = Array.isArray(out.guildOrder) ? out.guildOrder : [];
    out.guildOrder = a.map(String).filter((k, i, arr) => k && arr.indexOf(k) === i).slice(0, 1000);
  }
  for (const k of ['treeHeight', 'selHeight', 'logHeight']) {
    if (k in out) {
      const n = Math.round(Number(out[k]));
      out[k] = out[k] != null && Number.isFinite(n) ? Math.min(2000, Math.max(40, n)) : null;
    }
  }
  return out;
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    let token = '';
    if (raw.tokenEnc && safeStorage.isEncryptionAvailable()) {
      try {
        token = safeStorage.decryptString(Buffer.from(raw.tokenEnc, 'base64'));
      } catch {
        token = '';
      }
    }
    return sanitize({ ...DEFAULTS, ...raw, token, tokenEnc: undefined });
  } catch {
    return { ...DEFAULTS };
  }
}

// 渡された項目だけを上書きして保存する(メイン画面と設定画面が、お互いの項目を消さないため)
function saveSettings(s) {
  const next = sanitize({ ...loadSettings(), ...s });
  const toSave = { ...next };
  delete toSave.token;
  delete toSave.tokenEnc;
  // トークンは OS の機能(Windowsでは DPAPI)で暗号化して保存する。
  // 暗号化できない環境では保存しない。
  if (next.token && safeStorage.isEncryptionAvailable()) {
    toSave.tokenEnc = safeStorage.encryptString(next.token).toString('base64');
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(toSave, null, 2), 'utf8');
}

function normalize(s) {
  return {
    token: String(s.token || '').trim(),
    bouyomiUrl: String(s.bouyomiUrl || DEFAULTS.bouyomiUrl).trim(),
    channelIds: String(s.channelIds || '')
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
    readName: !!s.readName,
    maxLength: Math.max(10, Number(s.maxLength) || DEFAULTS.maxLength),
  };
}

// ---- ウィンドウサイズ・位置・最大化/フルスクリーンの記憶 ----

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;
    return s;
  } catch {
    return null;
  }
}

// 保存した位置が、いまのどのモニターにも入っていない場合(モニター構成の変更など)は使わない
function isOnSomeDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y + 40;
  });
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    // 最大化・フルスクリーン中でも、元のサイズ(通常状態)を保存する
    const b = win.getNormalBounds();
    const data = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    };
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(data), 'utf8');
  } catch {}
}

function createWindow() {
  const st = loadWindowState();
  const opts = {
    width: 760,
    height: 860,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Discord 棒読みちゃんBot',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (st) {
    opts.width = Math.max(MIN_WIDTH, Math.round(st.width));
    opts.height = Math.max(MIN_HEIGHT, Math.round(st.height));
    if (Number.isFinite(st.x) && Number.isFinite(st.y) && isOnSomeDisplay({ ...st, width: opts.width, height: opts.height })) {
      opts.x = Math.round(st.x);
      opts.y = Math.round(st.y);
    }
  }
  win = new BrowserWindow(opts);
  if (st && st.maximized) win.maximize();
  if (st && st.fullScreen) win.setFullScreen(true);

  // サイズ変更や移動のたびに保存(連続する変更は少し待ってまとめる)
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(saveWindowState, 300);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, later);
  }
  win.on('close', () => {
    clearTimeout(timer);
    saveWindowState();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// このソフトが起動した棒読みちゃんを、設定に応じて終了する
function stopBouyomiIfLaunched() {
  if (!bouyomiChild || !loadSettings().closeBouyomiOnStop) return;
  try {
    bouyomiChild.kill();
    log('info', '棒読みちゃんを終了しました');
  } catch {}
  bouyomiChild = null;
}

// 開始・再起動の共通処理(棒読みちゃんの起動 → Discordへログイン)
async function startBot(settings) {
  if (starting) return false;
  starting = true;
  try {
    setState('connecting', settings);
    const { child } = await ensureBouyomi({
      url: settings.bouyomiUrl,
      exePath: loadSettings().bouyomiPath,
      log,
    });
    if (child) {
      bouyomiChild = child;
      child.once('exit', () => {
        if (bouyomiChild === child) bouyomiChild = null;
      });
    }
    if (!bot) bot = createBot();
    else if (bot.active) log('info', '設定を変更して再起動します');
    await bot.start(settings);
    return true;
  } catch {
    if (!bot || !bot.active) setState('stopped', null);
    return false;
  } finally {
    starting = false;
  }
}

ipcMain.handle('settings:load', () => {
  const s = loadSettings();
  return { ...s, canEncrypt: safeStorage.isEncryptionAvailable() };
});

ipcMain.handle('settings:save', (_e, s) => {
  saveSettings(s);
  return true;
});

// すべての設定を初期状態に戻す(トークン・読み上げ対象チャンネル・並び順・各枠の高さ・ウィンドウの位置と大きさも)
ipcMain.handle('settings:reset', () => {
  fs.rmSync(settingsPath(), { force: true });
  fs.rmSync(windowStatePath(), { force: true });
  if (win && !win.isDestroyed()) {
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setSize(760, 860);
    win.center();
  }
  return { ...loadSettings(), canEncrypt: safeStorage.isEncryptionAvailable() };
});

ipcMain.handle('bot:state', () => ({
  ...state,
  channels: bot ? bot.collectChannels() : [],
}));

ipcMain.handle('bot:start', async (_e, s) => {
  const settings = normalize(s);
  if (!settings.token) {
    log('error', 'Botトークンを入力してください');
    return false;
  }
  saveSettings(s);
  return startBot(settings);
});

ipcMain.handle('bot:stop', async () => {
  if (bot) await bot.stop();
  stopBouyomiIfLaunched();
  return true;
});

// 設定画面の「テストで読み上げる文章」(保存済みの値)を読み上げる
ipcMain.handle('bouyomi:test', async (_e, url) => {
  const text = loadSettings().testText || DEFAULTS.testText;
  const ok = await speak(url || DEFAULTS.bouyomiUrl, text, log);
  if (ok) log('info', '棒読みちゃんにテストを送信しました');
  return ok;
});

ipcMain.handle('bouyomi:check', (_e, url) => canConnect(url || DEFAULTS.bouyomiUrl));

ipcMain.handle('dialog:pickExe', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '棒読みちゃんの実行ファイルを選択',
    properties: ['openFile'],
    filters: [
      { name: '実行ファイル', extensions: ['exe'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

// ---- 「このソフトウェアについて」ウィンドウ ----

let aboutWin = null;
// 画面から開けるリンクは、ここに挙げたものだけ
const ALLOWED_LINKS = new Set(['https://nodejs.org/ja', 'https://www.electronjs.org/', updater.RELEASES_PAGE, `https://github.com/${updater.REPO}`]);

ipcMain.handle('about:open', () => {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 460,
    height: 420,
    useContentSize: true, // 幅・高さを「中身の大きさ」で指定(タイトルバーを含めない)
    minWidth: 360,
    minHeight: 200,
    parent: win || undefined,
    modal: !!win,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'このソフトウェアについて',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aboutWin.on('closed', () => {
    aboutWin = null;
  });
  aboutWin.loadFile(path.join(__dirname, 'renderer', 'about.html'));
});

// 「Version 1.0.0 20261126.0001.64」 = バージョン + 出力日 + シード値 + 対応ビット数
ipcMain.handle('about:info', () => {
  const pkg = require('./package.json');
  const b = pkg.buildInfo || {};
  return {
    title: `Discord 棒読みちゃんbot (x${b.arch || '64'})`,
    version: `Version ${pkg.version} ${b.date}.${b.seed}.${b.arch || '64'}`,
  };
});

// 中身の高さにウィンドウを合わせる(スクロールバーが出ないように)
ipcMain.handle('about:fit', (e, height) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const h = Math.round(Number(height));
  if (!w || w.isDestroyed() || !Number.isFinite(h)) return;
  const [cw] = w.getContentSize();
  w.setContentSize(cw, Math.min(Math.max(h, 200), 800));
});

ipcMain.handle('about:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
});

// ---- 更新(GitHub の Releases) ----

let updateInfo = null; // 直近の確認結果(画面に渡す形)
let updateLatest = null; // 更新できる最新版(ダウンロードに使う)
let updating = false;

function updateResult(r) {
  return {
    ok: true,
    available: !!r.available,
    label: r.latest ? r.latest.name : '',
    notes: r.latest ? r.latest.notes : '',
    canAuto: !!updater.selfExe(),
  };
}

async function runUpdateCheck() {
  try {
    const r = await updater.checkUpdate(require('./package.json'));
    updateLatest = r.available ? r.latest : null;
    updateInfo = updateResult(r);
  } catch (err) {
    updateLatest = null;
    updateInfo = { ok: false, available: false, error: String((err && err.message) || err) };
  }
  send('update:info', updateInfo);
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.webContents.send('update:info', updateInfo);
  return updateInfo;
}

ipcMain.handle('update:check', () => runUpdateCheck());
ipcMain.handle('update:state', () => updateInfo);

// 新しい版をダウンロードして入れ替え、再起動する
ipcMain.handle('update:apply', async (e) => {
  if (updating) return { ok: false, error: '更新中です' };
  if (!updateLatest) return { ok: false, error: '更新できる新しい版がありません' };
  const exe = updater.selfExe();
  if (!exe) {
    shell.openExternal(updater.RELEASES_PAGE); // 開発中などは、ダウンロードページを開く
    return { ok: true, opened: true };
  }
  const parent = BrowserWindow.fromWebContents(e.sender) || win || undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: '更新',
    message: `${updateLatest.name} に更新します。`,
    detail: '新しい版をダウンロードしたあと、このソフトを終了して入れ替え、自動で起動し直します。\n読み上げ中の場合は停止されます。',
    buttons: ['更新する', 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { ok: false, cancelled: true };
  updating = true;
  const dest = updater.tempPathFor(exe);
  try {
    await updater.download(updateLatest, dest, (p) => e.sender.send('update:progress', p));
  } catch (err) {
    updating = false;
    return { ok: false, error: String((err && err.message) || err) };
  }
  updater.launchSwap(exe, dest);
  app.quit();
  return { ok: true };
});

ipcMain.handle('shell:open', (_e, url) => {
  if (ALLOWED_LINKS.has(url)) shell.openExternal(url);
});

app.whenReady().then(() => {
  createWindow();
  win.webContents.once('did-finish-load', async () => {
    const s = loadSettings();
    if (s.autoStart && s.token) {
      log('info', '自動開始します');
      await startBot(normalize(s));
    }
    runUpdateCheck(); // 新しい版があるか確認(失敗しても何も表示しない)
  });
});

app.on('window-all-closed', async () => {
  if (bot) await bot.stop();
  stopBouyomiIfLaunched();
  app.quit();
});
