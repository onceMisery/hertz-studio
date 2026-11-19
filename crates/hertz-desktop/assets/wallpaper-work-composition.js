// SPDX-License-Identifier: MIT
// Presentation for the original work controller. Native WorkDrafts validates and saves.
(function () {
  'use strict';
  const structure = window.hertzWallpaperWorkStructure;
  const copy = value => JSON.parse(JSON.stringify(value));
  const labels = { image: '图片', video: '视频', text: '文字', group: '图层组', particles: '粒子', model: '模型', builtinScene: '内置场景',
    x: '水平位置', y: '垂直位置', z: '深度位置', width: '宽度', height: '高度', opacity: '透明度', rotation: '旋转', scaleX: '水平缩放', scaleY: '垂直缩放',
    visible: '可见', fit: '适配方式', blend: '混合方式', text: '文字', color: '颜色', fontSize: '字号', position: '位置', scale: '缩放', anchorX: '水平锚点', anchorY: '垂直锚点',
    asset: '素材', maskAsset: '遮罩素材', fontAsset: '字体素材', modelAsset: '模型素材', source: '输入素材', normal: '正常', add: '叠加', screen: '滤色', multiply: '正片叠底',
    contain: '完整显示', cover: '铺满', stretch: '拉伸', linear: '匀速', easeInOut: '缓入缓出', step: '跳变', replace: '替换', blur: '模糊', ripple: '水波', wind: '风动' };
  function element(tag, text) { const value = document.createElement(tag); if (text != null) value.textContent = text; return value; }
  function create(container, context) {
    let value, catalog, category = 'nodes', selected = '', serial = 0;
    let undo = [], redo = [], busy = false;
    const historyLimit = 8 * 1024 * 1024;
    const toolbar = element('div'); toolbar.className = 'library-toolbar';
    const undoButton = makeButton('撤销', () => restore(false)); undoButton.id = 'work-undo';
    const redoButton = makeButton('重做', () => restore(true)); redoButton.id = 'work-redo'; toolbar.append(undoButton, redoButton);
    const plan = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); plan.classList.add('work-composition-plan'); plan.setAttribute('aria-label', '图层位置示意，完整效果请使用预览作品');
    const caption = element('p', '拖动图层位置或编辑下方数值。此处是位置示意，完整效果请点击“预览作品”。'); caption.className = 'hint';
    const canvasFields = element('div'); canvasFields.className = 'work-composition-fields';
    const sections = element('fieldset'); sections.className = 'generation-options'; sections.append(element('legend', '编辑内容'));
    for (const [id, title] of [['nodes', '图层'], ['effects', '效果'], ['tracks', '关键帧'], ['bindings', '输入映射']]) {
      const input = element('input'); input.type = 'radio'; input.name = 'work-composition-section'; input.value = id; input.id = 'work-section-' + id; input.checked = id === category;
      const label = element('label', title); label.htmlFor = input.id; const row = element('div'); row.className = 'generation-option'; row.append(input, label); sections.append(row);
      input.addEventListener('change', () => { category = id; selected = ''; renderItems(); });
    }
    const itemTools = element('div'); itemTools.className = 'library-toolbar';
    const chooser = element('select'); chooser.setAttribute('aria-label', '当前编辑条目'); chooser.id = 'work-composition-item';
    const type = element('select'); type.setAttribute('aria-label', '新增图层或效果类型'); type.id = 'work-composition-type';
    const add = makeButton('添加', addItem), remove = makeButton('删除条目', removeItem);
    itemTools.append(chooser, type, add, remove);
    const detail = element('div'); detail.className = 'work-composition-fields';
    const layerFields = element('div'); layerFields.className = 'work-layer-fields';
    const layerView = window.hertzWallpaperWorkLayers.create(layerFields, {
      label: node => node.type === 'group' ? (structure.space(node, catalog) === '3d' ? '3D 图层组' : '2D 图层组') : labels[node.type] || node.type,
      change: action => changed(action), message: context.message,
      refresh: () => { renderItems(); draw(); },
      select: id => { category = 'nodes'; selected = id; sections.querySelector('[value="nodes"]').checked = true; renderItems(); draw(); }
    });
    container.append(toolbar, plan, caption, canvasFields, sections, itemTools, layerFields, detail);
    chooser.addEventListener('change', () => { selected = chooser.value; renderDetail(); layerView.show(value.composition, catalog, category, selected); draw(); });
    function makeButton(text, action) {
      const button = element('button', text); button.type = 'button';
      button.addEventListener('click', () => { if (!busy) { try { action(); } catch (error) { context.message(error.message, true); } } }); return button;
    }
    function remember() {
      const snapshot = JSON.stringify(value.composition);
      if (undo.at(-1) !== snapshot) undo.push(snapshot);
      while (undo.length > 20 || undo.reduce((sum, item) => sum + item.length * 2, 0) > historyLimit) undo.shift();
      redo = [];
    }
    function changed(action, rememberFirst = true) { if (busy) return; if (rememberFirst) remember(); action(); syncHistory(); context.edited(); }
    function restore(forward) {
      const from = forward ? redo : undo, to = forward ? undo : redo;
      if (!from.length) return; to.push(JSON.stringify(value.composition)); value.composition = JSON.parse(from.pop()); render(); context.edited();
    }
    function syncHistory() { undoButton.disabled = busy || !undo.length; redoButton.disabled = busy || !redo.length; }
    function field(label, input) {
      const row = element('label'); row.className = 'field'; row.append(element('span', label), input); return row;
    }
    function inputFor(parent, name, initial, spec, set) {
      const input = element(spec.type === 'select' ? 'select' : ['text', 'sceneParams'].includes(spec.type) ? 'textarea' : 'input');
      input.id = 'work-composition-field-' + ++serial; input.name = name; input.dataset.compositionProperty = name;
      if (spec.type === 'select') {
        for (const option of spec.options || []) { const node = element('option', labels[option] || option); node.value = option; input.append(node); }
        if (initial != null && !Array.from(input.options).some(option => option.value === String(initial))) { const option = element('option', initial); option.value = initial; input.append(option); }
        input.value = initial == null ? '' : String(initial);
      } else if (spec.type === 'boolean') { input.type = 'checkbox'; input.checked = !!initial; }
      else {
        input.value = spec.type === 'sceneParams' ? JSON.stringify(initial || {}) : initial == null ? '' : initial;
        if (spec.type === 'number') { input.type = 'number'; input.step = spec.integer ? '1' : 'any'; if (spec.min != null) input.min = spec.min; if (spec.max != null) input.max = spec.max; input.required = true; }
        else if (spec.type === 'color' && /^#[\da-f]{6}$/i.test(String(initial))) input.type = 'color';
        else if (input.tagName === 'INPUT') input.type = 'text';
        if (input.tagName === 'TEXTAREA') { input.rows = spec.type === 'sceneParams' ? 3 : 2; input.maxLength = spec.maxLength || 4096; }
        else if (spec.maxLength) input.maxLength = spec.maxLength;
      }
      let remembered = false;
      input.addEventListener('focus', () => { remembered = false; });
      input.addEventListener(spec.type === 'boolean' || spec.type === 'select' ? 'change' : 'input', () => {
        if (busy) return;
        input.setCustomValidity(''); input.removeAttribute('aria-invalid');
        if (!input.checkValidity()) return;
        let next;
        try { next = spec.type === 'number' ? Number(input.value) : spec.type === 'boolean' ? input.checked : spec.type === 'sceneParams' ? JSON.parse(input.value) : input.value; }
        catch (_) { input.setCustomValidity('请填写有效的场景参数。'); return; }
        if (!remembered) { remember(); remembered = true; }
        changed(() => set(next), false); draw();
      });
      input.addEventListener('blur', () => { input.setAttribute('aria-invalid', String(!input.checkValidity())); });
      parent.append(field(labels[name] || name, input)); return input;
    }
    function definitions() { return category === 'nodes' ? catalog.nodes : catalog.effects; }
    function collection() { return category === 'tracks' ? value.composition.timeline.tracks : value.composition[category]; }
    function schemaFor(node) { return catalog.nodes.find(schema => schema.type === node.type); }
    function fieldsInSpace(schema, item) {
      const space = schema.space === 'dynamic' ? item.properties.space || '2d' : schema.space;
      return Object.entries(schema.properties || {}).flatMap(([name, field]) => {
        const alternative = field.alternatives?.[space];
        return alternative ? [[name, alternative]] : field.space && field.space !== space ? [] : [[name, field]];
      });
    }
    function availableTargets() {
      const targets = [];
      for (const node of value.composition.nodes) {
        for (const [property, spec] of fieldsInSpace(schemaFor(node), node)) {
          if (!spec.animatable || !['number', 'vector'].includes(spec.type)) continue;
          const components = spec.type === 'vector' ? Array.from({ length: spec.length }, (_, index) => index) : [null];
          for (const component of components) targets.push({ nodeId: node.id, property, component });
        }
      }
      return targets;
    }
    function targetFields(item) {
      const targets = availableTargets();
      const current = JSON.stringify(item.target); if (!targets.some(target => JSON.stringify(target) === current)) targets.push(item.target);
      const choices = targets.map(target => JSON.stringify(target));
      const input = inputFor(detail, 'target', current, { type: 'select', options: choices }, next => { item.target = JSON.parse(next); });
      Array.from(input.options).forEach((option, index) => { const target = targets[index]; option.textContent = target.nodeId + ' · ' + (labels[target.property] || target.property) + (target.component == null ? '' : ' · ' + ['X', 'Y', 'Z', 'W'][target.component]); });
    }
    function render() {
      serial = 0; canvasFields.replaceChildren();
      for (const [name, text] of [['width', '画布宽度'], ['height', '画布高度']]) inputFor(canvasFields, name, value.composition.canvas[name], { type: 'number', min: 1, max: 16384, integer: true }, next => { value.composition.canvas[name] = next; });
      inputFor(canvasFields, 'background', value.composition.canvas.background, { type: 'color' }, next => { value.composition.canvas.background = next; });
      inputFor(canvasFields, 'durationSeconds', value.composition.timeline.durationSeconds, { type: 'number', min: 0 }, next => { value.composition.timeline.durationSeconds = next; });
      inputFor(canvasFields, 'loop', value.composition.timeline.loop, { type: 'boolean' }, next => { value.composition.timeline.loop = next; });
      renderItems(); draw(); syncHistory();
    }
    function renderItems() {
      chooser.replaceChildren(); type.replaceChildren(); const items = collection();
      const ordered = category === 'nodes' ? structure.hierarchy(value.composition).rows.map(row => row.node) : items;
      for (const item of ordered) { const option = element('option', item.id + (item.type ? ' · ' + (labels[item.type] || item.type) : '')); option.value = item.id; chooser.append(option); }
      if (!items.some(item => item.id === selected)) selected = items[0]?.id || ''; chooser.value = selected;
      type.hidden = !['nodes', 'effects'].includes(category);
      if (!type.hidden) for (const schema of definitions()) {
        for (const space of schema.type === 'group' ? ['2d', '3d'] : ['']) {
          const option = element('option', space ? space.toUpperCase() + ' 图层组' : labels[schema.type] || schema.type); option.value = schema.type + (space ? ':' + space : '');
          option.disabled = Object.values(schema.assets || {}).some(field => field.required && !value.resources.some(resource => field.kinds.includes(resource.kind)));
          type.append(option);
        }
      }
      if (type.selectedOptions[0]?.disabled) type.value = Array.from(type.options).find(option => !option.disabled)?.value || '';
      add.disabled = busy || (!type.hidden && !type.value) || (type.hidden && !availableTargets().length); remove.disabled = busy || !selected;
      remove.textContent = category === 'nodes' && items.find(item => item.id === selected)?.type === 'group' ? '删除图层组，保留子图层' : '删除条目';
      layerView.show(value.composition, catalog, category, selected);
      renderDetail();
    }
    function renderDetail() {
      detail.replaceChildren(); const item = collection().find(item => item.id === selected);
      if (!item) { detail.append(element('p', '暂无条目。添加图层、效果或动画后可在这里编辑。')); return; }
      detail.append(element('h4', item.id));
      if (category === 'tracks') {
        targetFields(item);
        const keys = element('div'); keys.className = 'work-composition-keys'; detail.append(keys);
        item.keys.forEach((key, index) => {
          const row = element('fieldset'); row.append(element('legend', '关键帧 ' + (index + 1))); keys.append(row);
          inputFor(row, 'timeSeconds', key.timeSeconds, { type: 'number', min: 0 }, next => { key.timeSeconds = next; });
          inputFor(row, 'keyValue', key.value, { type: 'number' }, next => { key.value = next; });
          inputFor(row, 'easing', key.easing, { type: 'select', options: ['linear', 'easeInOut', 'step'] }, next => { key.easing = next; });
          row.append(makeButton('移除此关键帧', () => { changed(() => item.keys.splice(index, 1)); renderDetail(); }));
        });
        detail.append(makeButton('添加关键帧', () => { changed(() => item.keys.push({ timeSeconds: value.composition.timeline.durationSeconds, value: item.keys.at(-1)?.value || 0, easing: 'linear' })); renderDetail(); }));
        return;
      }
      if (category === 'bindings') {
        targetFields(item); inputFor(detail, 'mode', item.mode, { type: 'select', options: ['add', 'multiply', 'replace'] }, next => { item.mode = next; });
        for (const [name, number] of Object.entries(item.parameters)) inputFor(detail, 'parameter-' + name, number, { type: 'number' }, next => { item.parameters[name] = next; });
        const operations = ['input', 'parameter', 'const', 'add', 'mul', 'sin', 'cos', 'abs', 'clamp', 'map', 'smoothstep'];
        item.program.forEach((step, index) => {
          const row = element('fieldset'); row.append(element('legend', '映射步骤 ' + (index + 1))); detail.append(row);
          const names = { input: '读取输入', parameter: '读取参数', const: '固定值', add: '相加', mul: '相乘', sin: '正弦', cos: '余弦', abs: '绝对值', clamp: '限定范围', map: '区间映射', smoothstep: '平滑过渡' };
          const select = inputFor(row, 'operation', step.op, { type: 'select', options: operations }, next => {
            const defaults = { input: { name: catalog.inputs[0] }, parameter: { name: Object.keys(item.parameters)[0] || 'gain' }, const: { value: 1 }, clamp: { min: 0, max: 1 }, map: { inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1 }, smoothstep: { edge0: 0, edge1: 1 } };
            item.program[index] = Object.assign({ op: next }, defaults[next] || {}); queueMicrotask(renderDetail);
          });
          Array.from(select.options).forEach(option => { option.textContent = names[option.value]; });
          for (const [name, number] of Object.entries(step).filter(([name]) => name !== 'op')) inputFor(row, name, number,
            name === 'name' ? { type: 'select', options: step.op === 'input' ? catalog.inputs : Object.keys(item.parameters) } : { type: 'number' }, next => { step[name] = next; });
          row.append(makeButton('移除此步骤', () => { changed(() => item.program.splice(index, 1)); renderDetail(); }));
        });
        detail.append(makeButton('添加固定值步骤', () => { if (item.program.length >= 32) throw new Error('每个映射最多 32 个步骤。'); changed(() => item.program.push({ op: 'const', value: 1 })); renderDetail(); }));
        return;
      }
      const schema = definitions().find(schema => schema.type === item.type); if (!schema) return;
      if (category === 'effects') inputFor(detail, 'effectTarget', item.target.kind === 'output' ? 'output' : item.target.nodeId,
        { type: 'select', options: ['output', ...value.composition.nodes.map(node => node.id)] }, next => { item.target = next === 'output' ? { kind: 'output' } : { kind: 'node', nodeId: next }; });
      for (const [name, spec] of fieldsInSpace(schema, item)) {
        const initial = item.properties[name] ?? spec.default;
        if (schema.space === 'dynamic' && name === 'space') {
          const space = element('output', initial === '3d' ? '3D 图层组' : '2D 图层组'); space.dataset.compositionSpace = initial;
          detail.append(field('图层空间', space));
        } else if (spec.type === 'vector') {
          for (let index = 0; index < spec.length; index++) inputFor(detail, name + '-' + index, initial?.[index] || 0, { ...spec, type: 'number' }, next => {
            const vector = copy(item.properties[name] || spec.default || Array(spec.length).fill(0)); vector[index] = next; item.properties[name] = vector;
          });
        } else inputFor(detail, labels[name] || name, initial, spec, next => { item.properties[name] = next; }).dataset.compositionProperty = name;
      }
      for (const [name, field] of Object.entries(schema.assets || {})) {
        const choices = value.resources.filter(resource => field.kinds.includes(resource.kind));
        if (!field.required) choices.unshift({ assetId: '', label: '不使用' });
        const input = inputFor(detail, labels[name] || name, item.assets[name] || '', { type: 'select', options: choices.map(resource => resource.assetId) }, next => { if (next) item.assets[name] = next; else delete item.assets[name]; });
        Array.from(input.options).forEach(option => { option.textContent = choices.find(resource => resource.assetId === option.value)?.label || option.value || '不使用'; });
      }
    }
    function addItem() {
      const items = collection(), prefix = { nodes: 'layer', effects: 'effect', tracks: 'track', bindings: 'binding' }[category];
      let number = 1; while (items.some(item => item.id === prefix + '-' + number)) number++;
      const id = prefix + '-' + number;
      changed(() => {
        if (category === 'tracks') items.push({ id, target: copy(availableTargets().find(target => target.property === 'opacity') || availableTargets()[0]), keys: [{ timeSeconds: 0, value: 1, easing: 'linear' }] });
        else if (category === 'bindings') items.push({ id, target: copy(availableTargets().find(target => target.property === 'opacity') || availableTargets()[0]), mode: 'multiply', parameters: {}, program: [{ op: 'const', value: 1 }] });
        else {
          const [nodeType, space] = type.value.split(':'), schema = definitions().find(schema => schema.type === nodeType), assets = {};
          for (const [name, field] of Object.entries(schema.assets || {})) if (field.required) assets[name] = value.resources.find(resource => field.kinds.includes(resource.kind)).assetId;
          items.push(Object.assign({ id, type: schema.type, stateVersion: schema.stateVersion, assets, properties: space ? { space } : {} }, category === 'effects' ? { target: { kind: 'output' } } : { children: [] }));
        }
      }); selected = id; renderItems(); draw();
    }
    function removeItem() {
      changed(() => {
        collection().splice(collection().findIndex(item => item.id === selected), 1);
        if (category === 'nodes') {
          value.composition.nodes.forEach(node => { node.children = (node.children || []).filter(id => id !== selected); });
          value.composition.effects = value.composition.effects.filter(effect => effect.target.kind !== 'node' || effect.target.nodeId !== selected);
          value.composition.timeline.tracks = value.composition.timeline.tracks.filter(track => track.target.nodeId !== selected);
          value.composition.bindings = value.composition.bindings.filter(binding => binding.target.nodeId !== selected);
        }
      }); selected = ''; renderItems(); draw();
    }
    function draw() {
      if (!value) return; const canvas = value.composition.canvas; plan.setAttribute('viewBox', '0 0 ' + canvas.width + ' ' + canvas.height); plan.replaceChildren();
      const background = document.createElementNS(plan.namespaceURI, 'rect'); background.setAttribute('width', canvas.width); background.setAttribute('height', canvas.height); background.setAttribute('fill', canvas.background); plan.append(background);
      const groups = new Map();
      for (const { node, parentId } of structure.hierarchy(value.composition).rows) {
        const properties = node.properties, schema = schemaFor(node); if (!schema || structure.space(node, catalog) !== '2d') continue;
        const defaults = Object.fromEntries(Object.entries(schema.properties).map(([name, spec]) => [name, spec.default]));
        const number = name => properties[name] ?? defaults[name], width = number('width'), height = number('height');
        const angle = number('rotation') * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
        const a = cosine * number('scaleX'), b = sine * number('scaleX'), c = -sine * number('scaleY'), d = cosine * number('scaleY');
        const x = number('x') - a * width * number('anchorX') - c * height * number('anchorY');
        const y = number('y') - b * width * number('anchorX') - d * height * number('anchorY');
        const parent = groups.get(parentId) || plan, transform = document.createElementNS(plan.namespaceURI, 'g');
        const place = (dx = 0, dy = 0) => transform.setAttribute('transform', 'matrix(' + [a, b, c, d, x + dx, y + dy].join(' ') + ')');
        place(); transform.setAttribute('opacity', number('opacity'));
        if (number('visible') === false) transform.style.display = 'none';
        parent.append(transform);
        if (node.type === 'group') { transform.dataset.compositionGroup = node.id; groups.set(node.id, transform); continue; }
        const rect = document.createElementNS(plan.namespaceURI, 'rect'); rect.dataset.compositionLayer = node.id;
        for (const [name, number] of Object.entries({ x: 0, y: 0, width, height })) rect.setAttribute(name, number);
        rect.setAttribute('fill', '#809aa8'); rect.setAttribute('fill-opacity', '0.3'); rect.setAttribute('stroke', node.id === selected ? '#ddebf0' : '#809aa8'); rect.setAttribute('vector-effect', 'non-scaling-stroke');
        rect.setAttribute('tabindex', '0'); rect.setAttribute('role', 'button'); rect.setAttribute('aria-label', '移动图层 ' + node.id); transform.append(rect);
        rect.addEventListener('keydown', event => {
          const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]; if (!delta || busy) return;
          event.preventDefault(); changed(() => { node.properties.x = (node.properties.x || 0) + delta[0]; node.properties.y = (node.properties.y || 0) + delta[1]; }); draw(); plan.querySelector('[data-composition-layer="' + node.id + '"]').focus();
        });
        let start = null;
        const point = event => {
          const matrix = parent.getScreenCTM(), value = matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
          return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value : null;
        };
        rect.addEventListener('pointerdown', event => { if (busy || event.button !== 0) return; const p = point(event); if (!p) return; remember(); start = { p, x: properties.x || 0, y: properties.y || 0 }; rect.setPointerCapture(event.pointerId); event.preventDefault(); });
        rect.addEventListener('pointermove', event => { if (!start) return; const p = point(event); if (!p) return; properties.x = start.x + p.x - start.p.x; properties.y = start.y + p.y - start.p.y; place(p.x - start.p.x, p.y - start.p.y); });
        const end = () => { if (!start) return; start = null; selected = node.id; category = 'nodes'; sections.querySelector('[value="nodes"]').checked = true; renderItems(); syncHistory(); context.edited(); };
        rect.addEventListener('pointerup', end); rect.addEventListener('pointercancel', end);
      }
    }
    return {
      show(documentValue, definitions, reset = true) { value = documentValue; catalog = definitions; if (reset) { undo = []; redo = []; selected = ''; } render(); },
      setBusy(next) { busy = next; container.querySelectorAll('input,textarea,select,button').forEach(input => { input.disabled = busy; }); layerView.setBusy(busy); syncHistory(); }
    };
  }
  window.hertzWallpaperCompositionView = { create };
})();
