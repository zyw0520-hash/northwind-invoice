// 采购线索视图：预登记、等票中列表（含超期天数）、已销账/取消归档

import { db, addLead, updateLead, deleteLead } from '../db.js';
import { daysBetween, todayStr, fmtEur } from '../models.js';
import { dlgConfirm, dlgPrompt } from '../dialog.js';

export async function render(el, ctx) {
  const [leads, suppliers] = await Promise.all([db.leads.toArray(), db.suppliers.toArray()]);
  const nameOf = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const today = todayStr();

  const open = leads.filter(l => l.status === '等票中')
    .sort((a, b) => (a.registeredDate || '').localeCompare(b.registeredDate || ''));
  const closed = leads.filter(l => l.status !== '等票中')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>采购线索</h1><div class="sub">听到采购风声就记一条，票到了自动销账；超期未到票会出现在工作台</div></div>
      <div class="head-actions"><button class="btn primary" id="btn-new-lead">＋ 新增线索</button></div>
    </div>
    <div class="card"><h2>等票中（${open.length}）</h2><div id="lead-open"></div></div>
    <div class="card"><h2>已销账 / 已取消（最近 ${closed.length} 条）</h2><div id="lead-closed"></div></div>
  `;

  const rowHtml = (l, closedStyle = false) => {
    const days = daysBetween(l.registeredDate, today);
    const overdue = !closedStyle && l.status === '等票中' && days != null && days >= 14;
    return `<div class="todo-item">
      <span class="t-icon">${closedStyle ? (l.status === '已销账' ? '✅' : '🚫') : overdue ? '🟡' : '📡'}</span>
      <div class="t-main">
        <div class="t-title">${escapeHtml(l.orderedBy || '未记下单人')}：${escapeHtml(l.description || '（未记内容）')}</div>
        <div class="t-sub">${escapeHtml(nameOf[l.supplierId] || '供应商未确认')}${l.estAmount != null ? ` · 约 ${fmtEur(l.estAmount)}` : ''} · 登记 ${l.registeredDate}${l.resolvedDocId ? ' · 已关联票据' : ''}</div>
      </div>
      ${closedStyle ? `<span class="badge ${l.status === '已销账' ? 'b-green' : ''}">${l.status}</span>` : `<span class="t-days ${overdue ? 'd-yellow' : ''}">${days != null ? days + ' 天' : ''}</span>`}
      <div class="row-actions">
        ${closedStyle ? '' : `
          <button class="btn link sm" data-act="done" data-id="${l.id}">票到了</button>
          <button class="btn link sm" data-act="cancel" data-id="${l.id}">取消</button>`}
        <button class="btn link sm" data-act="del" data-id="${l.id}" style="color:var(--danger)">删除</button>
      </div>
    </div>`;
  };

  el.querySelector('#lead-open').innerHTML = open.length
    ? open.map(l => rowHtml(l)).join('')
    : '<div class="empty-tip">没有等票中的线索</div>';
  el.querySelector('#lead-closed').innerHTML = closed.length
    ? closed.map(l => rowHtml(l, true)).join('')
    : '<div class="empty-tip">暂无归档</div>';

  el.querySelector('#btn-new-lead').onclick = () => openLeadForm(ctx);

  el.querySelector('#lead-open').onclick = e => handleLeadAction(e, ctx, false);
  el.querySelector('#lead-closed').onclick = e => handleLeadAction(e, ctx, true);
}

async function handleLeadAction(e, ctx, closedArea) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const lead = await db.leads.get(btn.dataset.id);
  if (!lead) return;
  const act = btn.dataset.act;

  if (act === 'done') {
    // 票到了：填写发票号建立关联（单据在台账里登记后挂线索，或这里仅销账）
    const num = await dlgPrompt('发票已到！请在台账登记该发票并挂上此线索。\n如果只想先销账（不关联具体单据），点确定。', '');
    if (num === null) return;
    await updateLead(lead.id, { status: '已销账' });
    ctx.toast('线索已销账（建议到台账登记对应发票）');
  }
  if (act === 'cancel') {
    const ok = await dlgConfirm('确定取消这条采购线索吗？（比如最终没买）');
    if (!ok) return;
    await updateLead(lead.id, { status: '已取消' });
    ctx.toast('已取消');
  }
  if (act === 'del') {
    const ok = await dlgConfirm('确定删除这条线索吗？删除后其他设备同步删除。', { okText: '删除', danger: true });
    if (!ok) return;
    await deleteLead(lead.id);
    ctx.toast('已删除');
  }
}

async function openLeadForm(ctx) {
  const suppliers = await db.suppliers.toArray();
  const name = await dlgPrompt('谁要买什么？（如：Alex，托盘50个）', '');
  if (name === null || !name.trim()) return;
  // 简单拆分：第一个逗号/空格前是下单人
  const t = name.trim();
  const sep = t.search(/[,，:：\s]/);
  const orderedBy = sep > 0 ? t.slice(0, sep) : '';
  const description = sep > 0 ? t.slice(sep + 1).trim() : t;

  const supplierName = await dlgPrompt('供应商是谁？（不确定可留空）', '');
  let supplierId = null;
  if (supplierName && supplierName.trim()) {
    const hit = suppliers.find(s =>
      s.name.toLowerCase() === supplierName.trim().toLowerCase() ||
      (s.aliases || []).some(a => a.toLowerCase() === supplierName.trim().toLowerCase()));
    supplierId = hit?.id || null;
  }
  const amt = await dlgPrompt('预估金额（欧元，不确定留空）', '');
  const estAmount = amt && amt.trim() !== '' ? Number(amt) : null;

  await addLead({
    orderedBy: orderedBy || '未记',
    description,
    supplierId,
    estAmount: estAmount != null && isFinite(estAmount) ? estAmount : null,
    registeredDate: ctx.today,
    expectedDate: null,
  });
  ctx.toast('线索已登记，票到了会提醒你销账');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
