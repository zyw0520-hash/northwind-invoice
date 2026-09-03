// 入口：初始化、左侧导航、同步指示器、Toast
// 启动顺序：迁移/种子 → 每日快照 → 首屏渲染 → 云同步（先拉取后种子，避免多设备重复）

import './tests/selftest.js';
import { db, updateDocument } from './db.js';
import { computeDueDate } from './models.js';
import { seedIfEmpty } from './seed.js';
import { maybeDailySnapshot } from './backup.js';
import { bootSync, getSyncStatus, notifySyncState } from './sync.js';
import * as dashboardView from './views/dashboard.js';
import * as documentsView from './views/documents.js';
import * as leadsView from './views/leads.js';
import * as suppliersView from './views/suppliers.js';
import * as settingsView from './views/settings.js';

const views = {
  dashboard: { el: 'page-dashboard', render: dashboardView.render },
  documents: { el: 'page-documents', render: documentsView.render },
  leads: { el: 'page-leads', render: leadsView.render },
  suppliers: { el: 'page-suppliers', render: suppliersView.render },
  settings: { el: 'page-settings', render: settingsView.render },
};

const current = { tab: 'dashboard' };

// ---------- UI 助手 ----------

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function refresh() {
  renderTab(current.tab);
}

// ---------- 侧栏同步状态指示器 ----------

async function refreshSyncIndicator() {
  const el = document.getElementById('sync-chip');
  if (!el) return;
  try {
    const st = await getSyncStatus();
    if (!st.configured) { el.hidden = true; return; }
    el.hidden = false;
    const mode = st.syncing ? 'syncing' : st.lastError ? 'error' : st.pending > 0 ? 'pending' : 'ok';
    el.className = 'sync-chip ' + mode;
    el.innerHTML = `<span class="dot"></span>${st.syncing ? '同步中…'
      : st.lastError ? '同步失败'
      : st.pending > 0 ? `待同步 <b>${st.pending > 99 ? '99+' : st.pending}</b>`
      : '已同步'}`;
    const label = st.syncing ? '同步中…'
      : st.lastError ? `同步失败：${st.lastError}`
      : st.pending > 0 ? `${st.pending} 条待同步`
      : st.lastSyncAt ? `已同步（${new Date(st.lastSyncAt).toLocaleString('zh-CN')}）`
      : '已连接，尚未同步';
    el.setAttribute('aria-label', label);
  } catch (e) {
    console.warn('指示器刷新失败', e);
  }
}

// ---------- 导航 ----------

async function renderTab(tab) {
  const v = views[tab];
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(v.el);
  el.classList.add('active');
  document.querySelectorAll('#nav .nav-item').forEach(b =>
    b.classList.toggle('on', b.dataset.nav === tab));
  const ctx = { refresh, toast, today: new Date().toISOString().slice(0, 10) };
  try {
    await v.render(el, ctx);
  } catch (e) {
    console.error(e);
    toast('页面加载出错：' + e.message);
  }
}

document.getElementById('nav').addEventListener('click', e => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  current.tab = btn.dataset.nav;
  renderTab(current.tab);
});

// 数据变化 → 刷新当前页 + 指示器
window.addEventListener('ledger-write', () => { refresh(); refreshSyncIndicator(); });
window.addEventListener('docs-sync', refreshSyncIndicator);
window.addEventListener('docs-dedup', refresh);

// ---------- 启动 ----------

// 启动兜底：未付+已挂供应商+到期日为空的单据，按供应商默认付款天数补算
// （覆盖"先建单、后设付款天数"的场景，如 PDF 识别建单时供应商还没有默认天数）
async function backfillDueDates() {
  const [docs, sups] = await Promise.all([db.documents.toArray(), db.suppliers.toArray()]);
  const payOf = Object.fromEntries(sups.map(s => [s.id, s.defaultPayDays]));
  let n = 0;
  for (const d of docs) {
    if (d.dueDate || d.payStatus === '已付' || !d.supplierId) continue;
    const due = computeDueDate(d.docDate, payOf[d.supplierId]);
    if (due) { await updateDocument(d.id, { dueDate: due }); n++; }
  }
  if (n) console.log(`[到期日] 已按供应商默认付款天数补算 ${n} 张单据`);
}

(async function boot() {
  // Service Worker：离线缓存（本地开发 file:// 或失败时静默跳过）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 注册失败：', e));
  }

  try {
    await maybeDailySnapshot();
  } catch (e) { console.warn('每日快照失败：', e); }

  await renderTab(current.tab);
  refreshSyncIndicator();

  // 先同步拉取（覆盖云端已有数据），再补种子：避免多设备各自生成种子造成重复
  try {
    await bootSync();
  } catch (e) { /* bootSync 内部已记录错误 */ }
  try {
    if (await seedIfEmpty()) {
      console.log('[种子] 空库，已生成示范数据');
      notifySyncState();
      refresh();
    }
  } catch (e) { console.warn('种子生成失败：', e); }
  try {
    await backfillDueDates();
  } catch (e) { console.warn('到期日补算失败：', e); }
})();
