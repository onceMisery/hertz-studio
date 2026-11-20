// SPDX-License-Identifier: MIT
// Client draft projection only. WorkDrafts and its compiler own persistence/validity.
(function () {
  'use strict';
  function hierarchy(document) {
    const nodes = new Map(document.nodes.map(node => [node.id, node])), parents = new Map(), rows = [];
    for (const node of document.nodes) for (const id of node.children || []) parents.set(id, node.id);
    const roots = document.nodes.filter(node => !parents.has(node.id)).map(node => node.id);
    const walk = (ids, parentId, depth) => ids.forEach((id, index) => {
      const node = nodes.get(id);
      if (!node || depth > 8 || rows.some(row => row.id === id)) throw new Error('图层结构无效，请重新读取作品。');
      rows.push({ id, node, parentId, depth, index }); walk(node.children || [], id, depth + 1);
    });
    walk(roots, null, 1);
    if (rows.length !== document.nodes.length) throw new Error('图层结构无效，请重新读取作品。');
    return { nodes, parents, roots, rows };
  }
  function siblings(document, parentId) {
    const tree = hierarchy(document);
    return parentId == null ? tree.roots : [...(tree.nodes.get(parentId)?.children || [])];
  }
  function space(node, catalog) {
    const definition = catalog.nodes.find(item => item.type === node.type);
    return definition?.space === 'dynamic' ? node.properties.space || '2d' : definition?.space;
  }
  function parentError(document, nodeId, parentId, catalog) {
    const tree = hierarchy(document), node = tree.nodes.get(nodeId), parent = tree.nodes.get(parentId);
    if (!node) return '图层不存在。';
    if (parentId == null) return '';
    if (!parent || parent.type !== 'group') return '请选择图层组。';
    if (space(node, catalog) !== space(parent, catalog)) return '父组与子图层需要使用相同的 2D 或 3D 空间。';
    let ancestor = parentId;
    while (ancestor != null) {
      if (ancestor === nodeId) return '不能把图层组放入自己或自己的子组。';
      ancestor = tree.parents.get(ancestor);
    }
    const row = tree.rows.find(item => item.id === nodeId), parentRow = tree.rows.find(item => item.id === parentId);
    let height = 1;
    const descendants = id => { for (const child of tree.nodes.get(id).children || []) { height = Math.max(height, tree.rows.find(item => item.id === child).depth - row.depth + 1); descendants(child); } };
    descendants(nodeId);
    return parentRow.depth + height > 8 ? '图层组最多嵌套八层，请选择更外层的父组。' : '';
  }
  function moveNode(document, { nodeId, parentId = null, index }) {
    const tree = hierarchy(document), parent = tree.nodes.get(parentId);
    if (!tree.nodes.has(nodeId) || parentId != null && (!parent || parent.type !== 'group' || parentId === nodeId)) throw new Error('移动目标无效。');
    const destination = siblings(document, parentId).filter(id => id !== nodeId);
    if (!Number.isInteger(index) || index < 0 || index > destination.length) throw new Error('图层顺序超出同组范围。');
    for (const node of document.nodes) if (node.children) node.children = node.children.filter(id => id !== nodeId);
    if (parentId != null) { parent.children ||= []; parent.children.splice(index, 0, nodeId); }
    else {
      const roots = new Set(hierarchy(document).roots), slots = document.nodes.flatMap((node, slot) => roots.has(node.id) ? [slot] : []);
      destination.splice(index, 0, nodeId);
      slots.forEach((slot, order) => { document.nodes[slot] = tree.nodes.get(destination[order]); });
    }
  }
  function reorder(items, ids) {
    const byId = new Map(items.map(item => [item.id, item]));
    if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('顺序必须完整且没有重复条目。');
    items.splice(0, items.length, ...ids.map(id => byId.get(id)));
  }
  function apply(document, operation) {
    if (operation.kind === 'moveNode') moveNode(document, operation);
    else reorder(operation.kind === 'reorderNodes' ? document.nodes : document.effects, operation.ids);
  }
  function reconcile(document, target) {
    const operations = [], desired = hierarchy(target);
    const push = operation => { apply(document, operation); operations.push(operation); };
    // Detach changed parents first. This also permits reversing nested groups
    // without ever sending a transient cycle or a ninth level in a separate CAS.
    for (const node of target.nodes) {
      const current = hierarchy(document);
      if (current.parents.get(node.id) !== desired.parents.get(node.id) && current.parents.has(node.id)) {
        push({ kind: 'moveNode', nodeId: node.id, parentId: null, index: current.roots.length });
      }
    }
    for (const row of desired.rows) {
      if (row.parentId == null) continue;
      const current = hierarchy(document);
      if (current.parents.get(row.id) !== row.parentId || siblings(document, row.parentId)[row.index] !== row.id) {
        push({ kind: 'moveNode', nodeId: row.id, parentId: row.parentId, index: row.index });
      }
    }
    for (const [part, kind] of [['nodes', 'reorderNodes'], ['effects', 'reorderEffects']]) {
      const ids = target[part].map(item => item.id);
      if (JSON.stringify(document[part].map(item => item.id)) !== JSON.stringify(ids)) push({ kind, ids });
    }
    return operations;
  }
  window.hertzWallpaperWorkStructure = { hierarchy, siblings, space, parentError, moveNode, reorder, apply, reconcile };
})();
