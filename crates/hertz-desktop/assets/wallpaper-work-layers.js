// SPDX-License-Identifier: MIT
// Accessible hierarchy/order controls for the existing composition draft view.
(function () {
  'use strict';
  const structure = window.hertzWallpaperWorkStructure;
  function element(tag, text) { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; }
  function create(container, context) {
    let documentValue, catalog, category, selected, busy = false;
    const rows = new Map();
    const heading = element('h4', '图层顺序'), help = element('p'); help.className = 'hint';
    const list = element('ol'); list.id = 'work-composition-layers'; list.className = 'work-layer-list'; list.setAttribute('aria-label', '图层层级与绘制顺序');
    const parentField = element('label'); parentField.className = 'field'; parentField.htmlFor = 'work-composition-parent';
    const parent = element('select'); parent.id = parentField.htmlFor;
    const parentHelp = element('p', '加入或移出父组会沿用当前相对位置。组的变换、透明度和可见性作用于子图层。');
    parentHelp.className = 'hint'; parentHelp.id = 'work-composition-parent-help'; parent.setAttribute('aria-describedby', parentHelp.id);
    parentField.append(element('span', '所属图层组'), parent);
    const order = element('div'); order.className = 'library-toolbar work-layer-order';
    const back = button('向后一层', 'work-composition-back', -1), forward = button('向前一层', 'work-composition-forward', 1);
    order.append(back, forward);
    container.append(heading, help, list, parentField, parentHelp, order);
    function button(text, id, direction) {
      const node = element('button', text); node.type = 'button'; node.id = id;
      node.addEventListener('click', () => {
        if (busy || node.getAttribute('aria-disabled') === 'true') return;
        const items = orderedItems(), index = items.indexOf(selected), next = index + direction;
        if (category === 'nodes') {
          const tree = structure.hierarchy(documentValue);
          context.change(() => structure.moveNode(documentValue, { nodeId: selected, parentId: tree.parents.get(selected) || null, index: next }));
        } else {
          items.splice(index, 1); items.splice(next, 0, selected);
          context.change(() => structure.reorder(documentValue.effects, items));
        }
        refresh(); context.message(selected + ' 已调整为第 ' + (next + 1) + ' 项；' + (category === 'nodes' ? '同组共 ' : '效果共 ') + items.length + ' 项。', false);
      });
      return node;
    }
    function orderedItems() {
      if (category === 'effects') return documentValue.effects.map(item => item.id);
      const tree = structure.hierarchy(documentValue);
      return structure.siblings(documentValue, tree.parents.get(selected) || null);
    }
    parent.addEventListener('change', () => {
      if (busy) return;
      const parentId = parent.value || null, error = structure.parentError(documentValue, selected, parentId, catalog);
      if (error) { context.message(error, true); refresh(); return; }
      const tree = structure.hierarchy(documentValue);
      if ((tree.parents.get(selected) || null) === parentId) return;
      const index = structure.siblings(documentValue, parentId).filter(id => id !== selected).length;
      context.change(() => structure.moveNode(documentValue, { nodeId: selected, parentId, index }));
      refresh(); context.message(selected + ' 已移到' + (parentId ? '图层组 ' + parentId : '画布根层') + '。', false);
    });
    function refresh() { context.refresh(); }
    function renderList(tree) {
      const active = document.activeElement;
      for (const [id, row] of rows) if (!tree.nodes.has(id)) { row.remove(); rows.delete(id); }
      tree.rows.forEach((item, index) => {
        let row = rows.get(item.id);
        if (!row) {
          row = element('li'); row.dataset.layerId = item.id;
          const select = element('button'); select.type = 'button'; select.className = 'work-layer-select';
          select.addEventListener('click', () => { if (!busy) context.select(item.id); }); row.append(select); rows.set(item.id, row);
        }
        const select = row.firstElementChild, label = context.label(item.node);
        select.textContent = item.id + ' · ' + label;
        select.setAttribute('aria-pressed', String(selected === item.id));
        select.setAttribute('aria-label', select.textContent + '，第 ' + item.depth + ' 层，' + (item.parentId ? '属于 ' + item.parentId : '画布根层'));
        select.disabled = busy; row.style.setProperty('--layer-depth', item.depth - 1);
        const position = list.children[index];
        if (position !== row) {
          if (list.moveBefore && row.isConnected) list.moveBefore(row, position || null);
          else list.insertBefore(row, position || null);
        }
      });
      // Older WebView2/Safari insertion can drop focus; restore the same control.
      if (active && list.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
    }
    function show(value, definitions, part, selection) {
      documentValue = value; catalog = definitions; category = part; selected = selection;
      container.hidden = !['nodes', 'effects'].includes(category);
      if (container.hidden) return;
      const nodes = category === 'nodes';
      heading.textContent = nodes ? '图层层级与顺序' : '效果执行顺序';
      help.textContent = nodes ? '同组图层按列表从后到前叠加。3D 背景先绘制，2D 图层随后叠加。' : '同一目标的效果按列表顺序执行，最终画面效果在图层绘制后执行。';
      list.hidden = !nodes; parentField.hidden = !nodes; parentHelp.hidden = !nodes;
      back.textContent = nodes ? '向后一层' : '提前执行'; forward.textContent = nodes ? '向前一层' : '延后执行';
      if (nodes) {
        const tree = structure.hierarchy(documentValue); renderList(tree); parent.replaceChildren();
        const root = element('option', '画布根层'); root.value = ''; parent.append(root);
        for (const row of tree.rows.filter(row => row.node.type === 'group')) {
          const error = structure.parentError(documentValue, selected, row.id, catalog);
          if (error) continue;
          const option = element('option', row.id + ' · ' + context.label(row.node)); option.value = row.id; parent.append(option);
        }
        parent.value = tree.parents.get(selected) || ''; parent.disabled = busy || !selected;
      }
      const items = orderedItems(), index = items.indexOf(selected);
      back.setAttribute('aria-disabled', String(index <= 0)); forward.setAttribute('aria-disabled', String(index < 0 || index >= items.length - 1));
      back.disabled = busy; forward.disabled = busy;
    }
    return { show, setBusy(value) { busy = value; if (documentValue) show(documentValue, catalog, category, selected); } };
  }
  window.hertzWallpaperWorkLayers = { create };
})();
