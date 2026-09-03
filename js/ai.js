// AI 摘要（可选）：调用 GLM 大模型理解发票原文并生成详细中文翻译摘要
// 隐私：仅发送脱敏后的文本到 open.bigmodel.cn；Key 只存本机 IndexedDB；未配置时静默跳过（用本地规则兜底）

import { getSetting } from './db.js';

const BASE = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const SYS = `你是应付会计助理。请将发票/单据原文（德语或英语）逐字翻译成详细中文摘要，供会计入账使用。格式要求：
1. 第一行：一句话概括业务类型（如"8月集装箱租赁费"）
2. 后面逐条翻译所有明细行：货号、品名、数量、单价、金额
3. 翻译付款条件、税率、其他重要信息
4. 只输出翻译内容，不要加引号或解释性文字
示例：
8月集装箱租赁费
L1003 可拆卸集装箱 3.0m³ 1.000个月 25.000 25.00
L1501 可拆卸集装箱 7.0m³ 1.000个月 65.000 65.00
净额90.00 19%增值税17.10 总额107.10
付款条件：14天内付款有折扣（截至14.09.2026）`;

export async function getAiConfig() {
  const c = await getSetting('aiConfig', {});
  return { key: c.key || '', model: c.model || 'glm-4-flash' };
}

// 发送前脱敏：IBAN、SWIFT-BIC、5位以上数字串（电话/税号/单据号/注册号）
export function maskSensitive(text) {
  return String(text || '')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[IBAN]')
    .replace(/((?:SWIFT-)?BIC\s*[:#]?\s*)[A-Z0-9]{8,11}/gi, '$1[BIC]')
    .replace(/\d{5,}/g, '[数字]');
}

// 生成摘要：未配置 Key 或任何失败均返回 null（调用方保持本地兜底结果）
export async function aiSummary(rawText) {
  const cfg = await getAiConfig();
  if (!cfg.key) return null;
  const text = maskSensitive(rawText).slice(0, 5000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: text },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = JSON.parse(await res.text());
    const s = String(data.choices?.[0]?.message?.content || '').trim()
      .replace(/^[「"'\s]+|[。」"'\s]+$/g, '');
    return s ? s.slice(0, 800) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 设置页「测试连接」：返回结果文本，不抛错
export async function aiTest(key, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(key || '').trim() },
      body: JSON.stringify({
        model: String(model || '').trim() || 'glm-4-flash',
        temperature: 0,
        messages: [{ role: 'user', content: '只回复两个字：正常' }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 401) return '❌ Key 无效（接口返回 401）';
      const body = await res.text().catch(() => '');
      return `❌ 接口返回 ${res.status}${body ? '：' + body.slice(0, 120) : ''}`;
    }
    const data = JSON.parse(await res.text());
    return '✅ 连接正常：' + String(data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    return '❌ 连接失败：' + (e.name === 'AbortError' ? '超时（15秒无响应）' : e.message);
  } finally {
    clearTimeout(timer);
  }
}
