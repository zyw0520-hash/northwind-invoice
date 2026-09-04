// 供应商视图：标准名/别名/默认付款条件管理（别名用于快速匹配与将来同步去重）

import { db, addSupplier, updateSupplier, deleteSupplier, updateDocument } from '../db.js';
import { computeDueDate } from '../models.js';
import { dlgConfirm } from '../dialog.js';

export async function render(el, ctx) {
  const suppliers = await db.suppliers.toArray();
  const docs = await db.documents.toArray();
  const leadCount = s => docs.filter(d => d.supplierId === s.id).length;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>供应商</h1><div class="sub">统一名称 + 别名（如 Raiffeisen Weser-Elbe eG = WRE），默认付款天数用于自动推算到期日</div></div>
      <div class="head-actions"><button class="btn primary" id="btn-new-sup">＋ 新增供应商</button></div>
    </div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>名称</th><th>别名</th><th>默认付款天数</th><th>单据数</th><th class="wrap">备注</th><th>操作</th>
    </tr></thead><tbody id="sup-body"></tbody></table></div>
  `;

  const body = el.querySelector('#sup-body');
  body.innerHTML = suppliers.length ? suppliers.map(s => `<tr>
    <td><b>${escapeHtml(s.name)}</b></td>
    <td>${escapeHtml((s.aliases || []).join(' / ') || '—')}</td>
    <td>${s.defaultPayDays ? s.defaultPayDays + ' 天' : '手填'}</td>
    <td>${leadCount(s)}</td>
    <td class="wrap">${escapeHtml(s.note || '')}</td>
    <td><div class="row-actions">
      <button class="btn link sm" data-act="edit" data-id="${s.id}">编辑</button>
      <button class="btn link sm" data-act="del" data-id="${s.id}" style="color:var(--danger)">删除</button>
    </div></td>
  </tr>`).join('') : '<tr><td colspan="6" class="empty-tip">暂无供应商，点右上角新增</td></tr>';

  el.querySelector('#btn-new-sup').onclick = () => openSupForm(null, ctx);
  body.onclick = async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const sup = await db.suppliers.get(btn.dataset.id);
    if (!sup) return;
    if (btn.dataset.act === 'edit') openSupForm(sup, ctx);
    if (btn.dataset.act === 'del') {
      const n = docs.filter(d => d.supplierId === sup.id).length;
      const ok = await dlgConfirm(
        `确定删除供应商「${sup.name}」吗？${n ? `该供应商名下有 ${n} 张单据，删除后这些单据会变成"未指定供应商"。` : ''}`,
        { okText: '删除', danger: true });
      if (!ok) return;
      await deleteSupplier(sup.id);
      ctx.toast('已删除');
    }
  };
}

function openSupForm(sup, ctx) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  const isEdit = !!sup;
  const s = sup || { name: '', aliases: [], defaultPayDays: 14, note: '' };

  modal.className = '';
  modal.innerHTML = `
    <div class="m-title">${isEdit ? '编辑供应商' : '新增供应商'}<button class="m-close" id="m-close">✕</button></div>
    <div class="form-grid">
      <div class="fld full"><label>标准名称</label>
        <input id="fld-name" value="${escapeHtml(s.name)}" placeholder="如 Raiffeisen Weser-Elbe eG"></div>
      <div class="fld full"><label>别名（逗号分隔，如 Raiffeisen, WRE）</label>
        <input id="fld-aliases" value="${escapeHtml((s.aliases || []).join(', '))}"></div>
      <div class="fld"><label>默认付款天数（0 = 到期日手填）</label>
        <input id="fld-paydays" type="number" min="0" step="1" value="${s.defaultPayDays || 0}"></div>
      <div class="fld"><label>备注</label>
        <input id="fld-note" value="${escapeHtml(s.note || '')}"></div>
    </div>
    <div class="m-error" id="m-error" hidden></div>
    <div class="m-btns">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn primary" id="m-save">保存</button>
    </div>
  `;
  overlay.hidden = false;

  const $ = id => modal.querySelector('#' + id);
  const close = () => { overlay.hidden = true; modal.innerHTML = ''; };
  $('m-close').onclick = close;
  $('m-cancel').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };

  $('m-save').onclick = async () => {
    const name = $('fld-name').value.trim();
    if (!name) { $('m-error').textContent = '请填写名称'; $('m-error').hidden = false; return; }
    const row = {
      name,
      aliases: $('fld-aliases').value.split(/[,，]/).map(x => x.trim()).filter(Boolean),
      defaultPayDays: Math.max(0, Number($('fld-paydays').value) || 0),
      note: $('fld-note').value.trim(),
    };
    if (isEdit) {
      const payDaysChanged = sup.defaultPayDays !== row.defaultPayDays;
      await updateSupplier(sup.id, row);
      // 付款天数变更 → 按新天数重算该供应商所有未付单据的到期日（含 PDF 识别的明确日期，确认框提示）
      if (payDaysChanged && row.defaultPayDays > 0) {
        const openDocs = (await db.documents.where('supplierId').equals(sup.id).toArray())
          .filter(d => !['已付款', '已付', '已完成'].includes(d.payStatus));
        if (openDocs.length) {
          const ok = await dlgConfirm(
            `默认付款天数已改为 ${row.defaultPayDays} 天。\n按新天数重算 ${sup.name} 名下 ${openDocs.length} 张未付单据的到期日？\n（将覆盖现有到期日，含 PDF 识别的明确日期）`,
            { okText: '重算' });
          if (ok) {
            for (const d of openDocs) {
              const due = computeDueDate(d.docDate, row.defaultPayDays);
              if (due) await updateDocument(d.id, { dueDate: due });
            }
            ctx.toast(`已重算 ${openDocs.length} 张单据的到期日`);
          }
        }
      }
    } else {
      await addSupplier(row);
    }
    close();
    ctx.toast(isEdit ? '已保存' : '已新增');
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
