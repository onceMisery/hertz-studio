// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Manager-only, read-only history. No background poll and no model invocation.
(function (global) {
  'use strict';
  var root = null, transport = null, epoch = 0, controller = null;
  var month = '', state = '', cursor = null, previous = [], page = null, pending = false, error = '';
  var labels = {reserved:'在途预留',reported:'已报告费用',released:'未派发，预留已释放',unknown:'费用未确认',estimated_final:'估算费用',unpriced:'费用未知，已记录 token'};
  function h(tag, cls, text) {
    var el = document.createElement(tag); if (cls) el.className = cls;
    if (text != null) el.textContent = text; return el;
  }
  function amount(value) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return '金额暂不可显示';
    var digits = value.replace(/^0+(?=\d)/, '').padStart(7, '0');
    return '$' + digits.slice(0,-6) + '.' + digits.slice(-6) + ' USD';
  }
  function button(label, action, disabled) {
    var el = h('button','btn',label); el.type='button'; el.disabled=!!disabled;
    el.addEventListener('click',action); return el;
  }
  function invalidate() {
    epoch++; pending=false;
    if (controller) controller.abort(); controller=null;
  }
  function reset() { cursor=null; previous=[]; page=null; fetchPage(); }
  function fetchPage() {
    invalidate();
    if (!root || document.hidden) return;
    var ticket=epoch; pending=true; error=''; controller=new AbortController();
    var params=new URLSearchParams({limit:'20'});
    if (month) params.set('month',month);
    if (state) params.set('usage_state',state);
    if (cursor) { params.set('before_sort_at',cursor.sortAt); params.set('before_job_id',cursor.jobId); }
    draw();
    transport.get('/v1/ai/ledger?' + params.toString(),{signal:controller.signal,retry:false})
      .then(function (result) {
        if (ticket!==epoch || !root) return;
        page=result; month=result.month;
      },function (failure) {
        if (ticket!==epoch || !root) return;
        error=(failure && failure.message) || '账本读取失败';
      }).then(function () {
        if (ticket!==epoch || !root) return;
        pending=false; controller=null; draw();
      });
  }
  function draw() {
    if (!root) return;
    var focus=document.activeElement, key=focus && focus.dataset.ledgerKey;
    var scroll=root.closest('.ws-body'), scrollTop=scroll && scroll.scrollTop;
    root.replaceChildren(); root.setAttribute('aria-busy',String(pending));
    root.appendChild(h('p','sc-note','费用按 UTC 受理月归属，覆盖当前实例的所有生成入口。任务保留七天，账本保留当前月及此前十二个月；仍受保护的旧账目会继续保留。这里只读取费用事实，不会重新生成或发起收费查询。'));
    var controls=h('div','ws-ledger-controls');
    var monthLabel=h('label','sc-label','UTC 月份');
    var monthInput=h('input'); monthInput.type='month'; monthInput.value=month==='unassigned'?'':month; monthInput.dataset.ledgerKey='month';
    monthInput.setAttribute('aria-label','账本 UTC 月份');
    monthInput.addEventListener('change',function(){month=this.value;reset();}); monthLabel.appendChild(monthInput); controls.appendChild(monthLabel);
    var months=h('select'); months.setAttribute('aria-label','已有账本月份'); months.dataset.ledgerKey='months';
    var available=page ? page.months.slice() : month ? [month] : [];
    available.forEach(function(value){
      var option=h('option',null,value || '月份归属不完整'); option.value=value || 'unassigned'; months.appendChild(option);
    });
    months.value=month; months.addEventListener('change',function(){month=this.value;reset();}); controls.appendChild(months);
    var select=h('select'); select.setAttribute('aria-label','费用状态'); select.dataset.ledgerKey='state';
    var all=h('option',null,'全部费用状态'); all.value=''; select.appendChild(all);
    Object.keys(labels).forEach(function(value){var option=h('option',null,labels[value]);option.value=value;select.appendChild(option);});
    select.value=state; select.addEventListener('change',function(){state=this.value;reset();}); controls.appendChild(select);
    controls.appendChild(button('刷新账本',fetchPage,pending)); root.appendChild(controls);
    if (page && page.budget) {
      var budget=page.budget;
      var charged=budget.chargedTotalOverflowed?'超出可表示范围':amount(budget.chargedMicroUsd);
      root.appendChild(h('p','sc-note ws-ledger-budget','当月核价总额（不随状态筛选变化）：已核价 ' + charged
        + ' · 在途预留 ' + amount(budget.reservedMicroUsd) + ' · 限额 ' + amount(budget.limitMicroUsd)
        + ' · 未核价请求不计入金额总额'));
    } else if (!pending && page) root.appendChild(h('p','sc-note','该月没有总账记录；不能据此推断账目费用为零。'));
    if (error) {
      root.appendChild(h('p','sc-note ws-warn',error));
      root.appendChild(button('重试读取账本',fetchPage,pending));
    }
    if (pending) root.appendChild(h('p','sc-note','正在读取账本…'));
    if (page && page.guard && page.guard.halted) {
      root.appendChild(h('p','sc-note ws-warn','当前生成已熔断：'+page.guard.reason+'；关联任务 '+(page.guard.triggerJob || '未记录')+'。请在 AI 生成页核对配置后处理。'));
    }
    if (page && page.guard && page.guard.tokenHalted) {
      root.appendChild(h('p','sc-note ws-warn','token-only 生成已暂停：可信 token 用量超出受理上界；关联任务 '+(page.guard.tokenTriggerJob || '未记录')+'。请在 AI 生成页核对配置后复位。'));
    }
    if (page && !pending && !error) {
      if (!page.entries.length) root.appendChild(h('p','sc-note','该月没有符合条件的账目。'));
      page.entries.forEach(function(entry){
        var card=h('article','ws-ledger-entry'); card.dataset.jobId=entry.jobId;
        var text=labels[entry.usageState] || '费用状态待核实';
        if (entry.usageState==='reserved') text+=entry.pricingKnown
          ? ' · '+amount(entry.reservationMicroUsd)
          : ' · 等待 token 用量';
        else if (entry.usageState!=='released' && entry.usageState!=='unpriced') text+=' · '+amount(entry.accountedMicroUsd);
        card.appendChild(h('strong',null,text));
        var time=entry.acceptedAt==null ? '历史受理时间缺失；记账时间 ' : '受理时间 ';
        time+=new Date(entry.acceptedAt==null?entry.recordedAt:entry.acceptedAt).toLocaleString();
        card.appendChild(h('p','sc-note',time+' · '+(entry.taskRetained?'任务仍保留':'任务已清理')+(entry.taskState?' · '+entry.taskState:'')));
        if (entry.reportedUsage) {
          var usage=entry.reportedUsage;
          var accounting=entry.usageState==='unpriced'?'金额未核价'
            :entry.usageState==='reported'?'费用已按可信用量核算':'费用仍按预留估算';
          card.appendChild(h('p','sc-note',
            '输入 '+usage.inputTokens+' tokens · 输出 '+usage.outputTokens+' tokens · '+accounting));
        }
        if ((entry.usageState==='unknown' || entry.usageState==='estimated_final') && !entry.reportedUsage) {
          card.appendChild(h('p','sc-note','当前金额按预留估算；可信计量迟到时仍可校正，不代表供应商已结清。'));
        }
        if (!entry.pricingVerified) card.appendChild(h('p','sc-note ws-warn','历史价格依据不完整，未用当前价格重算。'));
        if (entry.principal==null || entry.acceptedAt==null) card.appendChild(h('p','sc-note ws-warn','历史归因不完整。'));
        var details=h('details'); details.appendChild(h('summary',null,'诊断详情'));
        var diagnostic=h('pre','ws-ledger-diagnostic',JSON.stringify(entry,null,2)); details.appendChild(diagnostic); card.appendChild(details);
        root.appendChild(card);
      });
    }
    var pages=h('div','ws-prompt-actions');
    pages.appendChild(button('上一页账本',function(){cursor=previous.pop();page=null;fetchPage();},pending || !previous.length));
    pages.appendChild(button('下一页账本',function(){previous.push(cursor);cursor=page.nextCursor;page=null;fetchPage();},pending || !page || !page.nextCursor || !!error));
    root.appendChild(pages);
    if (key) root.querySelectorAll('[data-ledger-key]').forEach(function(el){if(el.dataset.ledgerKey===key)el.focus({preventScroll:true});});
    if(scroll)scroll.scrollTop=scrollTop;
  }
  function mount(container, nextTransport) {
    transport=nextTransport;
    if (root) {container.appendChild(root);return;}
    root=h('section','ws-ledger'); container.appendChild(root); fetchPage();
  }
  function unmount(){invalidate();root=null;page=null;cursor=null;previous=[];}
  document.addEventListener('visibilitychange',function(){
    if (!root) return;
    if(document.hidden)invalidate();else fetchPage();
  });
  global.AiLedger={mount:mount,unmount:unmount};
}(window));
