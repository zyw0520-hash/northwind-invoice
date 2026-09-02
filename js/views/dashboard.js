// 工作台：体检卡四数字 + 今日待办（按紧急度排序）+ 最近动态

import { db, getDocuments, getLeads } from '../db.js';
import { buildWorkbench } from '../sentinels.js';
import { todayStr } from '../models.js';

export async function render(el, ctx) {
  const today = todayStr();
  const [docs, leads, suppliers] = await Promise.all([
    getDocuments(), getLeads(), db.suppliers.toArray(),
  ]);
  const nameOf = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const wb = buildWorkbench(docs, leads, suppliers, today, {}, nameOf);

  const cards = [
    { key: 'overdue', label: '逾期未付', icon: '🔴', level: wb.counts.overdue ? 'lv-red' : 'zero' },
    { key: 'deliveryPending', label: '送货单等票超期', icon: '🟠', level: wb.counts.deliveryPending ? 'lv-orange' : 'zero' },
    { key: 'leadPending', label: '线索等票超期', icon: '🟡', level: wb.counts.leadPending ? 'lv-yellow' : 'zero' },
    { key: 'supplierGap', label: '供应商可疑缺口', icon: '⚠️', level: wb.counts.supplierGap ? 'lv-purple' : 'zero' },
  ];

  // 最近 7 天新增动态
  const recent = docs
    .filter(d => d.createdAt && (Date.now() - d.createdAt) < 7 * 86400_000)
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>工作台</h1><div class="sub">${today} · 防漏记体检</div></div>
      <div class="head-actions">
        <button class="btn primary" id="btn-goto-docs">＋ 登记单据</button>
      </div>
    </div>
    <div id="health-cards">
      ${cards.map(c => `
        <button class="hcard ${c.level}" data-key="${c.key}">
          <div class="h-num">${c.icon} ${wb.counts[c.key]}</div>
          <div class="h-label">${c.label}</div>
        </button>`).join('')}
    </div>
    <div class="card">
      <h2>今日待办（${wb.todos.length}）</h2>
      <div id="todo-list">
        ${wb.todos.length ? wb.todos.map(t => `
          <div class="todo-item">
            <span class="t-icon">${t.icon}</span>
            <div class="t-main">
              <div class="t-title">${escapeHtml(t.title)}</div>
              <div class="t-sub">${t.kind} · ${escapeHtml(t.sub)}</div>
            </div>
            <span class="t-days d-${t.level}">${t.kind === '逾期未付' ? `逾期 ${t.days} 天` : `${t.days} 天`}</span>
          </div>`).join('')
        : '<div class="empty-tip">✅ 暂无待办 —— 三个哨兵都在安静值班</div>'}
      </div>
    </div>
    <div class="card">
      <h2>最近 7 天新增（${recent.length}）</h2>
      ${recent.length ? recent.map(d => `
        <div class="todo-item">
          <span class="t-icon">🧾</span>
          <div class="t-main">
            <div class="t-title">${d.type} · ${escapeHtml(nameOf[d.supplierId] || '未指定供应商')} ${escapeHtml(d.docNumber || '')}</div>
            <div class="t-sub">${escapeHtml(d.summary || '')}</div>
          </div>
          <span class="t-days" style="color:var(--muted)">${d.docDate}</span>
        </div>`).join('')
      : '<div class="empty-tip">最近 7 天没有新单据</div>'}
    </div>
  `;

  el.querySelector('#btn-goto-docs').onclick = () => {
    document.querySelector('[data-nav="documents"]').click();
  };
  el.querySelectorAll('.hcard').forEach(card => {
    card.onclick = () => {
      const key = card.dataset.key;
      const nav = key === 'overdue' ? 'documents'
        : key === 'deliveryPending' ? 'documents'
        : key === 'leadPending' ? 'leads' : 'documents';
      document.querySelector(`[data-nav="${nav}"]`).click();
    };
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
