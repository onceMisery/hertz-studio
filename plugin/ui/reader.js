// SPDX-License-Identifier: MIT
// RSS 图文阅读（方案 B）：与播客分开的订阅管理、源内正文阅读与阅读状态。
// 服务端已做 HTML 清洗与图片键替换；这里再用 DOMParser 白名单兜一道，
// 图片默认不加载，用户点「加载本文图片」后经 /images/{key} 代理成 data-URL。
(function () {
  'use strict';

  var T = null;
  var toast = function () {};
  var st = {
    feeds: [],
    loaded: false,
    currentFeed: null,
    filter: 'all',
    items: [],
    cursor: null,
    epoch: 0,
    detailEpoch: 0,
    current: null,
    selectedId: null,
    imagesLoaded: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function status(message) {
    var el = $('reader-status');
    if (el) el.textContent = message || '';
  }

  function entryStatus(message) {
    var el = $('reader-entry-status');
    if (el) el.textContent = message || '';
  }

  function dateText(unixSeconds) {
    if (!unixSeconds || unixSeconds <= 0) return '日期未知';
    var date = new Date(unixSeconds * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function findFeed(id) {
    for (var i = 0; i < st.feeds.length; i++) {
      if (st.feeds[i].id === id) return st.feeds[i];
    }
    return null;
  }

  function describeError(error) {
    var detail = error && error.error;
    if (detail && detail.message) return detail.message;
    if (error && error.message) return error.message;
    return '请求失败，请稍后重试';
  }

  // --- 订阅源列表 ---

  async function loadFeeds() {
    var data = await T.get('/v1/reader/subscriptions', { timeoutMs: 15000 });
    st.feeds = (data && data.feeds) || [];
    renderFeeds();
  }

  function feedRow(feed) {
    var li = document.createElement('li');
    li.className = 'reader-feed' + (feed.subscribed ? '' : ' unsubscribed') + (st.currentFeed === feed.id ? ' active' : '');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'reader-feed-main';
    button.title = feed.title || feed.feed_url;
    if (st.currentFeed === feed.id) button.setAttribute('aria-current', 'true');
    var title = document.createElement('span');
    title.className = 'reader-feed-title';
    title.textContent = feed.title || feed.feed_url;
    button.appendChild(title);
    if (feed.unread > 0) {
      var badge = document.createElement('em');
      badge.className = 'reader-unread';
      badge.textContent = feed.unread > 99 ? '99+' : String(feed.unread);
      button.appendChild(badge);
    }
    button.addEventListener('click', function () { openFeed(feed.id); });
    li.appendChild(button);
    var actions = document.createElement('span');
    actions.className = 'reader-feed-actions';
    actions.appendChild(actionButton(feed.subscribed ? '退订' : '恢复', function () {
      return feed.subscribed ? unsubscribeFeed(feed) : resubscribeFeed(feed);
    }));
    actions.appendChild(actionButton('删除数据', function () { return deleteFeed(feed); }));
    li.appendChild(actions);
    if (feed.last_error) {
      li.title = '上次刷新失败：' + feed.last_error;
    }
    return li;
  }

  function actionButton(label, action) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn reader-feed-action';
    button.textContent = label;
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      Promise.resolve()
        .then(action)
        .catch(function (error) { toast(describeError(error)); });
    });
    return button;
  }

  function renderFeeds() {
    var list = $('reader-feed-list');
    list.textContent = '';
    var subscribed = st.feeds.filter(function (feed) { return feed.subscribed; });
    var kept = st.feeds.filter(function (feed) { return !feed.subscribed; });
    var unread = subscribed.reduce(function (sum, feed) { return sum + (feed.unread || 0); }, 0);
    $('reader-count').textContent = subscribed.length + ' 个订阅 · ' + unread + ' 篇未读';
    $('reader-all').classList.toggle('active', !st.currentFeed);
    $('reader-all').setAttribute('aria-pressed', String(!st.currentFeed));
    $('reader-total').textContent = unread > 99 ? '99+' : String(unread);
    $('reader-total').hidden = !unread;
    var current = findFeed(st.currentFeed);
    $('reader-refresh').disabled = !current || !current.subscribed;
    $('reader-refresh').title = current && current.subscribed ? '刷新「' + (current.title || current.feed_url) + '」' : '选择一个订阅源后刷新';
    if (!subscribed.length && !kept.length) {
      var empty = document.createElement('li');
      empty.className = 'reader-feed-empty';
      empty.textContent = '还没有订阅源，粘贴一个公开 RSS/Atom 地址开始。';
      list.appendChild(empty);
    }
    subscribed.forEach(function (feed) { list.appendChild(feedRow(feed)); });
    if (kept.length) {
      var head = document.createElement('li');
      head.className = 'reader-feed-group';
      head.textContent = '已取消订阅（保留内容）';
      list.appendChild(head);
      kept.forEach(function (feed) { list.appendChild(feedRow(feed)); });
    }
  }

  async function addFeed(url) {
    var submit = $('reader-add').querySelector('button');
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = '订阅中…';
    status('正在读取订阅源…');
    try {
      var data = await T.post('/v1/reader/subscriptions', { feed_url: url }, { timeoutMs: 30000 });
      status('');
      toast('已订阅「' + ((data.feed && data.feed.title) || '源') + '」');
      $('reader-add-url').value = '';
      st.currentFeed = data.feed ? data.feed.id : st.currentFeed;
      await loadFeeds();
      await loadEntries(true);
    } catch (error) {
      status('');
      toast(describeError(error));
    } finally {
      submit.disabled = false;
      submit.textContent = '订阅';
    }
  }

  async function unsubscribeFeed(feed) {
    await T.del('/v1/reader/subscriptions/' + feed.id);
    if (st.currentFeed === feed.id) st.currentFeed = null;
    await loadFeeds();
    await loadEntries(true);
  }

  async function resubscribeFeed(feed) {
    await T.post('/v1/reader/subscriptions', { feed_url: feed.feed_url }, { timeoutMs: 30000 });
    await loadFeeds();
    await loadEntries(true);
  }

  async function deleteFeed(feed) {
    if (!window.confirm('删除「' + (feed.title || feed.feed_url) + '」的全部本地文章、收藏与已读状态？')) return;
    await T.del('/v1/reader/feeds/' + feed.id);
    if (st.currentFeed === feed.id) st.currentFeed = null;
    await loadFeeds();
    await loadEntries(true);
  }

  // --- 文章列表 ---

  async function refreshFeed(feedId, force) {
    await T.post('/v1/reader/feeds/' + feedId + '/refresh', { force: force }, { timeoutMs: 30000 });
    await loadFeeds();
    if (st.currentFeed !== feedId) return;
    await loadEntries(true);
    // 源刷新也更新已打开的正文，否则旧的纯文本摘要会一直留在阅读区。
    var current = st.current;
    if (!current || current.feed_id !== feedId) return;
    var epoch = st.detailEpoch;
    var data = await T.get('/v1/reader/entries/' + current.id, { timeoutMs: 20000 });
    if (epoch !== st.detailEpoch || st.currentFeed !== feedId || !data.entry) return;
    var next = data.entry;
    if (next.document_key === current.document_key && next.content_html === current.content_html
      && next.summary === current.summary && next.content_status === current.content_status) return;
    ++st.detailEpoch;
    st.current = next;
    st.imagesLoaded = false;
    entryStatus('');
    renderEntry();
  }

  function openFeed(feedId) {
    st.currentFeed = feedId;
    renderFeeds();
    loadEntries(true);
    // 进入当前源时按需刷新：force=false 时服务端在 TTL 内直接复用缓存。
    var feed = findFeed(feedId);
    if (feed && feed.subscribed) {
      refreshFeed(feedId, false)
        .catch(function (error) {
          var detail = error && error.error;
          if (detail && detail.code === 'reader_busy') return;
          status('刷新失败：' + describeError(error));
        });
    }
  }

  function entriesQuery(reset) {
    var query = '';
    if (st.currentFeed) query += 'feed_id=' + encodeURIComponent(st.currentFeed) + '&';
    if (st.filter === 'unread') query += 'unread=true&';
    if (st.filter === 'starred') query += 'starred=true&';
    if (!reset && st.cursor) query += 'cursor=' + encodeURIComponent(st.cursor) + '&';
    return '/v1/reader/entries?' + query + 'limit=30';
  }

  async function loadEntries(reset) {
    var epoch = ++st.epoch;
    $('reader-entry-list').setAttribute('aria-busy', 'true');
    $('reader-more').disabled = true;
    if (reset) status('正在加载文章…');
    try {
      var data = await T.get(entriesQuery(reset), { timeoutMs: 15000 });
      if (epoch !== st.epoch) return;
      st.items = reset ? (data.items || []) : st.items.concat(data.items || []);
      st.cursor = data.next_cursor || null;
      status('');
    } catch (error) {
      if (epoch === st.epoch) status(describeError(error));
      return;
    } finally {
      if (epoch === st.epoch) {
        $('reader-entry-list').setAttribute('aria-busy', 'false');
        $('reader-more').disabled = false;
      }
    }
    renderEntries();
  }

  function entryRow(item) {
    var li = document.createElement('li');
    li.className = 'reader-entry' + (item.is_read ? '' : ' unread') + (item.starred ? ' starred' : '') + (st.selectedId === item.id ? ' active' : '');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'reader-entry-main';
    if (st.selectedId === item.id) button.setAttribute('aria-current', 'true');
    var title = document.createElement('span');
    title.className = 'reader-entry-title';
    title.textContent = item.title;
    button.appendChild(title);
    var summary = document.createElement('span');
    summary.className = 'reader-entry-summary';
    summary.textContent = item.summary || '（无摘要）';
    button.appendChild(summary);
    var meta = document.createElement('span');
    meta.className = 'reader-entry-meta';
    var feed = findFeed(item.feed_id);
    meta.textContent = [feed ? feed.title : '', dateText(item.published_at)].filter(Boolean).join(' · ');
    button.appendChild(meta);
    button.addEventListener('click', function () { openEntry(item.id); });
    li.appendChild(button);
    var star = document.createElement('button');
    star.type = 'button';
    star.className = 'btn reader-entry-star';
    star.textContent = item.starred ? '★' : '☆';
    star.setAttribute('aria-label', item.starred ? '取消收藏' : '收藏');
    star.setAttribute('aria-pressed', String(!!item.starred));
    star.addEventListener('click', function () { return toggleStar(item); });
    li.appendChild(star);
    return li;
  }

  function renderEntries() {
    var list = $('reader-entry-list');
    var scrollTop = list.scrollTop;
    list.textContent = '';
    if (!st.items.length) {
      var empty = document.createElement('li');
      empty.className = 'reader-entry-empty';
      empty.textContent = st.filter === 'unread' ? '未读文章已读完。' : st.filter === 'starred' ? '还没有收藏文章，点击文章旁的星标即可收藏。' : '这里还没有文章。添加订阅源，或选择一个源刷新。';
      list.appendChild(empty);
    }
    st.items.forEach(function (item) { list.appendChild(entryRow(item)); });
    list.scrollTop = scrollTop;
    $('reader-more').hidden = !st.cursor;
  }

  async function toggleStar(item) {
    try {
      await T.put('/v1/reader/entries/' + item.id + '/state', {
        is_read: item.is_read,
        starred: !item.starred,
      });
      item.starred = !item.starred;
      if (st.current && st.current.id === item.id) {
        st.current.starred = item.starred;
        renderEntryHead(st.current);
      }
      renderEntries();
    } catch (error) {
      toast(describeError(error));
    }
  }

  // --- 正文阅读 ---

  async function openEntry(id) {
    var epoch = ++st.detailEpoch;
    st.selectedId = id;
    st.current = null;
    st.imagesLoaded = false;
    $('view-reader').classList.add('reader-reading');
    document.querySelector('.reader-article').setAttribute('aria-busy', 'true');
    document.querySelector('.reader-article').scrollTop = 0;
    $('reader-welcome').hidden = true;
    $('reader-entry-head').hidden = true;
    $('reader-content').hidden = true;
    $('reader-retry').hidden = true;
    renderEntries();
    entryStatus('正在加载正文…');
    try {
      var data = await T.get('/v1/reader/entries/' + id, { timeoutMs: 20000 });
      if (epoch !== st.detailEpoch) return;
      st.current = data.entry;
      entryStatus('');
      renderEntry();
      $('reader-entry-title').focus({ preventScroll: true });
      if (!st.current.is_read) markRead(st.current);
    } catch (error) {
      if (epoch === st.detailEpoch) {
        entryStatus(describeError(error));
        $('reader-retry').hidden = false;
      }
    } finally {
      if (epoch === st.detailEpoch) document.querySelector('.reader-article').setAttribute('aria-busy', 'false');
    }
  }

  async function markRead(entry) {
    try {
      await T.put('/v1/reader/entries/' + entry.id + '/state', {
        is_read: true,
        starred: entry.starred,
      });
      entry.is_read = true;
      for (var i = 0; i < st.items.length; i++) {
        if (st.items[i].id === entry.id) st.items[i].is_read = true;
      }
      for (var j = 0; j < st.feeds.length; j++) {
        if (st.feeds[j].id === entry.feed_id && st.feeds[j].unread > 0) {
          st.feeds[j].unread -= 1;
        }
      }
      renderFeeds();
      renderEntries();
    } catch (error) {
      // 已读标记失败不打断阅读；重开文章会再补一次。
    }
  }

  function renderEntry() {
    var entry = st.current;
    renderEntryHead(entry);
    var box = $('reader-content');
    box.textContent = '';
    box.hidden = false;
    var content = entry.content_html;
    if (content) {
      var holder = document.createElement('div');
      holder.className = 'reader-document';
      holder.innerHTML = content;
      sanitizeTree(holder);
      formatDocument(holder);
      var images = holder.querySelectorAll('img');
      images.forEach(function (img) {
        var key = img.getAttribute('src') || '';
        if (/^[0-9a-f]{32}$/.test(key)) img.dataset.readerImageKey = key;
        img.removeAttribute('src');
        img.removeAttribute('width');
        img.removeAttribute('height');
        img.dataset.readerAlt = img.alt || '正文图片';
        img.alt = img.dataset.readerAlt + ' · 图片尚未加载';
        img.hidden = true;
        img.classList.add('reader-image-pending');
        var placeholder = document.createElement('span');
        placeholder.className = 'reader-image-placeholder';
        placeholder.textContent = img.alt;
        img.after(placeholder);
      });
      box.appendChild(holder);
      $('reader-load-images').hidden = images.length === 0;
      $('reader-load-images').textContent = '加载本文图片（' + images.length + '）';
      $('reader-load-images').disabled = false;
      if (entry.content_status === 'truncated') {
        entryStatus('正文超过单篇上限已截断，完整内容请打开原文。');
      }
    } else {
      $('reader-load-images').hidden = true;
      if (entry.summary) {
        var note = document.createElement('p');
        note.className = 'reader-summary-note';
        note.textContent = '订阅源内容（可能仅含摘要）：';
        box.appendChild(note);
        var text = document.createElement('p');
        text.className = 'reader-plain-text';
        text.textContent = entry.summary;
        box.appendChild(text);
      } else {
        box.textContent = '此条目未提供正文。';
      }
      if (entry.content_status === 'over_budget' || entry.content_status === 'over_limit') {
        entryStatus('正文因超出缓存预算未保存，请打开原文阅读。');
      }
    }
  }

  function formatDocument(holder) {
    // 一些新闻源把图片与说明作为相邻节点输出，合为 figure 后统一控制间距。
    holder.querySelectorAll('figcaption').forEach(function (caption) {
      if (caption.parentElement.tagName === 'FIGURE') return;
      var previous = caption.previousElementSibling;
      if (!previous || previous.tagName !== 'P' || previous.textContent.trim()
        || !previous.querySelector('img') || previous.querySelectorAll('img').length !== 1
        || previous.querySelector('br, hr, table, figure')) return;
      var figure = document.createElement('figure');
      previous.before(figure);
      while (previous.firstChild) figure.appendChild(previous.firstChild);
      previous.remove();
      figure.appendChild(caption);
    });
    // 日报常用独占一段的粗体文字作栏目名；只提升紧接列表的短标题。
    holder.querySelectorAll('p').forEach(function (paragraph) {
      var bold = paragraph.firstElementChild;
      var next = paragraph.nextElementSibling;
      var text = paragraph.textContent.trim();
      if (paragraph.children.length === 1 && bold && /^(STRONG|B)$/.test(bold.tagName)
        && text && text.length <= 80 && text === bold.textContent.trim()
        && next && /^(UL|OL)$/.test(next.tagName)) {
        paragraph.classList.add('reader-section-heading');
      }
    });
    holder.querySelectorAll('table').forEach(function (table) {
      var wrapper = document.createElement('div');
      wrapper.className = 'reader-table-wrap';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      var caption = table.querySelector('caption');
      wrapper.setAttribute('aria-label', caption ? caption.textContent.trim() : '正文表格');
      table.before(wrapper);
      wrapper.appendChild(table);
    });
    if (!holder.querySelector('p, h1, h2, h3, h4, h5, h6, ul, ol, dl, pre, table, blockquote, div, figure')) {
      holder.classList.add('reader-plain-text');
    }
  }

  function renderEntryHead(entry) {
    var head = $('reader-entry-head');
    head.hidden = false;
    $('reader-entry-title').textContent = entry.title;
    var feed = findFeed(entry.feed_id);
    var parts = [feed ? feed.title : '', entry.author, dateText(entry.published_at)];
    $('reader-entry-meta').textContent = parts.filter(Boolean).join(' · ');
    var original = $('reader-open-original');
    if (entry.original_url) {
      original.hidden = false;
      original.href = entry.original_url;
    } else {
      original.hidden = true;
      original.removeAttribute('href');
    }
    $('reader-star').textContent = entry.starred ? '★ 已收藏' : '☆ 收藏';
    $('reader-star').setAttribute('aria-pressed', String(!!entry.starred));
  }

  async function loadImages() {
    var entry = st.current;
    if (!entry || st.imagesLoaded) return;
    st.imagesLoaded = true;
    var epoch = st.detailEpoch;
    var button = $('reader-load-images');
    button.disabled = true;
    button.textContent = '正在加载图片…';
    var box = $('reader-content');
    var images = Array.from(box.querySelectorAll('img.reader-image-pending'));
    var failed = 0;
    await Promise.all(images.map(function (img) {
      var key = img.dataset.readerImageKey || '';
      if (!key) { failed += 1; return; }
      return T.get('/v1/reader/entries/' + entry.id + '/images/' + key, { timeoutMs: 45000 })
        .then(async function (data) {
          img.src = 'data:' + (data.content_type || 'image/jpeg') + ';base64,' + data.data;
          await img.decode();
          img.alt = img.dataset.readerAlt;
          img.hidden = false;
          img.classList.remove('reader-image-pending');
          var placeholder = img.nextElementSibling;
          if (placeholder && placeholder.classList.contains('reader-image-placeholder')) placeholder.remove();
        })
        .catch(function () {
          failed += 1;
          img.removeAttribute('src');
          img.alt = img.dataset.readerAlt + ' · 加载失败';
          var placeholder = img.nextElementSibling;
          if (placeholder && placeholder.classList.contains('reader-image-placeholder')) placeholder.textContent = img.alt;
        });
    }));
    if (epoch !== st.detailEpoch) return;
    st.imagesLoaded = !failed;
    button.disabled = !failed;
    button.textContent = failed ? failed + ' 张图片未加载，点击重试' : '图片已加载';
  }

  // 客户端兜底清洗：服务端已经 ammonia 白名单清洗，这里再把节点树过一遍，
  // 只放行阅读需要的标签与安全属性，事件属性与远程地址一律剥除。
  var DROP_TAGS = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1, SVG: 1, MATH: 1,
    AUDIO: 1, VIDEO: 1, SOURCE: 1, TRACK: 1, BASE: 1, NOSCRIPT: 1, TEMPLATE: 1,
  };
  var ALLOWED_TAGS = {
    A: 1, P: 1, BR: 1, HR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1, STRONG: 1, EM: 1,
    B: 1, I: 1, U: 1, S: 1, SUB: 1, SUP: 1, SMALL: 1, MARK: 1, TIME: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1, CAPTION: 1,
    IMG: 1, FIGURE: 1, FIGCAPTION: 1, SPAN: 1, DIV: 1, DL: 1, DT: 1, DD: 1,
    ABBR: 1, CITE: 1, KBD: 1, SAMP: 1, VAR: 1,
  };

  function safeAttribute(tag, name, value) {
    if (name === 'colspan' || name === 'rowspan') return true;
    if (tag === 'A' && name === 'href') return /^https?:\/\//i.test(value || '');
    if (tag === 'IMG' && (name === 'src' || name === 'alt' || name === 'width' || name === 'height')) return true;
    return false;
  }

  function sanitizeTree(root) {
    var stack = [root];
    while (stack.length) {
      var el = stack.pop();
      var children = Array.prototype.slice.call(el.children);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var tag = child.tagName;
        if (DROP_TAGS[tag]) {
          child.remove();
          continue;
        }
        if (!ALLOWED_TAGS[tag]) {
          var frag = document.createDocumentFragment();
          while (child.firstChild) frag.appendChild(child.firstChild);
          child.parentNode.replaceChild(frag, child);
          stack.push(el);
          break;
        }
        var attributes = Array.prototype.slice.call(child.attributes);
        attributes.forEach(function (attr) {
          if (!safeAttribute(tag, attr.name.toLowerCase(), attr.value)) child.removeAttribute(attr.name);
        });
        if (tag === 'A') {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        stack.push(child);
      }
    }
  }

  // --- 网页全屏 ---

  function fullscreenActive() {
    var view = $('view-reader');
    return !!view && view.classList.contains('reader-fullscreen');
  }

  function syncFullscreenButton() {
    var button = $('reader-fullscreen');
    if (!button) return;
    var on = fullscreenActive();
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? '退出网页全屏' : '网页全屏';
    button.setAttribute('aria-label', button.title);
    var use = button.querySelector('use');
    if (use) use.setAttribute('href', on ? '#i-compress' : '#i-fullscreen');
  }

  function setFullscreen(on) {
    var view = $('view-reader');
    if (!view || fullscreenActive() === on) return;
    view.classList.toggle('reader-fullscreen', on);
    syncFullscreenButton();
    var target = on
      ? (document.querySelector('#reader-entry-head:not([hidden]) h2') || $('reader-fullscreen'))
      : $('reader-fullscreen');
    if (target) target.focus({ preventScroll: true });
  }

  // --- 入口 ---

  function setFilter(filter) {
    st.filter = filter;
    document.querySelectorAll('[data-reader-filter]').forEach(function (button) {
      var active = button.getAttribute('data-reader-filter') === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    loadEntries(true);
  }

  function bind(host) {
    T = window.VMusicTransport;
    toast = host.toast || toast;
    $('reader-add').addEventListener('submit', function (event) {
      event.preventDefault();
      var url = $('reader-add-url').value.trim();
      if (url) addFeed(url);
    });
    document.querySelectorAll('[data-reader-filter]').forEach(function (button) {
      button.addEventListener('click', function () {
        setFilter(button.getAttribute('data-reader-filter'));
      });
    });
    $('reader-more').addEventListener('click', function () { loadEntries(false); });
    $('reader-refresh').addEventListener('click', function () {
      var feed = st.currentFeed && findFeed(st.currentFeed);
      if (!feed) {
        toast('先选择一个订阅源');
        return;
      }
      status('正在刷新…');
      refreshFeed(feed.id, true)
        .then(function () { status(''); })
        .catch(function (error) { status('刷新失败：' + describeError(error)); });
    });
    $('reader-star').addEventListener('click', function () {
      if (st.current) toggleStar(st.current);
    });
    $('reader-load-images').addEventListener('click', loadImages);
    $('reader-all').addEventListener('click', function () { openFeed(null); });
    $('reader-retry').addEventListener('click', function () { if (st.selectedId) openEntry(st.selectedId); });
    $('reader-fullscreen').addEventListener('click', function () { setFullscreen(!fullscreenActive()); });
    $('view-reader').addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !fullscreenActive() || event.defaultPrevented) return;
      event.preventDefault();
      setFullscreen(false);
    });
    $('reader-back').addEventListener('click', function () {
      if (fullscreenActive()) setFullscreen(false);
      $('view-reader').classList.remove('reader-reading');
      var selected = $('reader-entry-list').querySelector('[aria-current="true"]');
      var target = selected || document.querySelector('[data-reader-filter].active');
      if (target) target.focus({ preventScroll: true });
    });
  }

  function onViewEnter() {
    setFullscreen(false);
    if (st.loaded || !T) return;
    st.loaded = true;
    loadFeeds()
      .then(function () { return loadEntries(true); })
      .catch(function (error) { status(describeError(error)); });
  }

  window.Reader = { bind: bind, onViewEnter: onViewEnter };
})();
