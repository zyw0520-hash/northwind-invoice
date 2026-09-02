// 单据台账视图：筛选、表格、新建/编辑表单（含重复检测、金额差异提示、PDF 附件）

import { db, addDocument, updateDocument, deleteDocument, getDocuments } from '../db.js';
import { computeAmounts, splitGross, computeDueDate, fmtEur, todayStr } from '../models.js';
import { findDuplicate, amountMismatch, dueClass } from '../sentinels.js';
import { exportDocumentsCsv } from '../csv.js';
import { dlgConfirm } from '../dialog.js';

const DOC_TYPES = ['发票', '送货单', '贷项通知单', '关税通知', '罚单', '租车费', '其他'];
const PAY_STATUSES = ['未付', '已付', '部分付', '待确认', '争议中', '催缴中'];
const TAX_RATES = [['0.19', '19%'], ['0.07', '7%'], ['0', '0%'], ['', '免税/未知']];

const filters = { type: '', supplierId: '', payStatus: '', month: '', keyword: '' };

let cache = { docs: [], suppliers: [], nameOf: {} };

export async function render(el, ctx) {
  const [docs, suppliers, pdfs] = await Promise.all([
    getDocuments(filters), db.suppliers.toArray(), db.pdfFiles.toArray(),
  ]);
  const nameOf = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const pdfIds = new Set(pdfs.map(p => p.docId));
  cache = { docs, suppliers, nameOf };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>单据台账</h1><div class="sub">一行一张单据 · 发票 / 送货单 / 关税 / 罚单统一管理</div></div>
      <div class="head-actions">
        <button class="btn" id="btn-export-csv">导出 CSV</button>
        <button class="btn primary" id="btn-new-doc">＋ 新建单据</button>
      </div>
    </div>
    <div class="filters">
      <select id="f-type"><option value="">全部类型</option>${DOC_TYPES.map(t => `<option ${filters.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="f-supplier"><option value="">全部供应商</option>${suppliers.map(s => `<option value="${s.id}" ${filters.supplierId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
      <select id="f-status"><option value="">全部状态</option>${PAY_STATUSES.map(t => `<option ${filters.payStatus === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input id="f-month" type="month" value="${filters.month}" title="按单据月份筛选">
      <input id="f-kw" type="search" placeholder="搜单据号 / 摘要" value="${escapeHtml(filters.keyword)}">
    </div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>类型</th><th>供应商</th><th>单据号</th><th>日期</th><th>到期日</th>
      <th style="text-align:right">净额</th><th style="text-align:right">总额</th><th>付款状态</th>
      <th class="wrap">摘要</th><th>PDF</th><th>操作</th>
    </tr></thead><tbody id="doc-body"></tbody></table></div>
    <div class="count-tip">共 ${docs.length} 张单据</div>
  `;

  const body = el.querySelector('#doc-body');
  if (!docs.length) {
    body.innerHTML = `<tr><td colspan="11" class="empty-tip">暂无单据 —— 点右上角「新建单据」开始登记</td></tr>`;
  } else {
    body.innerHTML = docs.map(d => docRow(d, nameOf, ctx.today, pdfIds)).join('');
  }

  // 筛选事件
  el.querySelector('#f-type').onchange = e => { filters.type = e.target.value; ctx.refresh(); };
  el.querySelector('#f-supplier').onchange = e => { filters.supplierId = e.target.value; ctx.refresh(); };
  el.querySelector('#f-status').onchange = e => { filters.payStatus = e.target.value; ctx.refresh(); };
  el.querySelector('#f-month').onchange = e => { filters.month = e.target.value; ctx.refresh(); };
  let kwTimer;
  el.querySelector('#f-kw').oninput = e => {
    clearTimeout(kwTimer);
    kwTimer = setTimeout(() => { filters.keyword = e.target.value; ctx.refresh(); }, 300);
  };

  el.querySelector('#btn-new-doc').onclick = () => openDocForm(null, ctx);
  el.querySelector('#btn-export-csv').onclick = () => exportDocumentsCsv(docs);

  body.onclick = e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const doc = cache.docs.find(d => d.id === btn.dataset.id);
    if (!doc) return;
    if (btn.dataset.act === 'edit') openDocForm(doc, ctx);
    if (btn.dataset.act === 'pdf') viewPdf(doc.id, doc);
    if (btn.dataset.act === 'del') removeDoc(doc, ctx);
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function docRow(d, nameOf, today, pdfIds) {
  const cls = dueClass(d, today);
  const statusBadge = cls === 'red' ? '<span class="badge b-red">已逾期</span>'
    : cls === 'yellow' ? '<span class="badge b-yellow">临近到期</span>'
    : d.payStatus ? `<span class="badge ${d.payStatus === '已付' ? 'b-green' : d.payStatus === '待确认' ? 'b-blue' : ''}">${d.payStatus}</span>`
    : '';
  return `<tr>
    <td>${d.type}</td>
    <td>${escapeHtml(nameOf[d.supplierId] || '<span style="color:var(--muted)">未指定</span>')}</td>
    <td>${escapeHtml(d.docNumber || '—')}</td>
    <td>${d.docDate || '—'}</td>
    <td>${d.dueDate || '—'}</td>
    <td class="num">${fmtEur(d.netAmount)}</td>
    <td class="num">${fmtEur(d.grossAmount)}</td>
    <td>${statusBadge || '—'}</td>
    <td class="wrap">${escapeHtml(d.summary || '')}</td>
    <td>${pdfIds?.has(d.id) ? `<button class="btn link sm" data-act="pdf" data-id="${d.id}">查看</button>` : '—'}</td>
    <td><div class="row-actions">
      <button class="btn link sm" data-act="edit" data-id="${d.id}">编辑</button>
      <button class="btn link sm" data-act="del" data-id="${d.id}" style="color:var(--danger)">删除</button>
    </div></td>
  </tr>`;
}

// ---------- PDF 附件（阶段1：仅存储与回看） ----------

async function viewPdf(docId, doc) {
  const rec = await db.pdfFiles.get(docId);
  if (!rec) return;
  const url = URL.createObjectURL(rec.blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- 表单弹层 ----------

function openDocForm(doc, ctx) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  const isEdit = !!doc;
  const d = doc || { type: '发票', docDate: ctx.today, payStatus: '未付' };

  const deliveries = cache.docs.filter(x => x.type === '送货单');
  const openLeads = []; // 挂线索在弹层里从库取
  db.leads.where('status').equals('等票中').toArray().then(leds => {
    const sel = modal.querySelector('#fld-relatedLead');
    if (sel) {
      sel.innerHTML = `<option value="">不挂线索</option>` + leds.map(l =>
        `<option value="${l.id}" ${d.relatedLeadId === l.id ? 'selected' : ''}>${escapeHtml(l.orderedBy || '')}：${escapeHtml(l.description || '')}</option>`).join('');
    }
  });

  modal.className = 'wide';
  modal.innerHTML = `
    <div class="m-title">${isEdit ? '编辑单据' : '新建单据'}<button class="m-close" id="m-close">✕</button></div>
    <div class="form-grid">
      <div class="fld"><label>类型</label>
        <select id="fld-type">${DOC_TYPES.map(t => `<option ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="fld"><label>供应商</label>
        <select id="fld-supplier"><option value="">— 未指定 —</option>${cache.suppliers.map(s =>
          `<option value="${s.id}" ${d.supplierId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>
      <div class="fld"><label>单据号 <span class="de">Rechnungsnummer / Lieferschein-Nr.</span></label>
        <input id="fld-number" value="${escapeHtml(d.docNumber || '')}" placeholder="如 6088047408"></div>
      <div class="fld"><label>单据日期 <span class="de">Rechnungsdatum</span></label>
        <input id="fld-date" type="date" value="${d.docDate || ''}"></div>
      <div class="fld"><label>净额 EUR <span class="de">Netto</span></label>
        <input id="fld-net" type="number" step="0.01" value="${d.netAmount ?? ''}"></div>
      <div class="fld"><label>税率</label>
        <select id="fld-rate">${TAX_RATES.map(([v, t]) =>
          `<option value="${v}" ${String(d.taxRate ?? '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="fld"><label>税额 EUR <span class="de">MwSt./USt.</span></label>
        <input id="fld-tax" type="number" step="0.01" value="${d.taxAmount ?? ''}"></div>
      <div class="fld"><label>含税总额 EUR <span class="de">Gesamtbetrag / Brutto</span></label>
        <input id="fld-gross" type="number" step="0.01" value="${d.grossAmount ?? ''}"></div>
      <div class="fld"><label>付款到期日 <span class="de">Fällig am</span></label>
        <input id="fld-due" type="date" value="${d.dueDate || ''}"></div>
      <div class="fld"><label>付款状态</label>
        <select id="fld-paystatus">${PAY_STATUSES.map(t => `<option ${d.payStatus === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="fld"><label>付款日期</label>
        <input id="fld-paydate" type="date" value="${d.payDate || ''}"></div>
      <div class="fld"><label>付款方式</label>
        <input id="fld-paymethod" value="${escapeHtml(d.payMethod || '')}" placeholder="银行转账 / 信用卡 / SEPA"></div>
      <div class="fld full"><label>对方 IBAN</label>
        <input id="fld-iban" value="${escapeHtml(d.counterpartyIban || '')}"></div>
      <div class="fld full"><label>摘要</label>
        <input id="fld-summary" value="${escapeHtml(d.summary || '')}" placeholder="买了什么 / 什么服务"></div>
      <div class="fld"><label>成本中心</label>
        <input id="fld-cost" value="${escapeHtml(d.costCenter || '')}"></div>
      <div class="fld"><label>存档位置</label>
        <input id="fld-archive" value="${escapeHtml(d.archiveNote || '')}" placeholder="PDF 文件名 / 路径备注"></div>
      <div class="fld full"><label>挂到送货单（可选）</label>
        <select id="fld-relatedDelivery"><option value="">不挂送货单</option>${deliveries.map(x =>
          `<option value="${x.id}" ${d.relatedDeliveryId === x.id ? 'selected' : ''}>${escapeHtml(x.docNumber || '')} · ${x.docDate} · ${escapeHtml(cache.nameOf[x.supplierId] || '')}</option>`).join('')}</select></div>
      <div class="fld full"><label>关联采购线索（可选，票到自动销账）</label>
        <select id="fld-relatedLead"><option value="">不挂线索</option></select></div>
      <div class="fld full"><label>PDF 附件（可选，保存后可随时查看）</label>
        <div class="pdf-zone" id="pdf-zone">拖入 PDF 或点击选择<input id="fld-pdf" type="file" accept="application/pdf" hidden></div>
        <div id="pdf-info" class="m-hint"></div></div>
      <div class="fld full"><label>备注</label>
        <input id="fld-note" value="${escapeHtml(d.note || '')}"></div>
    </div>
    <div class="m-error" id="m-error" hidden></div>
    <div class="m-btns">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn primary" id="m-save">保存</button>
    </div>
  `;
  overlay.hidden = false;

  const $ = id => modal.querySelector('#' + id);
  let pdfFile = null;

  // 金额联动：净额/税率 → 税额+总额；总额改动 → 反推净额税额
  let lastEdited = '';
  const recalc = () => {
    const net = $('fld-net').value === '' ? null : Number($('fld-net').value);
    const rate = $('fld-rate').value === '' ? null : Number($('fld-rate').value);
    if (lastEdited === 'gross') {
      if (net == null && $('fld-gross').value !== '') {
        const sp = splitGross(Number($('fld-gross').value), rate);
        if (sp) { $('fld-net').value = sp.netAmount; $('fld-tax').value = sp.taxAmount; }
      }
      return;
    }
    if (net != null) {
      const a = computeAmounts(net, rate);
      $('fld-tax').value = a.taxAmount ?? '';
      $('fld-gross').value = a.grossAmount ?? '';
    }
  };
  $('fld-net').oninput = () => { lastEdited = 'net'; recalc(); };
  $('fld-rate').onchange = () => { lastEdited = 'net'; recalc(); };
  $('fld-gross').oninput = () => { lastEdited = 'gross'; recalc(); };

  // 到期日自动推算：改供应商或日期且到期日为空时
  const maybeDue = () => {
    const sup = cache.suppliers.find(s => s.id === $('fld-supplier').value);
    const date = $('fld-date').value;
    if (sup && date && !$('fld-due').value) {
      const due = computeDueDate(date, sup.defaultPayDays);
      if (due) $('fld-due').value = due;
    }
  };
  $('fld-supplier').onchange = maybeDue;
  $('fld-date').onchange = maybeDue;

  // PDF 选择
  const zone = $('pdf-zone');
  zone.onclick = () => $('fld-pdf').click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave = () => zone.classList.remove('drag');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag'); pickPdf(e.dataTransfer.files[0]); };
  $('fld-pdf').onchange = e => pickPdf(e.target.files[0]);
  function pickPdf(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showErr('只能上传 PDF 文件'); return;
    }
    pdfFile = file;
    $('pdf-info').textContent = `已选择：${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
  }
  if (isEdit) {
    db.pdfFiles.get(doc.id).then(rec => {
      if (rec) $('pdf-info').textContent = `已有附件：${rec.name || 'PDF'}（保存后可查看）`;
    });
  }

  function showErr(msg) {
    const el = $('m-error');
    el.textContent = msg;
    el.hidden = false;
  }

  const close = () => { overlay.hidden = true; modal.innerHTML = ''; };
  $('m-close').onclick = close;
  $('m-cancel').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };

  $('m-save').onclick = async () => {
    try {
      const row = {
        type: $('fld-type').value,
        supplierId: $('fld-supplier').value || null,
        docNumber: $('fld-number').value.trim(),
        docDate: $('fld-date').value,
        netAmount: $('fld-net').value === '' ? null : Number($('fld-net').value),
        taxRate: $('fld-rate').value === '' ? null : Number($('fld-rate').value),
        taxAmount: $('fld-tax').value === '' ? null : Number($('fld-tax').value),
        grossAmount: $('fld-gross').value === '' ? null : Number($('fld-gross').value),
        dueDate: $('fld-due').value || null,
        payStatus: $('fld-paystatus').value,
        payDate: $('fld-paydate').value || null,
        payMethod: $('fld-paymethod').value.trim(),
        counterpartyIban: $('fld-iban').value.trim(),
        summary: $('fld-summary').value.trim(),
        costCenter: $('fld-cost').value.trim(),
        archiveNote: $('fld-archive').value.trim(),
        relatedDeliveryId: $('fld-relatedDelivery').value || null,
        relatedLeadId: $('fld-relatedLead').value || null,
        note: $('fld-note').value.trim(),
      };

      // 重复拦截：同供应商 + 同单据号
      const all = await db.documents.toArray();
      const dup = findDuplicate(all, row, isEdit ? doc.id : null);
      if (dup) {
        const goOn = await dlgConfirm(
          `已存在同供应商、同单据号的记录：\n${cache.nameOf[dup.supplierId] || ''} ${dup.docNumber}（${dup.docDate}）\n确定不是重复登记吗？`,
          { okText: '仍要保存', danger: true });
        if (!goOn) return;
      }

      // 金额差异提示：发票挂送货单
      if (row.relatedDeliveryId && row.type === '发票') {
        const delivery = all.find(x => x.id === row.relatedDeliveryId);
        const m = amountMismatch(row, delivery);
        if (m && !(isEdit && doc.relatedDeliveryId === row.relatedDeliveryId)) {
          const goOn = await dlgConfirm(m.message + '\n仍要保存吗？', { okText: '仍要保存' });
          if (!goOn) return;
        }
      }

      if (isEdit) await updateDocument(doc.id, row, pdfFile);
      else await addDocument(row, pdfFile);
      close();
      ctx.toast(isEdit ? '已保存' : '已登记');
    } catch (e) {
      showErr(e.message);
    }
  };
}

async function removeDoc(doc, ctx) {
  const ok = await dlgConfirm(`确定删除这条单据吗？\n${cache.nameOf[doc.supplierId] || ''} ${doc.docNumber || ''}（${doc.docDate}）\n删除后其他设备同步删除。`,
    { okText: '删除', danger: true });
  if (!ok) return;
  await deleteDocument(doc.id);
  ctx.toast('已删除');
}
