const $ = (id) => document.getElementById(id);

const DEFAULT_URL = 'http://localhost:50080';
const DEFAULT_TEST_TEXT = 'テスト読み上げです';
const DEFAULT_MAX_LENGTH = 255;
const DEFAULT_FONT_SIZE = 18;
const HOME_CARDS = ['run', 'tree', 'ids', 'log']; // ホームのカテゴリー(既定の並び順)

let status = 'stopped';
let applied = null; // 現在ログイン中の設定(未ログインなら null)
let channelRaw = []; // Botから届いたままのサーバー/チャンネル一覧
let guildOrder = []; // ユーザーが決めたサーバーの並び順(サーバーID)
let channelData = []; // 並び順を適用した一覧(画面に表示する順)
let savedSettings = null; // 保存済みの表示・ログ・棒読みちゃん設定
let logOpts = { date: false, time: true, server: false, channel: false, user: false, role: false };
const logEntries = []; // 表示設定を変えたときに作り直せるよう、ログの中身を保持する
const collapsed = new Set(); // 折りたたみ中のサーバーID(読み上げるサーバー・チャンネル)
const selCollapsed = new Set(); // 折りたたみ中のサーバーID(対象チャンネル一覧)
let selFrameCollapsed = false; // 対象チャンネル一覧の枠そのものを折りたたみ中か
let guildEls = new Map(); // サーバーID → { count, allBtn }

function parseIds(str) {
  return String(str || '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function readForm() {
  return {
    token: $('token').value,
    bouyomiUrl: $('bouyomiUrl').value,
    channelIds: $('channelIds').value,
    readName: $('readName').checked,
    maxLength: Number($('maxLength').value) || DEFAULT_MAX_LENGTH,
    autoStart: $('autoStart').checked,
  };
}

// ログインに関わる設定を比較用の文字列にする(main.js の normalize と同じ規則)
function signature(s) {
  return JSON.stringify({
    token: String(s.token || '').trim(),
    bouyomiUrl: String(s.bouyomiUrl || DEFAULT_URL).trim(),
    channelIds: [...new Set(s.channelIds)].sort(),
    readName: !!s.readName,
    maxLength: Math.max(10, Number(s.maxLength) || DEFAULT_MAX_LENGTH),
  });
}

function isDirty() {
  if (status !== 'running' || !applied) return false;
  const f = readForm();
  return signature(applied) !== signature({ ...f, channelIds: parseIds(f.channelIds) });
}

function setStartButton(text, cls, disabled) {
  const b = $('startBtn');
  b.textContent = text;
  b.className = cls;
  b.disabled = disabled;
}

// 日付 + 時間のスタンプ(どちらも無ければ空)
function stampOf(e, opts) {
  const s = [opts.date ? e.date : '', opts.time ? e.time : ''].filter(Boolean).join(' ');
  return s ? `${s}  ` : '';
}

// 表示サイズスライダーの目盛り(12〜24px、2刻みで数字)
function buildTicks() {
  const box = document.querySelector('.range-wrap .ticks');
  if (!box || box.childElementCount) return;
  for (let v = 12; v <= 24; v++) {
    const i = document.createElement('i');
    i.style.left = `calc(8px + (100% - 16px) * ${(v - 12) / 12})`;
    if (v % 2 === 0) i.dataset.n = String(v);
    box.appendChild(i);
  }
}

function updateButtons() {
  const dirty = isDirty();
  if (dirty) setStartButton('再起動', 'warn', false);
  else if (status === 'running') setStartButton('読み上げ中', 'go', true); // 緑・暗く表示
  else setStartButton('開始', 'primary', status === 'connecting');
  $('stopBtn').disabled = status === 'stopped';
  // 文章は常に配置しておき、表示/非表示だけ切り替える(枠が下にずれないようにスペースを確保)
  $('restartNote').style.visibility = dirty ? 'visible' : 'hidden';
}

function setStatus(payload) {
  status = payload.status;
  applied = payload.applied || null;
  const badge = $('status');
  badge.className = `badge ${status}`;
  badge.textContent = { stopped: '停止中', connecting: '接続中…', running: '動作中' }[status] || status;
  $('channelTree').classList.toggle('stale', status !== 'running');
  updateButtons();
  checkBouyomi();
}

// ---- ログ ----

const LEVEL_LABEL = { info: '情報', warn: '警告', error: 'エラー', read: '読み上げ' };

function userTag(u) {
  return `${u.name}#${String(u.id).slice(-4)}`;
}

function avatarEl(u) {
  const ph = () => {
    const s = document.createElement('span');
    s.className = 'avatar ph';
    s.textContent = [...String(u.name)][0] || '?';
    return s;
  };
  if (!u.avatarUrl) return ph();
  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(ph()));
  img.src = u.avatarUrl;
  return img;
}

// ロールの色を、背景に対して読めるように(コントラスト比 3.5 以上になるまで)調整する
function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function readableColor(hex, bg) {
  let rgb = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16));
  if (rgb.some(Number.isNaN)) return null;
  const target = luminance(bg) < 0.5 ? 255 : 0;
  for (let i = 0; i < 12 && contrast(rgb, bg) < 3.5; i++) {
    rgb = rgb.map((c) => Math.round(c + (target - c) * 0.15));
  }
  return `rgb(${rgb.join(',')})`;
}
function bgOf(el) {
  const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
}

function buildLine(e, opts, bg) {
  const line = document.createElement('div');
  line.className = `line ${e.level}`;
  const t = (s) => document.createTextNode(s);
  const label = LEVEL_LABEL[e.level] || e.level;
  // 時間の表示は従来どおり「時刻 + 空白2つ」
  line.append(t(`${stampOf(e, opts)}[${label}]`));
  const m = e.meta;
  if (m) {
    if (opts.server && m.server) line.append(t(` [${m.server}]`));
    if (opts.channel && m.channel) line.append(t(` [${m.channel}]`));
    if (opts.user && m.user) {
      line.append(t(' '), avatarEl(m.user), t(`[${userTag(m.user)}]`));
    }
    if (opts.role && m.user && m.user.color) {
      const c = readableColor(m.user.color, bg);
      if (c) line.style.color = c;
    }
  }
  line.append(t(` ${e.message}`));
  return line;
}

function addLog(e) {
  logEntries.push(e);
  while (logEntries.length > 500) logEntries.shift();
  const box = $('log');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(buildLine(e, logOpts, bgOf(box)));
  while (box.children.length > 500) box.removeChild(box.firstChild);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// 表示項目やテーマを変えたとき、これまでのログも含めて作り直す
function renderLog() {
  const box = $('log');
  box.textContent = '';
  const bg = bgOf(box);
  for (const e of logEntries) box.appendChild(buildLine(e, logOpts, bg));
  box.scrollTop = box.scrollHeight;
}

function optsFrom(v) {
  return {
    date: v.logShowDate,
    time: v.logShowTime,
    server: v.logShowServer,
    channel: v.logShowChannel,
    user: v.logShowUser,
    role: v.logRoleColor,
  };
}

// 設定画面のログ表示サンプル
function renderLogPreview() {
  const o = optsFrom(readSettingsForm());
  const box = $('logPreview');
  box.textContent = '';
  const bg = bgOf(box);
  box.appendChild(buildLine({ level: 'info', date: '2026/11/26', time: '20:30:04', message: 'ログインしました: bot#0001' }, o, bg));
  box.appendChild(
    buildLine(
      {
        level: 'read',
        date: '2026/11/26',
        time: '20:30:20',
        message: 'こんにちは',
        meta: {
          server: 'あるサーバー',
          channel: 'general',
          user: { name: 'たろう', id: '123456789012345678', avatarUrl: null, color: '#e91e63' },
        },
      },
      o,
      bg,
    ),
  );
}

function logLocal(message) {
  addLog({ level: 'info', message, date: new Date().toLocaleDateString('ja-JP'), time: new Date().toLocaleTimeString('ja-JP') });
}

// ---- 棒読みちゃんの接続状態 ----

async function checkBouyomi() {
  let ok = false;
  try {
    ok = await window.api.checkBouyomi($('bouyomiUrl').value.trim() || DEFAULT_URL);
  } catch {}
  const el = $('bouyomiState');
  el.className = `badge bstate ${ok ? 'ok' : 'ng'}`;
  el.textContent = ok ? '● 棒読みちゃん 接続OK' : '● 棒読みちゃん 未接続';
}

// ---- サーバー/チャンネル一覧 ----

// 保存された並び順を適用する(並び順にないサーバーは、既定の順のまま後ろへ)
function applyGuildOrder(list) {
  const idx = new Map(guildOrder.map((id, i) => [id, i]));
  const known = list.filter((g) => idx.has(g.id)).sort((a, b) => idx.get(a.id) - idx.get(b.id));
  return [...known, ...list.filter((g) => !idx.has(g.id))];
}

function setChannels(list) {
  channelRaw = Array.isArray(list) ? list : [];
  channelData = applyGuildOrder(channelRaw);
}

function iconPlaceholder(name) {
  const ph = document.createElement('span');
  ph.className = 'guild-icon ph';
  ph.textContent = [...String(name)][0] || '?';
  return ph;
}

function writeIds(ids) {
  $('channelIds').value = ids.join(', ');
  onFormChanged();
}

function renderChannels() {
  const box = $('channelTree');
  const scroll = box.scrollTop;
  box.textContent = '';
  guildEls = new Map();

  if (channelData.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent =
      status === 'running'
        ? '表示できるチャンネルがありません(Botに「チャンネルを見る」権限があるか確認してください)'
        : '「開始」するとBotが参加しているサーバーとチャンネルがここに表示されます。';
    box.appendChild(p);
    syncSelection();
    return;
  }

  for (const guild of channelData) {
    const g = document.createElement('div');
    g.className = 'guild';
    g.dataset.guild = guild.id;

    const head = document.createElement('div');
    head.className = 'guild-head';
    head.appendChild(makeGuildGrip(g, guild));
    if (guild.iconUrl) {
      const img = document.createElement('img');
      img.className = 'guild-icon';
      img.alt = '';
      img.addEventListener('error', () => img.replaceWith(iconPlaceholder(guild.name)));
      img.src = guild.iconUrl;
      head.appendChild(img);
    } else {
      head.appendChild(iconPlaceholder(guild.name));
    }
    const name = document.createElement('span');
    name.className = 'guild-name';
    name.textContent = guild.name;
    const count = document.createElement('span');
    count.className = 'sel-count';
    const grow = document.createElement('span');
    grow.className = 'grow';

    // サーバー単位の「すべて選択 / 解除」
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'sub sel-all';
    allBtn.disabled = guild.channels.length === 0;
    allBtn.addEventListener('click', () => {
      const set = new Set(parseIds($('channelIds').value));
      const ids = guild.channels.map((c) => c.id);
      if (ids.every((id) => set.has(id))) ids.forEach((id) => set.delete(id));
      else ids.forEach((id) => set.add(id));
      writeIds([...set]);
    });

    // 折りたたみ: ▽=展開中(押すと折りたたむ) / ▷=折りたたみ中(押すと展開)
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'fold';
    const applyFold = () => {
      const c = collapsed.has(guild.id);
      g.classList.toggle('collapsed', c);
      fold.textContent = c ? '▷' : '▽';
      fold.title = c ? '展開' : '折りたたむ';
      fold.setAttribute('aria-expanded', String(!c));
      fold.setAttribute('aria-label', `${guild.name} のチャンネル一覧を${c ? '展開' : '折りたたむ'}`);
    };
    fold.addEventListener('click', () => {
      if (collapsed.has(guild.id)) collapsed.delete(guild.id);
      else collapsed.add(guild.id);
      applyFold();
    });
    applyFold();

    head.append(name, count, grow, allBtn, fold);
    g.appendChild(head);

    const list = document.createElement('div');
    list.className = 'channels';
    for (const ch of guild.channels) {
      const row = document.createElement('label');
      row.className = 'ch';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = ch.id;
      cb.addEventListener('change', () => toggleId(ch.id, cb.checked));

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = ch.type === 'voice' ? '🔊' : '#';

      const label = document.createElement('span');
      label.textContent = ch.name;

      row.append(cb, mark, label);
      if (ch.category) {
        const cat = document.createElement('span');
        cat.className = 'cat';
        cat.textContent = `(${ch.category})`;
        row.appendChild(cat);
      }
      list.appendChild(row);
    }
    g.appendChild(list);
    box.appendChild(g);
    guildEls.set(guild.id, { count, allBtn });
  }
  box.scrollTop = scroll;
  syncSelection();
}

// サーバーのアイコン(画像が読めないときは頭文字の丸)
function guildIconEl(guild) {
  if (!guild.iconUrl) return iconPlaceholder(guild.name);
  const img = document.createElement('img');
  img.className = 'guild-icon';
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(iconPlaceholder(guild.name)));
  img.src = guild.iconUrl;
  return img;
}

// 折りたたみボタンの見た目: ▽=展開中(押すと折りたたむ) / ▷=折りたたみ中(押すと展開)
function setFoldButton(btn, isCollapsed, subject) {
  btn.textContent = isCollapsed ? '▷' : '▽';
  btn.title = isCollapsed ? '展開' : '折りたたむ';
  btn.setAttribute('aria-expanded', String(!isCollapsed));
  btn.setAttribute('aria-label', `${subject}を${isCollapsed ? '展開' : '折りたたむ'}`);
}

// 「対象チャンネル一覧」: チェックしたチャンネルを、サーバーごとにまとめて表示する。
// チェックを入れた順番に関係なく、同じサーバーのチャンネルは同じグループに入る。
function renderSelected(selected) {
  const box = $('selectedList');
  box.textContent = '';
  box.classList.toggle('collapsed', selFrameCollapsed);
  const known = new Set();
  const groups = []; // { key, name, icon(), items: [{ mark, text, cat }] }

  for (const guild of channelData) {
    guild.channels.forEach((c) => known.add(c.id));
    const items = guild.channels
      .filter((c) => selected.has(c.id))
      .map((c) => ({ mark: c.type === 'voice' ? '🔊' : '#', text: c.name, cat: c.category }));
    if (items.length) groups.push({ key: guild.id, name: guild.name, icon: () => guildIconEl(guild), items });
  }
  // 一覧にないID(未ログイン時や、Botが見られないチャンネル)
  const unknown = [...selected].filter((id) => !known.has(id));
  if (unknown.length) {
    groups.push({ key: '__unknown', name: 'サーバー不明', icon: () => iconPlaceholder('?'), items: unknown.map((id) => ({ mark: '#', text: id })) });
  }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  box.classList.toggle('bare', !groups.length || selFrameCollapsed);

  // 枠の中の見出し行: 左に件数(折りたたみ中はサーバーアイコン+数)、右に折りたたみボタン
  const head = document.createElement('div');
  head.className = 'sel-head';
  const lead = document.createElement('div');
  lead.className = 'sel-lead';
  if (!groups.length) {
    lead.classList.add('empty');
    lead.textContent = 'チェックしたチャンネルはありません';
  } else if (selFrameCollapsed) {
    // 枠ごと折りたたみ中: サーバーアイコンと、右隣に対象チャンネルの数を括弧つきで表示
    lead.classList.add('minis');
    for (const g of groups) {
      const m = document.createElement('span');
      m.className = 'sel-mini';
      m.title = g.name;
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = `(${g.items.length})`;
      m.append(g.icon(), n);
      lead.appendChild(m);
    }
  } else {
    lead.textContent = `${total}件選択中`;
  }
  const frameFold = document.createElement('button');
  frameFold.type = 'button';
  frameFold.id = 'selFold';
  frameFold.className = 'fold';
  setFoldButton(frameFold, selFrameCollapsed, '対象チャンネル一覧');
  frameFold.addEventListener('click', () => {
    selFrameCollapsed = !selFrameCollapsed;
    renderSelected(new Set(parseIds($('channelIds').value)));
  });
  head.append(lead, frameFold);
  box.appendChild(head);
  if (!groups.length || selFrameCollapsed) return;

  // 枠(見出し)とサーバー一覧の間の仕切り線
  const divider = document.createElement('div');
  divider.className = 'sel-divider';
  box.appendChild(divider);
  const body = document.createElement('div');
  body.className = 'sel-body';
  box.appendChild(body);

  for (const g of groups) {
    const el = document.createElement('div');
    el.className = 'sel-guild';

    const hd = document.createElement('div');
    hd.className = 'guild-head';
    const nm = document.createElement('span');
    nm.className = 'guild-name';
    nm.textContent = g.name;
    const grow = document.createElement('span');
    grow.className = 'grow';
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'fold';
    const applyFold = () => {
      const c = selCollapsed.has(g.key);
      el.classList.toggle('collapsed', c);
      setFoldButton(fold, c, `${g.name} のチャンネル`);
    };
    fold.addEventListener('click', () => {
      if (selCollapsed.has(g.key)) selCollapsed.delete(g.key);
      else selCollapsed.add(g.key);
      applyFold();
    });
    applyFold();
    hd.append(g.icon(), nm, grow, fold);
    el.appendChild(hd);

    for (const it of g.items) {
      const d = document.createElement('div');
      d.className = 'sel-ch';
      const m = document.createElement('span');
      m.className = 'mark';
      m.textContent = it.mark;
      const t = document.createElement('span');
      t.textContent = it.text;
      d.append(m, t);
      if (it.cat) {
        const c = document.createElement('span');
        c.className = 'cat';
        c.textContent = `(${it.cat})`;
        d.appendChild(c);
      }
      el.appendChild(d);
    }
    body.appendChild(el);
  }
}

// チャンネルID欄の内容を、一覧のチェック状態と説明文に反映する
function syncSelection() {
  const selected = new Set(parseIds($('channelIds').value));
  const known = new Set();
  document.querySelectorAll('#channelTree input[data-id]').forEach((cb) => {
    known.add(cb.dataset.id);
    cb.checked = selected.has(cb.dataset.id);
  });
  for (const guild of channelData) {
    const els = guildEls.get(guild.id);
    if (!els) continue;
    const n = guild.channels.filter((c) => selected.has(c.id)).length;
    els.count.textContent = n > 0 ? `${n}件選択中` : '';
    const all = guild.channels.length > 0 && n === guild.channels.length;
    els.allBtn.textContent = all ? '選択解除' : 'すべて選択';
  }
  const unknown = channelData.length ? [...selected].filter((id) => !known.has(id)) : [];
  let note =
    selected.size === 0
      ? 'チェックなし: 読み上げ対象のチャンネルがありません。読み上げたいチャンネルにチェックを入れてください。'
      : `${selected.size}件のチャンネルを読み上げます。`;
  if (unknown.length) note += ` 一覧にないID: ${unknown.join(', ')}`;
  $('treeNote').textContent = note;
  renderSelected(selected);
}

function toggleId(id, on) {
  const ids = parseIds($('channelIds').value).filter((x) => x !== id);
  if (on) ids.push(id);
  writeIds(ids);
}

function onFormChanged() {
  syncSelection();
  updateButtons();
}

// ---- ドラッグで高さを変える線 ----

function setupResizer(handle, { target, min, apply, reset, commit }) {
  let startY = 0;
  let startH = 0;
  const clampH = (h) => Math.min(2000, Math.max(min, Math.round(h)));
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startH = target().offsetHeight;
    handle.classList.add('drag');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.classList.contains('drag')) return;
    apply(clampH(startH + e.clientY - startY));
  });
  const end = () => {
    if (!handle.classList.contains('drag')) return;
    handle.classList.remove('drag');
    document.body.classList.remove('resizing');
    commit(target().offsetHeight);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // ダブルクリックで既定の高さに戻す
  handle.addEventListener('dblclick', () => {
    reset();
    commit(null);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const h = clampH(target().offsetHeight + (e.key === 'ArrowDown' ? 20 : -20));
    apply(h);
    commit(h);
  });
}

const applyTreeHeight = (h) => {
  const t = $('channelTree');
  t.style.maxHeight = 'none';
  t.style.height = `${h}px`;
};
const resetTreeHeight = () => {
  const t = $('channelTree');
  t.style.maxHeight = '';
  t.style.height = '';
};
const applySelHeight = (h) => {
  const t = $('selectedList');
  t.style.maxHeight = 'none';
  t.style.height = `${h}px`;
};
const resetSelHeight = () => {
  const t = $('selectedList');
  t.style.maxHeight = '';
  t.style.height = '';
};
const applyLogHeight = (h) => {
  $('logCard').classList.add('sized');
  $('log').style.flex = 'none';
  $('log').style.height = `${h}px`;
};
const resetLogHeight = () => {
  $('logCard').classList.remove('sized');
  $('log').style.flex = '';
  $('log').style.height = '';
};

// ---- 設定画面 ----

function clampSize(v) {
  return Math.min(24, Math.max(12, Math.round(Number(v)) || DEFAULT_FONT_SIZE));
}

function pickSettings(s) {
  return {
    fontSize: clampSize(s.fontSize),
    theme: s.theme === 'light' ? 'light' : 'dark',
    bouyomiPath: String(s.bouyomiPath || '').trim(),
    closeBouyomiOnStop: !!s.closeBouyomiOnStop,
    testText: String(s.testText || '').trim() || DEFAULT_TEST_TEXT,
    logShowDate: !!s.logShowDate,
    logShowTime: !!s.logShowTime,
    logShowServer: !!s.logShowServer,
    logShowChannel: !!s.logShowChannel,
    logShowUser: !!s.logShowUser,
    logRoleColor: !!s.logRoleColor,
  };
}

// テーマ・文字サイズ・ログ表示項目を画面全体に反映する
function applyAppearance(a) {
  document.documentElement.dataset.theme = a.theme === 'light' ? 'light' : 'dark';
  document.documentElement.style.setProperty('--fs', `${clampSize(a.fontSize)}px`);
  logOpts = optsFrom(a);
  renderLog();
}

function readSettingsForm() {
  const theme = document.querySelector('input[name=theme]:checked');
  return pickSettings({
    fontSize: $('fontSize').value,
    theme: theme ? theme.value : 'dark',
    bouyomiPath: $('bouyomiPath').value,
    closeBouyomiOnStop: $('closeBouyomiOnStop').checked,
    testText: $('testText').value,
    logShowDate: $('logShowDate').checked,
    logShowTime: $('logShowTime').checked,
    logShowServer: $('logShowServer').checked,
    logShowChannel: $('logShowChannel').checked,
    logShowUser: $('logShowUser').checked,
    logRoleColor: $('logRoleColor').checked,
  });
}

// サンプル枠だけを更新する(画面全体は「設定を反映する」まで変えない)
// プレビュー枠の大きさは「24px(最大)のときの大きさ」で固定する。値を変えても枠は動かず、中の文字だけが変わる
function sizePreviewFrame() {
  const frame = $('preview');
  const inner = $('previewInner');
  const cur = inner.style.fontSize;
  frame.style.height = '';
  inner.style.fontSize = '24px';
  const h = inner.offsetHeight;
  inner.style.fontSize = cur;
  if (h > 0) {
    frame.style.height = `${h}px`;
    frame.dataset.sized = '1';
  }
}

function updatePreview() {
  const v = readSettingsForm();
  $('previewInner').style.fontSize = `${v.fontSize}px`;
  if (!$('settingsView').hidden && !$('preview').dataset.sized) sizePreviewFrame();
  $('preview').dataset.theme = v.theme;
  $('fontSizeVal').textContent = `${v.fontSize} px`;
  $('settingsNote').textContent =
    JSON.stringify(v) !== JSON.stringify(savedSettings) ? '変更はまだ反映されていません' : '';
  renderLogPreview();
}

function fillSettingsForm(s) {
  $('fontSize').value = s.fontSize;
  document.querySelector(`input[name=theme][value=${s.theme}]`).checked = true;
  $('bouyomiPath').value = s.bouyomiPath;
  $('closeBouyomiOnStop').checked = s.closeBouyomiOnStop;
  $('testText').value = s.testText;
  $('logShowDate').checked = s.logShowDate;
  $('logShowTime').checked = s.logShowTime;
  $('logShowServer').checked = s.logShowServer;
  $('logShowChannel').checked = s.logShowChannel;
  $('logShowUser').checked = s.logShowUser;
  $('logRoleColor').checked = s.logRoleColor;
  updatePreview();
}

function showView(name) {
  $('mainView').hidden = name !== 'main';
  $('settingsView').hidden = name !== 'settings';
}

function openSettings() {
  showView('settings');
  fillSettingsForm(savedSettings);
  sizePreviewFrame();
}

async function applySettings() {
  const v = readSettingsForm();
  await window.api.saveSettings({ ...v, token: $('token').value, bouyomiUrl: $('bouyomiUrl').value });
  savedSettings = v;
  applyAppearance(v);
  showView('main');
  checkBouyomi();
  logLocal('設定を反映しました');
}

// ---- ホームのカテゴリー(枠)の並べ替え ----

function normalizeOrder(order) {
  const given = Array.isArray(order) ? order.filter((k, i, a) => HOME_CARDS.includes(k) && a.indexOf(k) === i) : [];
  return [...given, ...HOME_CARDS.filter((k) => !given.includes(k))];
}

function applyOrder(order) {
  const main = $('homeMain');
  for (const k of normalizeOrder(order)) {
    const el = main.querySelector(`:scope > [data-card="${k}"]`);
    if (el) main.appendChild(el);
  }
}

const currentOrder = () => [...$('homeMain').children].map((e) => e.dataset.card).filter(Boolean);
const saveOrder = () => window.api.saveSettings({ homeOrder: currentOrder() });

// 各枠の右端中央に「四角の中に縦線2本」のつまみを置き、ドラッグ(または上下キー)で並べ替える
// 他の項目が場所を譲るときに、すっと滑らせる
function slideItems(before) {
  for (const [el, top] of before) {
    const d = top - el.offsetTop;
    if (!d) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${d}px)`;
    el.getBoundingClientRect(); // 反映させる
    el.style.transition = 'transform .15s ease';
    el.style.transform = '';
    setTimeout(() => {
      el.style.transition = '';
    }, 170);
  }
}

// つまみをドラッグして、縦に並べ替える共通の仕組み
//  - 項目はマウスに追尾する(上下方向のみ)
//  - 移動先の順番は、マウスの位置で決める。他の項目は場所を譲る
//  - container は、項目の親(スクロールする場合は、そのスクロール領域)。position: relative であること
function enableDragSort({ container, getItems, item, grip, onDone, bodyClass }) {
  let dragging = false;
  let grabY = 0; // 項目の上端からつかんだ位置までの距離
  let lastY = 0;
  let raf = 0;

  const update = () => {
    const cr = container.getBoundingClientRect();
    const h = item.offsetHeight;
    // 端に近づいたら自動でスクロール
    if (lastY < cr.top + 40) container.scrollTop -= 12;
    else if (lastY > cr.bottom - 40) container.scrollTop += 12;
    const all = getItems();
    const minTop = Math.min(...all.map((c) => c.offsetTop)); // 一番上・下の項目の位置までは動ける
    const maxTop = Math.max(minTop, Math.max(...all.map((c) => c.offsetTop + c.offsetHeight)) - h);
    const pointerY = lastY - cr.top - container.clientTop + container.scrollTop; // マウスの位置(一覧の中での高さ)
    const wantTop = Math.min(maxTop, Math.max(minTop, pointerY - grabY));
    const others = all.filter((c) => c !== item);
    const before = others.find((o) => pointerY < o.offsetTop + o.offsetHeight / 2) || null;
    const cur = item.nextElementSibling;
    const nextEl = cur && others.includes(cur) ? cur : null;
    if (before !== nextEl) {
      const snap = new Map(others.map((o) => [o, o.offsetTop]));
      if (before) container.insertBefore(item, before);
      else if (others.length) others[others.length - 1].after(item);
      slideItems(snap);
    }
    item.style.transform = `translateY(${wantTop - item.offsetTop}px)`;
  };
  const tick = () => {
    if (!dragging) return;
    update();
    raf = requestAnimationFrame(tick);
  };
  const onMove = (e) => {
    lastY = e.clientY;
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    document.body.classList.remove(bodyClass);
    // 離したら、決まった場所へすっと収まる
    item.style.transition = 'transform .15s ease';
    item.style.transform = '';
    setTimeout(() => {
      item.style.transition = '';
      item.classList.remove('dragging');
    }, 170);
    onDone();
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastY = e.clientY;
    grabY = e.clientY - item.getBoundingClientRect().top;
    item.style.transition = 'none';
    item.classList.add('dragging');
    document.body.classList.add(bodyClass);
    // 並べ替え中は要素が移動してポインターの捕捉が外れるため、ウィンドウ全体で動きを受け取る
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    raf = requestAnimationFrame(tick);
    e.preventDefault();
  });
  // キーボード: つまみを選んで上下キー
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const items = getItems();
    const i = items.indexOf(item);
    const sib = items[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (!sib) return;
    if (e.key === 'ArrowUp') container.insertBefore(item, sib);
    else sib.after(item);
    grip.focus();
    onDone();
  });
}

// 各枠の右端中央に、縦線2本のつまみを置き、ドラッグ(または上下キー)で並べ替える
function setupCards() {
  const main = $('homeMain');
  const GRIP =
    '<svg viewBox="0 0 18 42" aria-hidden="true"><line class="bars" x1="6.5" y1="14" x2="6.5" y2="28"/><line class="bars" x1="11.5" y1="14" x2="11.5" y2="28"/></svg>';
  const cards = () => [...main.children].filter((c) => c.dataset.card);

  main.querySelectorAll(':scope > .card[data-card]').forEach((card) => {
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'grip';
    grip.innerHTML = GRIP;
    grip.title = 'ドラッグで並べ替え';
    grip.setAttribute('aria-label', `${card.dataset.title} を移動(ドラッグ、または上下キー)`);
    card.appendChild(grip);
    enableDragSort({ container: main, getItems: cards, item: card, grip, onDone: saveOrder, bodyClass: 'reordering' });
  });
}

// 「読み上げるサーバー・チャンネル」: サーバーの左のつまみで、サーバーを並べ替える
function makeGuildGrip(el, guild) {
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'guild-grip';
  grip.innerHTML =
    '<svg viewBox="0 0 12 24" aria-hidden="true"><line class="bars" x1="3.5" y1="5" x2="3.5" y2="19"/><line class="bars" x1="8.5" y1="5" x2="8.5" y2="19"/></svg>';
  grip.title = 'ドラッグでサーバーを並べ替え';
  grip.setAttribute('aria-label', `${guild.name} を移動(ドラッグ、または上下キー)`);
  const tree = $('channelTree');
  enableDragSort({
    container: tree,
    getItems: () => [...tree.querySelectorAll(':scope > .guild')],
    item: el,
    grip,
    bodyClass: 'reordering',
    onDone: () => {
      guildOrder = [...tree.querySelectorAll(':scope > .guild')].map((e) => e.dataset.guild);
      channelData = applyGuildOrder(channelRaw);
      window.api.saveSettings({ guildOrder });
      renderSelected(new Set(parseIds($('channelIds').value))); // 対象チャンネル一覧も同じ順に
    },
  });
  return grip;
}

function fillMainForm(s) {
  $('token').value = s.token || '';
  $('bouyomiUrl').value = s.bouyomiUrl;
  $('channelIds').value = s.channelIds;
  $('readName').checked = s.readName;
  $('maxLength').value = s.maxLength;
  $('autoStart').checked = s.autoStart;
  $('encNote').textContent = s.canEncrypt
    ? 'トークンはこのPC上で暗号化して保存されます。'
    : '注意: この環境ではトークンを保存できません。起動のたびに入力してください。';
}

function syncSelFold() {
  renderSelected(new Set(parseIds($('channelIds').value)));
}

// すべての設定を初期状態に戻す(トークン・読み上げ対象チャンネルも消える)
async function resetAll() {
  const ok = window.confirm(
    'すべての設定を初期状態に戻します。\n\n・Botトークンと、読み上げ対象のチャンネルも消えます\n・カテゴリーとサーバーの並び順、各枠の高さ、ウィンドウの大きさも初期化されます\n\nよろしいですか?',
  );
  if (!ok) return;
  const s = await window.api.resetSettings();
  savedSettings = pickSettings(s);
  applyAppearance(savedSettings);
  fillMainForm(s);
  resetTreeHeight();
  resetSelHeight();
  resetLogHeight();
  applyOrder(s.homeOrder);
  guildOrder = Array.isArray(s.guildOrder) ? s.guildOrder : [];
  channelData = applyGuildOrder(channelRaw);
  collapsed.clear();
  selCollapsed.clear();
  selFrameCollapsed = false;
  fillSettingsForm(savedSettings);
  renderChannels();
  syncSelFold();
  updateButtons();
  logLocal('すべての設定を初期化しました');
}

async function init() {
  const s = await window.api.loadSettings();
  savedSettings = pickSettings(s);
  applyAppearance(savedSettings);

  fillMainForm(s);
  guildOrder = Array.isArray(s.guildOrder) ? s.guildOrder : [];
  setupCards();
  applyOrder(s.homeOrder);

  // 前回ドラッグで変えた高さを復元(未設定なら既定のまま)
  if (s.treeHeight) applyTreeHeight(s.treeHeight);
  if (s.selHeight) applySelHeight(s.selHeight);
  if (s.logHeight) applyLogHeight(s.logHeight);
  setupResizer($('treeResizer'), {
    target: () => $('channelTree'),
    min: 60,
    apply: applyTreeHeight,
    reset: resetTreeHeight,
    commit: (h) => window.api.saveSettings({ treeHeight: h }),
  });
  setupResizer($('selResizer'), {
    target: () => $('selectedList'),
    min: 40,
    apply: applySelHeight,
    reset: resetSelHeight,
    commit: (h) => window.api.saveSettings({ selHeight: h }),
  });
  setupResizer($('logResizer'), {
    target: () => $('log'),
    min: 80,
    apply: applyLogHeight,
    reset: resetLogHeight,
    commit: (h) => window.api.saveSettings({ logHeight: h }),
  });

  // 更新のお知らせ(新しい版があるときだけ、ヘッダーに表示)
  const upBtn = $('updateBtn');
  let upBusy = false;
  const showUpdate = (i) => {
    const on = !!(i && i.ok && i.available);
    upBtn.hidden = !on;
    if (on) {
      upBtn.textContent = '● 更新あり';
      upBtn.title = i.label;
    }
  };
  upBtn.addEventListener('click', async () => {
    if (upBusy) return;
    upBusy = true;
    const r = await window.api.applyUpdate().catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok && r.error) logLocal(`更新できませんでした: ${r.error}`);
    upBtn.textContent = '● 更新あり';
    upBusy = false;
  });
  window.api.onUpdateInfo(showUpdate);
  window.api.onUpdateProgress((p) => {
    if (p && p.total) upBtn.textContent = `● 更新中 ${Math.floor((p.received / p.total) * 100)}%`;
  });
  window.api.updateState().then(showUpdate).catch(() => {});

  window.api.onLog(addLog);
  window.api.onStatus(setStatus);
  window.api.onChannels((list) => {
    setChannels(list);
    renderChannels();
  });

  // 起動時の自動開始などで、画面の準備前に届いたイベントを取りこぼさないよう現在の状態を取得する
  const state = await window.api.getState();
  setChannels(state.channels || []);
  setStatus(state);
  renderChannels();

  ['token', 'bouyomiUrl', 'channelIds', 'readName', 'maxLength'].forEach((id) =>
    $(id).addEventListener('input', onFormChanged),
  );

  // 読み上げるサーバー・チャンネルのチェックをすべて解除
  $('clearIds').addEventListener('click', () => writeIds([]));

  $('toggleToken').addEventListener('click', () => {
    const t = $('token');
    const show = t.type === 'password';
    t.type = show ? 'text' : 'password';
    $('toggleToken').textContent = show ? '隠す' : '表示';
  });
  // 「開始」と「再起動」は同じ処理(ログイン中なら再ログインして新しい設定を反映)
  $('startBtn').addEventListener('click', () => window.api.start(readForm()));
  $('stopBtn').addEventListener('click', () => window.api.stop());
  $('saveBtn').addEventListener('click', async () => {
    await window.api.saveSettings(readForm());
    logLocal('設定を保存しました');
  });
  $('testBtn').addEventListener('click', async () => {
    await window.api.testBouyomi($('bouyomiUrl').value);
    checkBouyomi();
  });
  $('clearLog').addEventListener('click', () => {
    logEntries.length = 0;
    $('log').textContent = '';
  });

  // 設定画面
  $('openSettings').addEventListener('click', openSettings);
  $('backBtn').addEventListener('click', () => showView('main'));
  $('applySettings').addEventListener('click', applySettings);
  $('aboutBtn').addEventListener('click', () => window.api.openAbout());
  $('resetAll').addEventListener('click', resetAll);
  buildTicks();
  ['fontSize', 'bouyomiPath', 'testText'].forEach((id) => $(id).addEventListener('input', updatePreview));
  ['closeBouyomiOnStop', 'logShowDate', 'logShowTime', 'logShowServer', 'logShowChannel', 'logShowUser', 'logRoleColor'].forEach((id) =>
    $(id).addEventListener('change', updatePreview),
  );
  document.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener('change', updatePreview));
  $('pickExe').addEventListener('click', async () => {
    const p = await window.api.pickExe();
    if (p) {
      $('bouyomiPath').value = p;
      updatePreview();
    }
  });

  setInterval(checkBouyomi, 5000);
}

init();
