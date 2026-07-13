export const WIZARD_CSS = `
:root { color-scheme: light; font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif; color: #17221d; background: #f4f6f5; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: #f4f6f5; }
header { background: #173f35; color: #fff; padding: 20px max(20px, calc((100vw - 1120px) / 2)); }
header h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: 0; }
main { width: min(1120px, calc(100% - 32px)); margin: 24px auto 48px; }
form { display: grid; background: #fff; border: 1px solid #d9dfdc; border-radius: 6px; overflow: hidden; }
section { background: transparent; border: 0; border-bottom: 1px solid #dfe4e2; border-radius: 0; padding: 20px; }
section:last-of-type { border-bottom: 0; }
h2 { margin: 0 0 16px; font-size: 17px; letter-spacing: 0; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.field { min-width: 0; display: grid; gap: 6px; }
label { font-size: 13px; font-weight: 600; color: #3b4943; }
input, select { width: 100%; min-height: 40px; border: 1px solid #aab5b0; border-radius: 5px; padding: 8px 10px; background: #fff; color: #17221d; font: inherit; }
input:focus, select:focus, button:focus-visible { outline: 3px solid rgba(22, 121, 92, .24); outline-offset: 1px; border-color: #16795c; }
.warehouse { display: grid; grid-template-columns: 1.1fr 1.1fr 1fr 1fr .7fr 40px; gap: 10px; align-items: end; padding: 12px 0; border-top: 1px solid #e5e9e7; }
.warehouse:first-child { border-top: 0; padding-top: 0; }
.icon-button { width: 40px; height: 40px; border: 1px solid #c9d0cd; background: #fff; border-radius: 5px; font-size: 22px; cursor: pointer; }
.icon-button:hover { background: #f0f3f2; }
.actions { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 16px 20px; }
section .actions { padding: 0; }
button { min-height: 40px; border-radius: 5px; border: 1px solid transparent; padding: 8px 16px; font: inherit; cursor: pointer; }
.primary { background: #16795c; color: #fff; font-weight: 650; }
.primary:hover { background: #0f664c; }
.secondary { background: #fff; border-color: #aab5b0; color: #24322c; }
.status { min-height: 22px; font-size: 14px; color: #a0312f; }
.quick { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
.quick input { width: 18px; min-height: 18px; }
[hidden] { display: none !important; }
@media (max-width: 840px) { .grid { grid-template-columns: 1fr 1fr; } .warehouse { grid-template-columns: 1fr 1fr; } .warehouse .icon-button { justify-self: end; } }
@media (max-width: 560px) { main { width: min(100% - 20px, 1120px); margin-top: 12px; } section { padding: 16px; } .grid, .warehouse { grid-template-columns: 1fr; } .warehouse .icon-button { justify-self: start; } .actions { align-items: stretch; flex-direction: column; } .actions button { width: 100%; } }
`;

export const WIZARD_JS = `
const params = new URLSearchParams(location.search);
const nonce = params.get('nonce');
const form = document.querySelector('form');
const warehouses = document.querySelector('#warehouses');
const status = document.querySelector('#status');
const quickToggle = document.querySelector('#quick-enabled');
const quickFields = document.querySelector('#quick-fields');

function field(label, name, value = '', type = 'text') {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  const caption = document.createElement('label');
  caption.textContent = label;
  const input = document.createElement('input');
  input.name = name;
  input.type = type;
  input.value = value;
  input.required = true;
  caption.append(input);
  wrapper.append(caption);
  return wrapper;
}

function addWarehouse(item = {}) {
  const row = document.createElement('div');
  row.className = 'warehouse';
  row.append(field('仓库名称', 'warehouseName', item.warehouseName));
  row.append(field('仓库编号', 'warehouseId', item.warehouseId));
  row.append(field('收货人', 'receiver', item.receiver));
  row.append(field('联系电话', 'receiverPhone', item.receiverPhone, 'tel'));
  const nutrition = document.createElement('div');
  nutrition.className = 'field';
  nutrition.innerHTML = '<label>采购类型<select name="nutrition"><option value="0">普通</option><option value="1">营养餐</option></select></label>';
  nutrition.querySelector('select').value = String(item.nutrition || 0);
  row.append(nutrition);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button';
  remove.title = '删除仓库';
  remove.setAttribute('aria-label', '删除仓库');
  remove.textContent = '×';
  remove.addEventListener('click', () => row.remove());
  row.append(remove);
  warehouses.append(row);
}

async function load() {
  const response = await fetch('/api/discovery', { headers: { 'X-Setup-Nonce': nonce } });
  const data = await response.json();
  (data.warehouses.length ? data.warehouses : [{}]).forEach(addWarehouse);
}

quickToggle.addEventListener('change', () => { quickFields.hidden = !quickToggle.checked; });
document.querySelector('#add-warehouse').addEventListener('click', () => addWarehouse());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  status.textContent = '';
  const values = Object.fromEntries(new FormData(form));
  const warehouseRows = [...warehouses.querySelectorAll('.warehouse')].map((row) => {
    const get = (name) => row.querySelector('[name="' + name + '"]').value.trim();
    return { warehouseId: get('warehouseId'), warehouseName: get('warehouseName'), receiver: get('receiver'), receiverPhone: get('receiverPhone'), nutrition: Number(get('nutrition')), remark: get('warehouseName') };
  });
  const payload = {
    version: 1,
    buyer: values.buyer.trim(), buyerPhone: values.buyerPhone.trim(), purpose: Number(values.purpose),
    warehouses: warehouseRows,
    ledgers: {
      morningChecker: values.morningChecker.trim(), deviceChecker: values.deviceChecker.trim(), deviceExecuter: values.deviceExecuter.trim(),
      wasteChecker: values.wasteChecker.trim(), wasteDisposer: values.wasteDisposer.trim(), wasteHandler: values.wasteHandler.trim(), dinersCount: Number(values.dinersCount)
    },
    wasteQuickFill: quickToggle.checked ? { enabled: true, foodWaste: Number(values.foodWaste), prepWaste: Number(values.prepWaste), otherWaste: Number(values.otherWaste) } : { enabled: false, foodWaste: 0, prepWaste: 0, otherWaste: 0 },
    aliases: []
  };
  const response = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Nonce': nonce }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) { status.textContent = result.error || '保存失败'; return; }
  document.querySelector('#submit').disabled = true;
  status.style.color = '#16795c';
  status.textContent = '配置已加密保存，可以关闭此窗口。';
});

load().catch(() => { status.textContent = '无法读取系统配置，请检查登录状态。'; });
`;

export const WIZARD_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>智慧食堂 MCP 配置</title><link rel="stylesheet" href="/style.css"></head>
<body><header><h1>智慧食堂 MCP 配置</h1></header><main><form>
<section><h2>采购设置</h2><div class="grid">
<div class="field"><label>采购人<input name="buyer" required autocomplete="off"></label></div>
<div class="field"><label>联系电话<input name="buyerPhone" type="tel" required autocomplete="off"></label></div>
<div class="field"><label>采购用途<select name="purpose"><option value="1">学生</option><option value="5">学生与教工</option></select></label></div>
</div></section>
<section><div class="actions"><h2>仓库与收货人</h2><button id="add-warehouse" type="button" class="secondary">添加仓库</button></div><div id="warehouses"></div></section>
<section><h2>台账人员</h2><div class="grid">
<div class="field"><label>晨检检查人<input name="morningChecker" required autocomplete="off"></label></div>
<div class="field"><label>设备检查人<input name="deviceChecker" required autocomplete="off"></label></div>
<div class="field"><label>设备执行人<input name="deviceExecuter" required autocomplete="off"></label></div>
<div class="field"><label>废弃物检查人<input name="wasteChecker" required autocomplete="off"></label></div>
<div class="field"><label>废弃物处置人<input name="wasteDisposer" required autocomplete="off"></label></div>
<div class="field"><label>废弃物经办人<input name="wasteHandler" required autocomplete="off"></label></div>
<div class="field"><label>默认就餐人数<input name="dinersCount" type="number" min="1" required></label></div>
</div></section>
<section><h2>快速填报</h2><label class="quick"><input id="quick-enabled" type="checkbox">启用废弃物快速填报</label><div id="quick-fields" class="grid" hidden>
<div class="field"><label>餐厨数量<input name="foodWaste" type="number" min="0" step="0.1" value="0"></label></div>
<div class="field"><label>食材废料数量<input name="prepWaste" type="number" min="0" step="0.1" value="0"></label></div>
<div class="field"><label>其他数量<input name="otherWaste" type="number" min="0" step="0.1" value="0"></label></div>
</div></section>
<div class="actions"><div id="status" class="status" role="status" aria-live="polite"></div><button id="submit" class="primary" type="submit">保存配置</button></div>
</form></main><script src="/app.js" defer></script></body></html>`;
