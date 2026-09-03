// PDF 识别：pdf.js 懒加载提取文本 + 德语发票/送货单字段解析
// 解析器为纯函数（selftest 覆盖）；启发式规则，识别结果仅供填充表单，用户需核对

import { round2, addDays } from './models.js';

// ---------- pdf.js 懒加载（首次用到才注入 script，不拖慢启动） ----------

let pdfjsPromise = null;
function loadPdfJs() {
  if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'lib/pdf.min.js';
      s.onload = () => resolve(globalThis.pdfjsLib);
      s.onerror = () => { pdfjsPromise = null; reject(new Error('pdf.js 加载失败')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

// 提取前 N 页文本（发票关键字段几乎都在首页；逐行拼接）
export async function extractPdfText(file, maxPages = 5) {
  const pdfjsLib = await loadPdfJs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  const data = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data }).promise;
  } catch (e) {
    if (/password/i.test(e?.name + ' ' + e?.message)) throw new Error('PDF 已加密，无法识别');
    throw new Error('无法读取该 PDF');
  }
  const pages = Math.min(pdf.numPages, maxPages);
  const parts = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      line += it.str;
      if (it.hasEOL) { parts.push(line); line = ''; }
    }
    if (line) parts.push(line);
    page.cleanup?.();
  }
  return parts.join('\n').replace(/\u00a0/g, ' ');
}

// ---------- 日期 ----------

// 德语/ISO 日期 → 'YYYY-MM-DD'：'21.08.2026'、'2026-08-21'、'21/08/26'
export function parseDeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  const iso = (y, mo, d) => {
    y = +y; mo = +mo; d = +d;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, m[2], m[1]);
  }
  return null;
}

// ---------- 金额 ----------

// 行内金额候选（德式必须有两位小数，避免抓到数量/日期）；百分比token剔除
function amountCandidates(s) {
  const out = [];
  const re = /(?:€\s*)?(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?!\d)/g;
  let m;
  while ((m = re.exec(s))) {
    const after = s.slice(m.index + m[0].length);
    if (/^\s*%/.test(after)) continue;
    out.push(m[0].trim());
  }
  return out;
}

function amountAfterLabel(lines, labels, skipRe) {
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(label);
      if (!m) continue;
      if (skipRe && skipRe.test(lines[i])) continue;
      const rest = lines[i].slice(m.index + m[0].length);
      let cands = amountCandidates(rest);
      if (!cands.length && lines[i + 1] != null) cands = amountCandidates(lines[i + 1]); // 金额在下一行
      if (cands.length) return parseDeNumberDe(cands[0]);
    }
  }
  return null;
}

// 局部解析（candidates 已是规范德式金额）
function parseDeNumberDe(s) {
  const t = String(s).replace(/[€\s]/g, '');
  const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

const GROSS_LABELS = [
  /gesamtbetrag/i, /rechnungsbetrag/i, /gesamtsumme/i, /bruttobetrag/i,
  /zahlbetrag/i, /f[aä]lliger?\s+betrag/i, /brutto/i, /grand\s+total/i, /total\b/i, /\bsumme\b/i,
];
const NET_LABELS = [
  /nettobetrag/i, /\bnetto\b/i, /zwischensumme/i, /warenwert/i, /subtotal/i, /sub-total/i,
];

// ---------- 供应商名 ----------

const SUP_SUFFIX = /\b(GmbH|mbH|GbR|AG|KGaA|KG|OHG|UG|e\.?\s?K\.|eG|SE|Ltd|Limited|Inc|LLC)\b|[Hh]andels|[Ll]ogistik|[Ss]pedition|[Ii]mmobilien|[Tt]echnik|[Ss]ystem[e]?\b|[Ee]nergie|[Vv]ersorgung|[Ss]tadtwerke|[Aa]utohaus|\bbau\b|[Ll]andkreis|[Gg]emeinde|[Bb]eh[oö]rde|[Zz]ollamt?/;
// 词边界防误杀：'Muster'/'Industriepartner' 含 'ust'、'Baumann' 含 'bau' 等
const SUP_BAD = /\b(rechnung|lieferschein|invoice|beleg|datum|seite|page|kunde|kunden|iban|mwst|ust|steuer|telefon|fax|giro|sparkasse|volksbank|postbank|zahlung|zahlbar|skonto|menge|einzelpreis|gesamtpreis|gesamtsumme|positi|beschreibung|artikel|lfd|original|kopie|duplicat|betreff|bestell|blz|bank)\b|@|www\.|http|tel\./i;

function guessSupplierName(lines) {
  const head = lines.slice(0, 15).map(l => l.trim()).filter(l => l.length >= 4 && l.length <= 70);
  for (const l of head) {
    if (SUP_BAD.test(l)) continue;
    if (SUP_SUFFIX.test(l) && /[A-Za-z]{3}/.test(l)) return l.replace(/[\s\-.,;:]+$/, '');
  }
  for (const l of head) {
    if (SUP_BAD.test(l)) continue;
    if (/^[\d\s.,\-\/()#+*]+$/.test(l)) continue;
    if (/[A-Za-z]{3}/.test(l) && /\s/.test(l)) return l.replace(/[\s\-.,;:]+$/, '');
  }
  return null;
}

// ---------- 类型推断（仅明显关键词） ----------

export function inferDocType(text, docNumber) {
  const t = String(text);
  if (/gutschrift/i.test(t)) return '贷项通知单';
  if (!docNumber && /lieferschein\s*-?\s*(?:nummer|nr\.?)/i.test(t)) return '送货单';
  return null;
}

// ---------- 主解析 ----------

// 德语发票文本 → 字段对象（全部字段可能为 null，启发式识别）
export function parseInvoiceText(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim().replace(/\s+/g, ' '));
  const res = {
    supplierName: null, docNumber: null, docDate: null, dueDate: null,
    netAmount: null, taxRate: null, taxAmount: null, grossAmount: null,
    iban: null, costCenter: null, summary: null,
  };

  const NUM_STOP = /^(vom|vom$|datum|nr|rechnung|lieferschein|beleg|seite|kunde)$/i;
  const DATE_TOKEN = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[.\/\-]\d{1,2}[.\/\-]\d{2,4})\b/;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // 单据号
    if (!res.docNumber) {
      const m = ln.match(/(?:rechnungs\s*-?\s*(?:nummer|nr\.?)|lieferschein\s*-?\s*(?:nummer|nr\.?)|beleg\s*-?\s*(?:nummer|nr\.?)|invoice\s*(?:no\.?|number|#))\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\/\-.]{1,29})/i);
      if (m && !NUM_STOP.test(m[1]) && !DATE_TOKEN.test(m[1])) res.docNumber = m[1];
    }

    // 单据日期
    if (!res.docDate) {
      const m = ln.match(/(?:rechnungs(?:-?\s?datum)|belegdatum|fakturadatum|ausstellungsdatum|invoice\s*date)\s*[:#]?/i)
        || ln.match(/(?:^|[\s:,.])datum\s*[:#]?/i);
      if (m) {
        const dm = ln.slice(m.index + m[0].length).match(DATE_TOKEN) || (lines[i + 1] ? lines[i + 1].match(DATE_TOKEN) : null);
        if (dm) res.docDate = parseDeDate(dm[1]);
      }
    }

    // 到期日
    if (!res.dueDate) {
      const m = ln.match(/(?:f(?:ae|[aä])llig(?:keit|keitsdatum|es\s*datum)?(?:\s*(?:am|bis|datum))?|zahlbar(?:\s*bis)?|zahlungsziel|zahlungstermin|due\s*date)\s*[:#]?/i);
      if (m) {
        const dm = ln.slice(m.index + m[0].length).match(DATE_TOKEN) || (lines[i + 1] ? lines[i + 1].match(DATE_TOKEN) : null);
        if (dm) res.dueDate = parseDeDate(dm[1]);
      }
    }

    // IBAN（仅带标签的行；截断 BIC/SWIFT）
    if (res.iban == null && /\biban\b/i.test(ln)) {
      const m = ln.match(/\biban(?:-?nr\.?)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 \-]{6,42})/i);
      if (m) {
        const raw = m[1].split(/\s+(?:BIC|SWIFT)\b/i)[0].replace(/[\s\-]/g, '').toUpperCase();
        if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(raw)) res.iban = raw;
      }
    }

    // 成本中心
    if (!res.costCenter) {
      const m = ln.match(/(?:kostenstelle|kosten-?\s?nr\.?|cost\s*center)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\/\-.]{0,30})/i);
      if (m && !NUM_STOP.test(m[1])) res.costCenter = m[1];
    }

    // 摘要：Bezeichnung 标签后的描述文本（值同行；为空时取下一行非标签行）
    if (!res.summary) {
      const m = ln.match(/(?:^|\s)bezeichnung\s*[:\-]?\s*(.*)$/i);
      if (m) {
        let v = (m[1] || '').trim();
        if (!v && lines[i + 1]) v = lines[i + 1].trim();
        // 排除：表格列头（Pos Bezeichnung Menge ...）、纯数字/日期、疑似其他标签
        const isTableHeader = /\b(menge|einzelpreis|preis|gesamt|zwischensumme|mwst|ust|steuer|nummer|datum|iban|seite|menge\b|betrag)\b/i.test(v);
        const looksLikeLabel = /^(iban|mwst|ust|steuer|datum|rechnung|lieferschein|kunde|zahlbar|zahlungsziel|faellig|f[aä]llig|kostenstelle|hinweis|summ)/i.test(v);
        if (v && v.length <= 120 && /[A-Za-z]{3}/.test(v) && !/^\d/.test(v) && !isTableHeader && !looksLikeLabel) {
          res.summary = v;
        }
      }
    }
  }

  // 供应商名（前 15 行）
  res.supplierName = guessSupplierName(lines);

  // 总额 / 净额（按标签优先级逐行扫描）
  res.grossAmount = amountAfterLabel(lines, GROSS_LABELS, /netto/i);
  res.netAmount = amountAfterLabel(lines, NET_LABELS, /(mwst|umsatzsteuer|\bust\b|\bvat\b|brutto|gesam)/i);

  // 税率 + 税额：找含 % 的税行；已知净额时优先取 ≈ 净额×税率 的金额
  for (const ln of lines) {
    if (!/(mwst|umsatzsteuer|\bust\b|\bvat\b)/i.test(ln)) continue;
    const rm = ln.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
    if (!rm) continue;
    const rate = parseDeNumberDe(rm[1].replace('.', ','));
    if (rate == null || rate <= 0 || rate > 30) continue;
    const cands = amountCandidates(ln).map(parseDeNumberDe).filter(n => n != null);
    if (!cands.length) continue;
    let amt;
    if (res.netAmount != null) {
      const expected = round2(res.netAmount * rate / 100);
      amt = cands.find(a => Math.abs(a - expected) < 0.02) ?? cands[cands.length - 1];
    } else {
      amt = cands[cands.length - 1];
    }
    res.taxRate = rate / 100;
    res.taxAmount = amt;
    break;
  }

  // 交叉推算：缺失字段由其余字段补齐
  if (res.taxAmount == null && res.grossAmount != null && res.netAmount != null) {
    const diff = round2(res.grossAmount - res.netAmount);
    if (diff > 0.005) {
      res.taxAmount = diff;
      if (Math.abs(round2(res.netAmount * 0.19) - diff) < 0.05) res.taxRate = 0.19;
      else if (Math.abs(round2(res.netAmount * 0.07) - diff) < 0.05) res.taxRate = 0.07;
    }
  }
  if (res.netAmount == null && res.grossAmount != null && res.taxAmount != null) {
    res.netAmount = round2(res.grossAmount - res.taxAmount);
  }
  if (res.grossAmount == null && res.netAmount != null && res.taxAmount != null) {
    res.grossAmount = round2(res.netAmount + res.taxAmount);
  }
  // 总额兜底：取全文最大金额（IBAN/数量/日期无两位小数，不会成为候选）
  if (res.grossAmount == null) {
    let mx = null;
    for (const ln of lines) for (const c of amountCandidates(ln)) {
      const n = parseDeNumberDe(c);
      if (n != null && n > 0 && (mx == null || n > mx)) mx = n;
    }
    res.grossAmount = mx;
  }

  // 按天数推算到期日：'Zahlbar innerhalb 14 Tagen'、'Zahlungsziel: 30 Tage netto' 等
  if (!res.dueDate && res.docDate) {
    const m = String(text).match(/(?:zahlungsziel|zahlbar|zahlung)\s*[:\-]?\s*(?:innerhalb\s+(?:von\s+)?|von\s+)?(\d{1,3})\s*(?:tage|tagen|days)\b/i);
    if (m) res.dueDate = addDays(res.docDate, +m[1]);
  }

  return res;
}
