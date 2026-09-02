// 应用内对话框：dlgPrompt / dlgConfirm / dlgAlert
// 替代原生 prompt/confirm/alert —— 原生弹窗在 iOS PWA 独立模式下被禁用，
// 自绘弹窗全平台可用；promise 式异步调用，支持点遮罩取消、回车提交

let overlay = null;

function getOverlay() {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'dlg-overlay';
    overlay.hidden = true;
    document.body.appendChild(overlay);
  }
  return overlay;
}

function teardown() {
  const el = getOverlay();
  el.hidden = true;
  el.innerHTML = '';
  el.onclick = null;
}

function build({ message, input = false, defaultValue = '', okText = '确定', cancelText = null, danger = false }) {
  const el = getOverlay();
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'dlg';

  const msg = document.createElement('div');
  msg.className = 'dlg-msg';
  msg.textContent = message;
  box.appendChild(msg);

  let inputEl = null;
  if (input) {
    inputEl = document.createElement('input');
    inputEl.className = 'dlg-input';
    inputEl.value = defaultValue ?? '';
    box.appendChild(inputEl);
  }

  const btns = document.createElement('div');
  btns.className = 'dlg-btns';
  let cancelBtn = null;
  if (cancelText) {
    cancelBtn = document.createElement('button');
    cancelBtn.className = 'dlg-btn';
    cancelBtn.textContent = cancelText;
    btns.appendChild(cancelBtn);
  }
  const okBtn = document.createElement('button');
  okBtn.className = 'dlg-btn primary' + (danger ? ' danger' : '');
  okBtn.textContent = okText;
  btns.appendChild(okBtn);
  box.appendChild(btns);

  el.appendChild(box);
  el.hidden = false;
  return { box, okBtn, cancelBtn, inputEl };
}

// 返回输入值；取消返回 null
export function dlgPrompt(message, defaultValue = '') {
  return new Promise(resolve => {
    const { okBtn, cancelBtn, inputEl } = build({ message, input: true, defaultValue, cancelText: '取消' });
    const done = v => { teardown(); resolve(v); };
    okBtn.onclick = () => done(inputEl.value);
    cancelBtn.onclick = () => done(null);
    getOverlay().onclick = e => { if (e.target === getOverlay()) done(null); };
    inputEl.onkeydown = e => { if (e.key === 'Enter') done(inputEl.value); };
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
  });
}

// 返回 true / false
export function dlgConfirm(message, { okText = '确定', danger = false } = {}) {
  return new Promise(resolve => {
    const { okBtn, cancelBtn } = build({ message, okText, cancelText: '取消', danger });
    const done = v => { teardown(); resolve(v); };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    getOverlay().onclick = e => { if (e.target === getOverlay()) done(false); };
  });
}

export function dlgAlert(message) {
  return new Promise(resolve => {
    const { okBtn } = build({ message });
    const done = () => { teardown(); resolve(); };
    okBtn.onclick = done;
    getOverlay().onclick = e => { if (e.target === getOverlay()) done(); };
  });
}
