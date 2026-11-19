'use strict';
(() => {
 const dialog = node('dialog', 'settings-status-dialog'), title = node('h2'), content = node('div', 'settings-status-dialog-body');
 const close = button('关闭', 'button secondary', () => dialog.close());
 let invoker;
 title.id = 'settings-status-title';
 dialog.setAttribute('aria-labelledby', title.id);
 close.autofocus = true;
 dialog.append(title, content, close);
 $('view-settings').append(dialog);
 dialog.addEventListener('close', () => {
  if (!dialog.open) invoker?.focus({preventScroll:true});
 });

 function detailButton(lane, heading, body) {
  const trigger = button('i', 'settings-status-detail', () => {
   const nodes = body();
   if (!nodes.length || dialog.open) return;
   invoker = trigger;
   title.textContent = heading;
   content.replaceChildren(...nodes);
   dialog.showModal();
  });
  trigger.setAttribute('aria-label', heading + '详情');
  trigger.setAttribute('aria-haspopup', 'dialog');
  lane.append(trigger);
  return trigger;
 }

 function details(lane, heading, messages) {
  return detailButton(lane, heading, () => messages().filter(Boolean).map(line => node('p', '', line)));
 }

 function text(element) {
  if (!element || element.hidden) return '';
  return (element.querySelector(':scope > .notice-copy') || element).textContent.trim();
 }

 function accountFields(panel, labels) {
  const facts = node('dl', 'settings-account-fields');
  facts.setAttribute('aria-live', 'polite');
  const fields = labels.map(label => {
   const item = node('div'), value = node('dd', '', '—');
   item.append(node('dt', '', label), value);
   facts.append(item);
   return value;
  });
  panel.prepend(facts);
  return values => fields.forEach((field, index) => {
   field.textContent = values[index];
   field.title = values[index];
  });
 }

 const servicePanel = $('service-account-panel');
 const serviceFields = accountFields(servicePanel, ['账户', '余额', '服务状态']);
 let lastAccount = state.account;
 function serviceAccount(account, status) {
  const brief = $('service-account-brief'), services = {formal_active:'正式服务', trial_active:'体验服务'};
  if (status === 'ready') lastAccount = account;
  if (status === 'error' || status === 'reset' || status === 'signed-out') lastAccount = null;
  if (status !== 'loading') serviceFields(lastAccount ? [lastAccount.username || '未提供', lastAccount.balance == null ? '暂不可用' : numeric(lastAccount.balance) + ' credits', services[lastAccount.service] || lastAccount.service || '未提供'] : ['—', '—', status === 'signed-out' ? '未登录' : status === 'error' ? '查询失败' : '尚未查询']);
  brief.textContent = status === 'signed-out' ? '' : status === 'loading' ? '正在查询账户与余额…' : status === 'authorization' && lastAccount ? '上次查询 · 授权后待核实' : status === 'ready' ? '服务账户已核实' : lastAccount ? '上次查询结果' : '';
  brief.hidden = !brief.textContent;
  servicePanel.toggleAttribute('data-show-brief', !brief.hidden);
 }
 serviceAccount(state.account, state.balanceQueryState);

 details($('service-account-status'), '服务账户状态', () => [
  text($('service-account-brief')),
  text($('account-info')),
  $('service-login-status').hidden ? '' : [text($('service-login-heading')), text($('service-login-message'))].filter(Boolean).join(' · ')
 ]);
 details($('settings-data-status'), '本地数据与报告状态', () => [text($('exchange-status')), text($('cleanup-result'))]);
 details($('price-status-lane'), '单价查询状态', () => [text($('price-reference-status'))]);
 window.ReaderSettingsStatus = { accountFields, detailButton, details, serviceAccount, text, close: () => { if (dialog.open) dialog.close(); } };
})();
