// 「このソフトウェアについて」ウィンドウ: メイン画面と同じテーマ・文字サイズで表示する
(async () => {
  try {
    const s = await window.api.loadSettings();
    document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
    const size = Math.min(24, Math.max(12, Math.round(Number(s.fontSize)) || 14));
    document.documentElement.style.setProperty('--fs', `${size}px`);
  } catch {}
})();

(async () => {
  try {
    const i = await window.api.aboutInfo();
    document.getElementById('aboutTitle').textContent = i.title;
    document.getElementById('aboutVersion').textContent = i.version;
  } catch {}
})();

// ---- 更新 ----
const upBtn = document.getElementById('updateBtn');
const upText = document.getElementById('updateStatus');
let upAvailable = false;
let upBusy = false;

function showUpdate(i) {
  if (!i) return;
  upAvailable = !!(i.ok && i.available);
  if (!i.ok) {
    upText.textContent = `更新を確認できませんでした(${i.error || '通信エラー'})`;
    upBtn.textContent = '更新を確認';
  } else if (i.available) {
    upText.textContent = `新しい版があります\n${i.label}`;
    upBtn.textContent = i.canAuto ? '更新する' : 'ダウンロードページを開く';
  } else {
    upText.textContent = '最新の版です';
    upBtn.textContent = '更新を確認';
  }
  fit();
}

upBtn.addEventListener('click', async () => {
  if (upBusy) return;
  upBusy = true;
  upBtn.disabled = true;
  try {
    if (upAvailable) {
      const r = await window.api.applyUpdate();
      if (r && !r.ok && r.error) upText.textContent = `更新できませんでした(${r.error})`;
    } else {
      upText.textContent = '確認しています…';
      showUpdate(await window.api.checkUpdate());
    }
  } catch {}
  upBusy = false;
  upBtn.disabled = false;
});
window.api.onUpdateInfo(showUpdate);
window.api.onUpdateProgress((p) => {
  if (p && p.total) upText.textContent = `ダウンロード中 ${Math.floor((p.received / p.total) * 100)}%`;
});
window.api.updateState().then(showUpdate).catch(() => {});

document.querySelectorAll('a[href]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(a.getAttribute('href'));
  });
});

document.getElementById('closeBtn').addEventListener('click', () => window.api.closeAbout());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.closeAbout();
});

// 中身がちょうど収まる高さにウィンドウを調整する(文字サイズが変わっても、スクロールバーが出ない)
async function fit() {
  const el = document.querySelector('.about');
  el.style.minHeight = '0';
  const h = el.offsetHeight;
  el.style.minHeight = '';
  try {
    await window.api.fitAbout(h);
  } catch {}
}
window.addEventListener('load', () => setTimeout(fit, 100));
