// 采购线索视图：预登记（手动/PDF辅助）、等票中列表（含超期天数）、已销账/取消归档

import { db, addLead, updateLead, deleteLead, addSupplier } from '../db.js';
import { daysBetween, todayStr, fmtEur } from '../models.js';
import { dlgConfirm, dlgPrompt } from '../dialog.js';
import { extractPdfText } from '../pdfParse.js';

export async function render(el, ctx) {
  const [leads, suppliers, pdfs] = await Promise.all([
    db.leads.toArray(), db.suppliers.toArray(), db.pdfFiles.toArray()
  ]);
  const nameOf = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const today = todayStr();
  const leadPdf = Object.fromEntries(pdfs.filter(p => p.docId && leads.some(l => l.id === p.docId)).map(p => [p.docId, true]));

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
    const hasPdf = leadPdf[l.id];
    return `<div class="todo-item">
      <span class="t-icon">${closedStyle ? (l.status === '已销账' ? '✅' : '🚫') : overdue ? '🟡' : '📡'}</span>
      <div class="t-main">
        <div class="t-title">${escapeHtml(l.orderedBy || '未记下单人')}：${escapeHtml(l.description || '（未记内容）')}${hasPdf ? ' 📎' : ''}</div>
        <div class="t-sub">${escapeHtml(nameOf[l.supplierId] || '供应商未确认')}${l.estAmount != null ? ` · 约 ${fmtEur(l.estAmount)}` : ''} · 登记 ${l.registeredDate}${l.expectedDate ? ` · 期望 ${l.expectedDate}` : ''}${l.resolvedDocId ? ' · 已关联票据' : ''}</div>
      </div>
      ${closedStyle ? `<span class="badge ${l.status === '已销账' ? 'b-green' : ''}">${l.status}</span>` : `<span class="t-days ${overdue ? 'd-yellow' : ''}">${days != null ? days + ' 天' : ''}</span>`}
      <div class="row-actions">
        <label class="btn link sm" style="cursor:pointer">📎<input type="file" accept="application/pdf" data-act="upload" data-id="${l.id}" hidden></label>
        <button class="btn link sm" data-act="edit" data-id="${l.id}">编辑</button>
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

  el.querySelector('#btn-new-lead').onclick = () => openLeadForm(null, ctx);

  el.querySelector('#lead-open').onclick = e => handleLeadAction(e, ctx, false);
  el.querySelector('#lead-closed').onclick = e => handleLeadAction(e, ctx, true);
}

async function handleLeadAction(e, ctx, closedArea) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const lead = await db.leads.get(btn.dataset.id);
  if (!lead) return;
  const act = btn.dataset.act;

  if (act === 'upload') {
    const file = btn.files?.[0];
    btn.value = ''; // 允许重复选同一文件
    if (!file) return;
    await uploadPdfToLead(lead.id, file, ctx);
    return;
  }
  if (act === 'edit') {
    await openLeadForm(lead, ctx);
    return;
  }
  if (act === 'done') {
    await updateLead(lead.id, { status: '已销账' });
    ctx.toast('线索已销账');
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

async function uploadPdfToLead(leadId, file, ctx) {
  ctx.toast('正在提取 PDF 文本…');
  let text;
  try { text = await extractPdfText(file); }
  catch { ctx.toast('⚠ 无法提取文本（扫描版？），仅存档'); text = ''; }

  // 存 PDF 到 pdfFiles（用 leadId 作 docId，加备注区分）
  const existing = await db.pdfFiles.where('docId').equals(leadId).first();
  const rec = {
    docId: leadId,
    leadId,
    blob: file,
    fileName: file.name,
    uploadedAt: Date.now(),
    parsedText: text.slice(0, 5000),
  };
  if (existing) await db.pdfFiles.update(existing.docId, rec);
  else await db.pdfFiles.add(rec);
  ctx.toast('📎 PDF 已存档');

  // 如果线索还缺少关键字段，尝试从 PDF 补齐（不覆盖已填内容）
  if (text) {
    const parsed = parseLeadEmail(text);
    const lead = await db.leads.get(leadId);
    const patch = {};
    const suppliers = await db.suppliers.toArray();
    if (!lead.orderedBy && parsed.orderedBy) patch.orderedBy = parsed.orderedBy;
    if (!lead.description && parsed.description) patch.description = parsed.description;
    if (!lead.supplierId && parsed.supplierName) {
      const hit = suppliers.find(s => s.name.toLowerCase() === parsed.supplierName.toLowerCase() ||
        (s.aliases || []).some(a => a.toLowerCase() === parsed.supplierName.toLowerCase()));
      patch.supplierId = hit?.id || await addSupplier({
        name: parsed.supplierName, aliases: [], defaultPayDays: null,
        note: '邮件PDF识别自动新增（请补充别名/付款天数）',
      });
    }
    if (lead.estAmount == null && parsed.estAmount) patch.estAmount = parsed.estAmount;
    if (!lead.expectedDate && parsed.expectedDate) patch.expectedDate = parsed.expectedDate;
    if (Object.keys(patch).length) {
      await updateLead(leadId, patch);
      ctx.toast('✅ 已从 PDF 补填线索字段');
    }
  }
}

// ---------- 线索表单弹窗（手动新增 / 编辑 / PDF辅助） ----------
async function openLeadForm(existing, ctx) {
  const suppliers = await db.suppliers.toArray();
  const isEdit = !!existing;
  const d = existing || {
    orderedBy: '', description: '', supplierId: null, estAmount: null,
    registeredDate: ctx.today, expectedDate: null, status: '等票中',
  };

  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  const $ = id => modal.querySelector('#' + id);

  modal.innerHTML = `
    <h2>${isEdit ? '编辑线索' : '新增线索'}</h2>
    <div class="form-grid">
      <div class="fld"><label>下单人</label><input id="lf-orderedBy" value="${escapeHtml(d.orderedBy || '')}" placeholder="Alex / 厂长"></div>
      <div class="fld"><label>供应商</label>
        <select id="lf-supplier"><option value="">— 未确认 —</option>${suppliers.map(s => `<option value="${s.id}" ${d.supplierId === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
      </div>
      <div class="fld"><label>预估金额（€）</label><input id="lf-amt" type="number" step="0.01" value="${d.estAmount ?? ''}" placeholder="不确定留空"></div>
      <div class="fld"><label>登记日期</label><input id="lf-regdate" type="date" value="${d.registeredDate || ctx.today}"></div>
      <div class="fld"><label>预计交付日</label><input id="lf-expdate" type="date" value="${d.expectedDate || ''}" placeholder="留空=不确定"></div>
      ${isEdit ? `<div class="fld"><label>状态</label>
        <select id="lf-status">${['等票中', '已销账', '已取消'].map(s => `<option ${d.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>` : ''}
      <div class="fld full"><label>内容描述</label><textarea id="lf-desc" rows="3" placeholder="买了什么 / 什么服务">${escapeHtml(d.description || '')}</textarea></div>
      <div class="fld full">
        <label>📎 上传邮件 PDF（可选，自动识别填充空字段）</label>
        <input id="lf-pdf" type="file" accept="application/pdf" style="padding:5px">
        <div id="lf-pdf-info" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
      </div>
    </div>
    <div class="m-btns">
      <button class="btn" id="lf-cancel">取消</button>
      <button class="btn primary" id="lf-save">保存</button>
    </div>
  `;
  overlay.hidden = false;

  let pdfParsed = null;
  $('lf-pdf').onchange = async () => {
    const file = $('lf-pdf').files[0];
    if (!file) { $('lf-pdf-info').textContent = ''; return; }
    $('lf-pdf-info').textContent = '⏳ 正在提取…';
    let text;
    try { text = await extractPdfText(file); }
    catch { $('lf-pdf-info').textContent = '⚠ 无法提取文本（扫描版？）'; return; }
    pdfParsed = parseLeadEmail(text);

    // 填充空字段（不覆盖已填内容）
    if (!$('lf-orderedBy').value.trim() && pdfParsed.orderedBy) $('lf-orderedBy').value = pdfParsed.orderedBy;
    if (!$('lf-desc').value.trim() && pdfParsed.description) $('lf-desc').value = pdfParsed.description;
    if (!$('lf-amt').value && pdfParsed.estAmount) $('lf-amt').value = pdfParsed.estAmount;
    if (!$('lf-expdate').value && pdfParsed.expectedDate) $('lf-expdate').value = pdfParsed.expectedDate;
    if (!$('lf-supplier').value && pdfParsed.supplierName) {
      const hit = suppliers.find(s => s.name.toLowerCase() === pdfParsed.supplierName.toLowerCase());
      if (hit) { $('lf-supplier').value = hit.id; }
      else {
        const newId = await addSupplier({ name: pdfParsed.supplierName, aliases: [], defaultPayDays: null, note: '邮件PDF识别自动新增' });
        suppliers.push({ id: newId, name: pdfParsed.supplierName });
        $('lf-supplier').innerHTML += `<option value="${newId}" selected>${pdfParsed.supplierName}</option>`;
      }
    }

    const filled = [];
    if (pdfParsed.supplierName) filled.push('供应商 ' + pdfParsed.supplierName);
    if (pdfParsed.description) filled.push('内容');
    if (pdfParsed.estAmount) filled.push('金额');
    if (pdfParsed.expectedDate) filled.push('日期');
    $('lf-pdf-info').textContent = `✅ 已识别：${filled.join('、')}（可手动修改）`;
  };

  $('lf-cancel').onclick = () => { overlay.hidden = true; pdfParsed = null; };
  $('lf-save').onclick = async () => {
    const orderedBy = $('lf-orderedBy').value.trim() || '未记';
    const description = $('lf-desc').value.trim();
    if (!description) { ctx.toast('⚠ 请填写内容描述'); return; }
    const supplierId = $('lf-supplier').value || null;
    const amt = $('lf-amt').value;
    const estAmount = amt ? Number(amt) : null;
    const registeredDate = $('lf-regdate').value || ctx.today;
    const expectedDate = $('lf-expdate').value || null;

    // 如果是新建且选了 PDF，先 addLead 拿到 id 再存 pdfFiles
    const fileInput = $('lf-pdf');
    if (isEdit) {
      const patch = { orderedBy, description, supplierId, estAmount, registeredDate, expectedDate };
      if ($('lf-status')) patch.status = $('lf-status').value;
      await updateLead(existing.id, patch);
      ctx.toast('已更新线索');
    } else {
      const leadId = await addLead({ orderedBy, description, supplierId, estAmount, registeredDate, expectedDate, status: '等票中' });
      if (fileInput.files[0]) {
        await db.pdfFiles.add({
          docId: leadId,
          blob: fileInput.files[0],
          fileName: fileInput.files[0].name,
          uploadedAt: Date.now(),
        });
      }
      ctx.toast('✅ 线索已登记');
    }
    overlay.hidden = true;
  };
}

// ---------- 邮件/报价PDF → 线索字段 ----------
export function parseLeadEmail(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim());
  const result = { supplierName: null, orderedBy: null, description: null, estAmount: null, expectedDate: null };

  // 供应商名：前 10 行里的公司名（带 GmbH/eG/KG/AG 后缀）
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const l = lines[i];
    if (/(GmbH|eG|KG|AG|UG\s*\(haftungsbeschränkt\)|Ltd|LLC)\b/i.test(l) && l.length < 80) {
      result.supplierName = l.replace(/[^\p{L}\p{N}\s&.\-]/gu, ' ').replace(/\s+/g, ' ').trim();
      break;
    }
  }

  // 下单人：Bestellt von / Besteller / Von / Auftraggeber
  for (const l of lines) {
    const m = l.match(/\b(bestellt\s*von|besteller|von\s+|auftraggeber|anfrage\s+von)\b\s*[:#]?\s*(.{2,60})/i);
    if (m) { result.orderedBy = m[2].split(/[,，]/)[0].trim(); break; }
  }

  // 内容描述：从 Angebot/Auftrag/Bestellung/Lieferung 标签值 + 货品关键词兜底
  const descLines = [];
  for (const l of lines) {
    if (!l || l.length > 120) continue;
    if (/\b(anfrage|bestellung|auftrag|angebot|lieferung)\b/i.test(l)) continue;
    if (/\b(menge|einheit|preis|betrag|datum|nummer|grund|steuer|mwst|ust)\b/i.test(l)) continue;
    if (/^(firma|anbieter|lieferant|empfänger|lieferadresse|rechnungsadresse|kontakt|iban|bank|ust|telefon|fax|e-?mail|www|seite|druck)\b/i.test(l)) continue;
    if (/\b(position|artikel|beschreibung|gegenstand|leistungsbeschreibung)\b/i.test(l)) {
      const m = l.match(/[:#]\s*(.{4,})/);
      if (m) descLines.push(m[1].trim());
    }
  }
  if (!descLines.length) {
    const skip = result.supplierName ? new RegExp('^' + result.supplierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const g = lines.find(l =>
      (!skip || !skip.test(l)) &&
      /(palette|container|diesel|öl|reifen|filter|schraube|blech|rohr|beton|sand|kies|holz|stahl|draht|band|folie|behälter|containerdienst|abfall|recycling|transport|logistik|wartung|reparatur|instandhaltung|prüfung|inspektion|schulung|beratung|software|lizenz|miete|leasing|versicherung|europalette|gitterbox|aufsatzrahmen)/i.test(l));
    if (g) descLines.push(g.replace(/^\d+\s+/, '').trim());
  }
  if (descLines.length) result.description = descLines.slice(0, 2).join(' / ').slice(0, 120);

  // 预估金额
  for (const l of lines) {
    const m = l.match(/(gesamtbetrag|summe|betrag|preis|angebotspreis)\s*[:#]?\s*([\d.,]+)/i);
    if (m) {
      const n = parseFloat(m[2].replace(/\./g, '').replace(',', '.'));
      if (n > 1 && n < 999999) { result.estAmount = Math.round(n * 100) / 100; break; }
    }
  }

  // 预计日期
  for (const l of lines) {
    const dm = l.match(/\b(\d{1,2}[.\/\-]\d{1,2}[.\/\-]\d{2,4})\b/);
    if (!dm) continue;
    if (/(lieferzeit|lieferdatum|termin|vereinbart|frist|innerhalb|ab)/i.test(l)) {
      const parts = dm[1].replace(/[.\-\/]/g, '.').split('.');
      if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
        const day = parts[0], mon = parts[1], yr = parts[2].length === 2 ? '20' + parts[2] : parts[2];
        const dt = new Date(+yr, +mon - 1, +day);
        if (dt.getFullYear() >= 2025 && dt.getFullYear() <= 2030) {
          result.expectedDate = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`; break;
        }
      }
    }
  }

  return result;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
