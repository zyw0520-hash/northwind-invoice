// 设置视图：云同步配置、提醒阈值、备份/恢复/快照、自测入口

import { db, getSetting, setSetting, clearAll } from '../db.js';
import { getSyncConfig, getSyncStatus, syncNow, notifySyncState } from '../sync.js';
import { exportJson, importJson, exportSnapshot, restoreSnapshot, takeSnapshot } from '../backup.js';
import { dlgConfirm, dlgAlert } from '../dialog.js';
import { runSelftest } from '../tests/selftest.js';
import { getAiConfig, aiTest } from '../ai.js';

export async function render(el, ctx) {
  const cfg = await getSyncConfig();
  const st = await getSyncStatus();
  const aiCfg = await getAiConfig();
  const snaps = (await db.snapshots.toArray()).sort((a, b) => b.id - a.id);
  const th = await getThresholds();

  el.innerHTML = `
    <div class="page-head"><div><h1>设置</h1></div></div>

    <div class="card">
      <h2>云同步（Supabase）</h2>
      <div class="m-hint" style="margin-bottom:10px">可复用记账 app 的同一个 Supabase 项目（sync_docs 表按表名区分，互不干扰）。同一账号下多台电脑数据自动互通。</div>
      <div class="form-grid">
        <div class="fld"><label>项目地址</label><input id="cfg-url" value="${escapeHtml(cfg?.url || '')}" placeholder="https://xxxx.supabase.co"></div>
        <div class="fld"><label>API Key（anon public）</label><input id="cfg-key" value="${escapeHtml(cfg?.key || '')}" placeholder="eyJhbGciOi..."></div>
      </div>
      <div class="m-btns" style="justify-content:flex-start">
        <button class="btn primary" id="btn-save-sync">保存配置</button>
        <button class="btn" id="btn-sync-now" ${st.configured ? '' : 'disabled'}>立即同步</button>
        ${st.configured ? `<span class="m-hint">${st.lastError ? `🔴 上次同步失败：${escapeHtml(st.lastError)}` : st.lastSyncAt ? `🟢 上次同步 ${new Date(st.lastSyncAt).toLocaleString('zh-CN')}` : '已配置，尚未同步'}</span>` : ''}
      </div>
    </div>

    <div class="card">
      <h2>AI 摘要（可选）</h2>
      <div class="m-hint" style="margin-bottom:10px">配置后拖入 PDF 会调用大模型理解发票内容（德语/英语）并生成中文摘要。发票文字会脱敏银行信息后发送到智谱服务器（open.bigmodel.cn），Key 只存本机浏览器；不配置则用本地关键词识别，功能不受影响。免费模型 glm-4-flash：注册后点右上角头像 →「API Keys」新建复制即可。</div>
      <div class="form-grid">
        <div class="fld"><label>API Key（智谱 GLM）</label><input id="ai-key" value="${escapeHtml(aiCfg.key)}" placeholder="粘贴 open.bigmodel.cn 的 API Key，留空=关闭"></div>
        <div class="fld"><label>模型</label><input id="ai-model" value="${escapeHtml(aiCfg.model)}" placeholder="glm-4-flash（免费）"></div>
      </div>
      <div class="m-btns" style="justify-content:flex-start">
        <button class="btn primary" id="btn-save-ai">保存配置</button>
        <button class="btn" id="btn-test-ai">测试连接</button>
        <span class="m-hint" id="ai-result"></span>
      </div>
    </div>

    <div class="card">
      <h2>提醒阈值</h2>
      <div class="form-grid">
        <div class="fld"><label>线索催票天数（等票超过 N 天提醒）</label><input id="th-lead" type="number" min="1" value="${th.leadDays}"></div>
        <div class="fld"><label>送货单等票天数（N 天没等到发票提醒）</label><input id="th-delivery" type="number" min="1" value="${th.deliveryDays}"></div>
        <div class="fld"><label>供应商画像倍数（距上次开票 > 历史间隔 × N）</label><input id="th-mult" type="number" step="0.1" min="1" value="${th.gapMult}"></div>
        <div class="fld"><label>金额差异提示阈值（%）</label><input id="th-mismatch" type="number" min="0" step="0.5" value="${th.mismatchPct}"></div>
      </div>
      <div class="m-btns" style="justify-content:flex-start"><button class="btn primary" id="btn-save-th">保存阈值</button></div>
    </div>

    <div class="card">
      <h2>备份与快照</h2>
      <div class="m-btns" style="justify-content:flex-start; margin-bottom:10px">
        <button class="btn" id="btn-export">导出 JSON 备份</button>
        <button class="btn" id="btn-import">导入备份</button>
        <button class="btn" id="btn-snap">立即拍快照</button>
      </div>
      <div class="m-hint" style="margin-bottom:8px">每日首次打开自动拍快照，保留最近 7 份。快照只存本机，可恢复或导出。</div>
      <div id="snap-list">
        ${snaps.length ? snaps.map(s => `
          <div class="todo-item">
            <span class="t-icon">📸</span>
            <div class="t-main">
              <div class="t-title">${s.day} · ${s.reason === 'daily' ? '自动' : '手动'}</div>
              <div class="t-sub">单据 ${s.counts.documents} / 线索 ${s.counts.leads} / 供应商 ${s.counts.suppliers}</div>
            </div>
            <div class="row-actions">
              <button class="btn link sm" data-act="snap-export" data-id="${s.id}">导出</button>
              <button class="btn link sm" data-act="snap-restore" data-id="${s.id}">恢复</button>
            </div>
          </div>`).join('') : '<div class="empty-tip">暂无快照</div>'}
      </div>
    </div>

    <div class="card">
      <h2>自测</h2>
      <div class="m-btns" style="justify-content:flex-start">
        <button class="btn" id="btn-selftest">运行功能自测</button>
        <button class="btn danger" id="btn-clear">清空全部数据</button>
      </div>
    </div>
  `;

  const $ = id => el.querySelector('#' + id);

  $('btn-save-sync').onclick = async () => {
    const url = $('cfg-url').value.trim();
    const key = $('cfg-key').value.trim();
    if (!url || !key) { await dlgAlert('项目地址和 Key 都要填'); return; }
    await setSetting('syncConfig', { url, key });
    notifySyncState();
    ctx.toast('已保存，正在首次同步…');
    try {
      const r = await syncNow();
      ctx.toast(`同步成功：拉取 ${r.pulled} 条 / 推送 ${r.pushed} 条`);
      ctx.refresh();
    } catch (e) {
      await dlgAlert('同步失败：' + e.message);
    }
  };
  $('btn-sync-now').onclick = async () => {
    ctx.toast('同步中…');
    try {
      const r = await syncNow();
      ctx.toast(`同步成功：拉取 ${r.pulled} 条 / 推送 ${r.pushed} 条`);
      ctx.refresh();
    } catch (e) {
      await dlgAlert('同步失败：' + e.message);
    }
  };

  $('btn-save-ai').onclick = async () => {
    const key = $('ai-key').value.trim();
    const model = $('ai-model').value.trim() || 'glm-4-flash';
    await setSetting('aiConfig', { key, model });
    ctx.toast(key ? 'AI 摘要已启用' : '已保存（Key 为空 = 关闭 AI 摘要）');
  };
  $('btn-test-ai').onclick = async () => {
    const key = $('ai-key').value.trim();
    if (!key) { $('ai-result').textContent = '请先填 API Key'; return; }
    $('ai-result').textContent = '测试中…';
    $('ai-result').textContent = await aiTest(key, $('ai-model').value.trim());
  };

  $('btn-save-th').onclick = async () => {
    await setSetting('thresholds', {
      leadDays: Math.max(1, Number($('th-lead').value) || 14),
      deliveryDays: Math.max(1, Number($('th-delivery').value) || 14),
      gapMult: Math.max(1, Number($('th-mult').value) || 1.5),
      mismatchPct: Math.max(0, Number($('th-mismatch').value) / 100 || 0.05),
    });
    ctx.toast('阈值已保存');
  };

  $('btn-export').onclick = () => exportJson();
  $('btn-import').onclick = () => importFlow(ctx);
  $('btn-snap').onclick = async () => { await takeSnapshot('manual'); ctx.toast('快照已拍'); ctx.refresh(); };

  $('snap-list').onclick = async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'snap-export') await exportSnapshot(Number(btn.dataset.id));
    if (btn.dataset.act === 'snap-restore') {
      const ok = await dlgConfirm('恢复快照会覆盖当前全部单据/线索/供应商数据（本机先自动备份到云端同步历史）。确定继续吗？', { okText: '恢复', danger: true });
      if (!ok) return;
      try {
        await restoreSnapshot(Number(btn.dataset.id));
        ctx.toast('已恢复');
        ctx.refresh();
      } catch (err) {
        await dlgAlert('恢复失败：' + err.message);
      }
    }
  };

  $('btn-selftest').onclick = async () => {
    const r = runSelftest();
    const fails = r.filter(x => !x.ok);
    await dlgAlert(fails.length
      ? `自测完成：${r.length - fails.length}/${r.length} 通过\n\n失败用例：\n` + fails.map(f => f.name).join('\n')
      : `自测全部通过：${r.length}/${r.length} ✅`);
  };

  $('btn-clear').onclick = async () => {
    const ok = await dlgConfirm('确定清空全部数据吗？此操作不可撤销（建议先导出备份）。', { okText: '清空', danger: true });
    if (!ok) return;
    await clearAll();
    ctx.toast('已清空');
    ctx.refresh();
  };
}

async function importFlow(ctx) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const r = await importJson(await file.text());
      ctx.toast(`导入成功：单据 ${r.documents} / 线索 ${r.leads} / 供应商 ${r.suppliers}`);
      ctx.refresh();
    } catch (e) {
      await dlgAlert('导入失败：' + e.message);
    }
  };
  input.click();
}

export async function getThresholds() {
  const t = await getSetting('thresholds', {});
  return {
    leadDays: t.leadDays || 14,
    deliveryDays: t.deliveryDays || 14,
    gapMult: t.gapMult || 1.5,
    mismatchPct: t.mismatchPct ?? 0.05,
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
