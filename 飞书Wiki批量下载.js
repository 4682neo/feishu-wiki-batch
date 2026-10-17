// ==UserScript==
// @name         飞书 Wiki 批量下载（Markdown + 图片）
// @namespace    https://7998888.xyz
// @version      1.0
// @description  批量导出飞书 Wiki 知识库文档为 Markdown（含图片），递归遍历目录树，异步导出+并发下载
// @author       代可行
// @match        https://*.feishu.cn/wiki/*
// @match        https://*.feishu.com/wiki/*
// @match        https://*.larksuite.com/wiki/*
// @icon         https://www.feishu.cn/favicon.ico
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      internal-api-drive-stream.feishu.cn
// @connect      internal-api-drive-stream.feishu.com
// @connect      internal-api-drive-stream.larksuite.com
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 修复 JSZip 在 ScriptCat 沙箱中挂起的问题：
  // JSZip 内部用 setImmediate（utils.delay）驱动流式解压，但 setimmediate
  // polyfill 在沙箱里失效（优先用 MessageChannel/postMessage），导致 async() 永不 resolve。
  // 这里强制用 setTimeout 实现 setImmediate。
  (function patchSetImmediate() {
    var realSetTimeout = window.setTimeout;
    window.setImmediate = function (cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      return realSetTimeout(function () { cb.apply(null, args); }, 0);
    };
    window.clearImmediate = function (id) { window.clearTimeout(id); };
  })();

  // ══════════════════════════════════════════════════════════════════
  //  配置
  // ══════════════════════════════════════════════════════════════════
  const CFG = {
    CONCURRENCY: 3,           // 文件间并发数（有 429 退避重试兜底，可适度并发）
    POLL_INTERVALS: [1000, 2000, 3000], // 自适应轮询间隔（ms）
    POLL_TIMEOUT: 180000,     // 轮询超时（ms），大文档导出较慢，给足 3 分钟
    REQUEST_DELAY: 800,       // 请求间隔（ms），避免频率限制
    CHUNK_SIZE: 4 * 1024 * 1024,   // 分块大小
    CHUNK_PARALLEL: 3,        // 分块并发数
    DIRECT_LIMIT: 10 * 1024 * 1024, // 直接下载上限
  };

  const L = (...a) => console.log('[WikiBatch]', ...a);
  const W = (...a) => console.warn('[WikiBatch]', ...a);
  const E = (...a) => console.error('[WikiBatch]', ...a);

  // ══════════════════════════════════════════════════════════════════
  //  公用工具
  // ══════════════════════════════════════════════════════════════════

  function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '_').trim(); }

  // 路径上移 n 层（用于附件目录层级配置）
  function upDir(path, n) {
    if (!path) return '';
    var parts = path.split('/').filter(Boolean);
    for (var i = 0; i < n; i++) parts.pop();
    return parts.join('/');
  }

  // 计算从 fromDir 目录到 toPath 的相对路径（含 ../ 前缀）
  function relPath(fromDir, toPath) {
    var fromParts = fromDir ? fromDir.split('/').filter(Boolean) : [];
    var toParts = toPath.split('/').filter(Boolean);
    var i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    var ups = fromParts.length - i;
    var segs = [];
    for (var j = 0; j < ups; j++) segs.push('..');
    segs = segs.concat(toParts.slice(i));
    return segs.join('/');
  }

  function getCsrfToken() {
    var m = document.cookie.match(/_csrf_token=([^;]+)/);
    if (m) return m[1];
    // 备选：从 meta 标签取
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) return meta.getAttribute('content');
    return '';
  }

  function genRequestId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 12; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id + '-' + getCookie('passport_web_did') + '-' + Date.now();
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? m[1] : '';
  }

  function getDomain() { return location.hostname; }

  function getOrigin() { return location.origin; }

  function driveStreamHost() {
    var h = getDomain();
    if (h.includes('feishu.cn')) return 'internal-api-drive-stream.feishu.cn';
    if (h.includes('feishu.com')) return 'internal-api-drive-stream.feishu.com';
    if (h.includes('larksuite.com')) return 'internal-api-drive-stream.larksuite.com';
    return h.replace(/^[^.]+/, 'internal-api-drive-stream');
  }

  function contextHeader() {
    return 'request_id=' + genRequestId() + ';os=windows;app_version=2.0.1.3036;os_version=10;platform=web';
  }

  function commonHeaders() {
    return {
      'content-type': 'application/json',
      'context': contextHeader(),
      'x-csrftoken': getCsrfToken(),
      'x-lgw-app-id': '1161',
      'x-lgw-os-type': '1',
      'x-lgw-terminal-type': '2',
      'x-lsc-bizid': '2',
      'x-lsc-terminal': 'web',
      'x-lsc-version': '1',
    };
  }

  function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // 统一的请求重试：对 429 限频、5xx 服务器错误、网络异常做指数退避重试。
  // 4xx（除 429）属于确定性错误，不重试。
  async function fetchWithRetry(url, options, retryOpts) {
    var maxRetries = (retryOpts && retryOpts.retries) || 3;
    var baseDelay = (retryOpts && retryOpts.baseDelay) || 1000;
    var retryStatuses = (retryOpts && retryOpts.retryStatuses) || [429, 500, 502, 503, 504];

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      var resp;
      try {
        resp = await fetch(url, options);
      } catch (e) {
        if (attempt < maxRetries) {
          var w1 = baseDelay * Math.pow(2, attempt);
          L('fetch 网络错误，重试', attempt + 1, ':', e.message, 'wait', w1, 'ms');
          await delay(w1);
          continue;
        }
        throw e;
      }

      if (retryStatuses.indexOf(resp.status) !== -1 && attempt < maxRetries) {
        var w2 = baseDelay * Math.pow(2, attempt);
        L('fetch HTTP', resp.status, '，重试', attempt + 1, 'wait', w2, 'ms');
        await delay(w2);
        continue;
      }

      return resp;
    }

    throw new Error('fetchWithRetry 重试耗尽');
  }

  function fmtsz(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块1：Wiki 树枚举
  // ══════════════════════════════════════════════════════════════════

  function getCurrentWikiToken() {
    var m = location.pathname.match(/\/wiki\/([\w.-]+)/);
    return m ? m[1] : null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  space_id 捕获（多重策略）
  //  space_id 不在 DOM 中，只出现在页面自身 API 请求的 URL 参数里
  //  需要 intercept fetch/XHR + Performance API 来捕获
  // ══════════════════════════════════════════════════════════════════
  var _capturedSpaceId = null;

  function _tryCaptureSpaceId(url) {
    if (_capturedSpaceId) return;
    var m = url.match(/space_id=(\d{10,})/);
    if (m) {
      _capturedSpaceId = m[1];
      L('Captured space_id:', _capturedSpaceId);
    }
  }

  // 策略1：拦截 fetch
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
    _tryCaptureSpaceId(url);
    return _origFetch.apply(this, arguments);
  };

  // 策略2：拦截 XMLHttpRequest
  var _origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    _tryCaptureSpaceId(url);
    return _origXHROpen.apply(this, arguments);
  };

  // 策略3：PerformanceObserver 监听后续请求
  try {
    new PerformanceObserver(function(list) {
      list.getEntries().forEach(function(e) { _tryCaptureSpaceId(e.name); });
    }).observe({ type: 'resource', buffered: true });
  } catch (_) {}

  function getSpaceId() {
    // 优先返回已捕获的值
    if (_capturedSpaceId) return _capturedSpaceId;

    // 策略4：从 Performance API 的历史请求中提取
    try {
      var entries = performance.getEntriesByType('resource');
      for (var i = entries.length - 1; i >= 0; i--) {
        _tryCaptureSpaceId(entries[i].name);
        if (_capturedSpaceId) return _capturedSpaceId;
      }
    } catch (_) {}

    // 策略5：从页面内联 JS 数据中找
    try {
      var scripts = document.querySelectorAll('script');
      for (var i = 0; i < scripts.length; i++) {
        var txt = scripts[i].textContent || '';
        var m = txt.match(/space_id['":\s]+['"]?(\d{10,})/);
        if (m) { _capturedSpaceId = m[1]; return m[1]; }
      }
    } catch (_) {}

    // 策略6：从 DOM 属性中找
    var el = document.querySelector('[data-space-id]');
    if (el) { _capturedSpaceId = el.getAttribute('data-space-id'); return _capturedSpaceId; }

    return null;
  }

  function getDocsHostInfo() {
    // 从 cookie 或页面中获取 docs-host-id / docs-host-type
    var wikiToken = getCurrentWikiToken();
    return {
      'docs-host-id': wikiToken || '',
      'docs-host-type': 'Wiki',
    };
  }

  function makeHeaders(isPost) {
    var h = Object.assign({}, commonHeaders(), getDocsHostInfo(), {
      'accept': 'application/json, text/plain, */*',
      'f-version': 'docs-8-12-' + Date.now(),
    });
    if (!isPost) delete h['content-type'];
    return h;
  }

  function parseNodeItem(item) {
    var node = item.node || item;
    return {
      wikiToken: node.token || node.wiki_token || '',
      objToken: node.obj_token || '',
      objType: node.obj_type || 0,
      title: node.title || '',
      hasChild: !!node.has_child,
      nodeType: node.obj_type === 22 ? 'docx' : (node.obj_type === 2 ? 'sheet' : 'other'),
    };
  }

  async function getSpaceInfo(spaceId) {
    // 获取 wiki 空间信息（含根节点 token）
    var url = getOrigin() + '/space/api/wiki/v2/space/get_info/?space_id=' + spaceId;
    try {
      var resp = await fetchWithRetry(url, { headers: makeHeaders(false), credentials: 'include' }, { retries: 3, baseDelay: 1000 });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (data.code !== 0) throw new Error('API error: ' + (data.msg || data.code));
      L('Space info:', JSON.stringify(data.data).substring(0, 500));
      return data.data || {};
    } catch (e) {
      E('getSpaceInfo failed:', e);
      return {};
    }
  }

  async function getNodeInfo(spaceId, wikiToken) {
    // 获取单个节点信息
    var url = getOrigin() + '/space/api/wiki/v2/tree/get_node/'
      + '?wiki_token=' + wikiToken
      + '&space_id=' + spaceId
      + '&expand_shortcut=true'
      + '&with_deleted=true';
    try {
      var resp = await fetchWithRetry(url, { headers: makeHeaders(false), credentials: 'include' }, { retries: 3, baseDelay: 1000 });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (data.code !== 0) throw new Error('API error: ' + (data.msg || data.code));
      L('Node info:', JSON.stringify(data.data).substring(0, 500));
      return data.data || {};
    } catch (e) {
      E('getNodeInfo failed:', wikiToken, e);
      return {};
    }
  }

  async function getNodeChildren(spaceId, wikiToken) {
    var url = getOrigin() + '/space/api/wiki/v2/tree/get_node_child/'
      + '?space_id=' + spaceId
      + '&wiki_token=' + wikiToken
      + '&expand_shortcut=true'
      + '&exclude_fields=5'
      + '&is_pre_heating=false';

    try {
      var resp = await fetchWithRetry(url, { headers: makeHeaders(false), credentials: 'include' }, { retries: 4, baseDelay: 2000 });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (data.code !== 0) throw new Error('API error: ' + (data.msg || data.code));

      L('get_node_child response for', wikiToken, ':', JSON.stringify(data.data).substring(0, 500));

      var items = [];
      if (data.data && data.data.items) {
        items = data.data.items;
      } else if (data.data && data.data.nodes) {
        items = data.data.nodes;
      } else if (data.data && Array.isArray(data.data)) {
        items = data.data;
      } else if (data.data && typeof data.data === 'object') {
        // 响应是 Map 格式：{"wiki_token": [children]}
        var keys = Object.keys(data.data);
        for (var k = 0; k < keys.length; k++) {
          if (Array.isArray(data.data[keys[k]])) {
            items = data.data[keys[k]];
            break;
          }
        }
      }

      return items.map(parseNodeItem);
    } catch (e) {
      // 重试后仍失败：明确告警，提示该节点子节点可能遗漏
      E('getNodeChildren failed（重试后仍失败，该节点子节点可能遗漏）:', wikiToken, e);
      return [];
    }
  }

  async function buildWikiTree(spaceId, wikiToken, onProgress) {
    var rootToken = wikiToken;
    var rootTitle = '';
    var rootObjToken = '';
    var rootHasChild = true;

    // 策略1：通过 space/get_info 获取根节点 token（可能 PermFail）
    var spaceInfo = await getSpaceInfo(spaceId);
    if (spaceInfo.space) {
      var sp = spaceInfo.space;
      rootToken = sp.root_node_token || sp.wiki_token || wikiToken;
      rootTitle = sp.name || sp.title || '';
      L('Root from space_info: token=' + rootToken + ' title=' + rootTitle);
    }

    // 策略2：从当前节点向上遍历 parent_wiki_token 找到根节点
    if (rootToken === wikiToken) {
      var curToken = wikiToken;
      var visitedUp = new Set();
      visitedUp.add(curToken);

      while (curToken) {
        var nodeInfo = await getNodeInfo(spaceId, curToken);
        // getNodeInfo 返回的 data.data 就是节点对象本身（不是 {node:...} 包裹的）
        var n = nodeInfo.node || nodeInfo;
        if (!n || !n.wiki_token) break;

        rootToken = n.wiki_token || curToken;
        rootTitle = n.title || '';
        rootObjToken = n.obj_token || '';
        rootHasChild = n.has_child !== false;

        L('Walk up: token=' + rootToken + ' title=' + rootTitle + ' hasChild=' + rootHasChild + ' parent=' + (n.parent_wiki_token || 'none'));

        // 如果有父节点，继续向上
        if (n.parent_wiki_token && !visitedUp.has(n.parent_wiki_token)) {
          visitedUp.add(n.parent_wiki_token);
          curToken = n.parent_wiki_token;
          await delay(CFG.REQUEST_DELAY);
        } else {
          // 到达根节点
          break;
        }
      }
    }

    // BFS 构建完整 wiki 树
    var root = {
      wikiToken: rootToken,
      title: rootTitle || '根节点',
      children: [],
      objToken: rootObjToken,
      objType: 22,
      nodeType: 'docx',
      hasChild: rootHasChild,
      depth: 0,
    };

    var queue = [root];
    var visited = new Set();
    visited.add(rootToken);
    var total = 1, fetched = 0;

    while (queue.length > 0) {
      var node = queue.shift();
      if (!node.hasChild) continue;

      var children = await getNodeChildren(spaceId, node.wikiToken);
      fetched++;
      if (onProgress) onProgress(fetched, total);

      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        child.depth = node.depth + 1;
        child.children = [];
        if (!visited.has(child.wikiToken)) {
          visited.add(child.wikiToken);
          node.children.push(child);
          if (child.hasChild) queue.push(child);
          total++;
        }
      }

      if (fetched >= 1) await delay(CFG.REQUEST_DELAY);
    }

    // 如果根节点没有标题，从页面标题获取
    if (!root.title || root.title === '根节点') {
      var titleEl = document.querySelector('[class*="catalogue"] [class*="list-item"]')
        || document.querySelector('.page-block-content h1, [class*="docTitle"], h1');
      if (titleEl) root.title = titleEl.textContent.trim();
    }

    L('Wiki tree built: ' + total + ' nodes, root=' + root.title);
    return root;
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块2：单文档导出
  // ══════════════════════════════════════════════════════════════════

  async function createExportTask(objToken) {
    var url = getOrigin() + '/space/api/export/create/';

    var body = JSON.stringify({
      token: objToken,
      type: 'docx',
      file_extension: 'md',
      event_source: '6',
      passback: JSON.stringify({ include_file: true }),
      need_comment: false,
    });

    var headers = Object.assign({}, commonHeaders(), getDocsHostInfo(), {
      'accept': 'application/json, text/plain, */*',
      'f-version': 'docs-8-12-' + Date.now(),
    });

    // 遇到 429 限频时退避重试
    var maxRetries = 5;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      var resp = await fetch(url, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: body,
      });

      if (resp.status === 429) {
        var wait = 3000 * (attempt + 1);
        L('export create 429, retry after', wait, 'ms (attempt', attempt + 1, ')');
        await delay(wait);
        continue;
      }

      if (!resp.ok) throw new Error('export create HTTP ' + resp.status);

      var data = await resp.json();
      L('Export create response for', objToken, ':', JSON.stringify(data).substring(0, 500));

      if (data.code !== 0) {
        // 部分限频可能以业务码返回而非 HTTP 429
        if (data.code === 429 || /频|限|too many|rate.?limit/i.test(data.msg || '')) {
          var wait2 = 3000 * (attempt + 1);
          L('export create rate-limited (code', data.code, '), retry after', wait2, 'ms');
          await delay(wait2);
          continue;
        }
        throw new Error('export create error: ' + (data.msg || data.code));
      }

      var ticket = data.data && data.data.ticket;
      if (!ticket) throw new Error('no ticket in response');
      L('Export task created:', ticket, 'for', objToken);
      return ticket;
    }

    throw new Error('export create 持续限频（429），已重试 ' + maxRetries + ' 次');
  }

  async function pollExportResult(ticket, objToken, onProgress) {
    var url = getOrigin() + '/space/api/export/result/' + ticket
      + '?token=' + objToken + '&type=docx';

    var t0 = Date.now();
    var pollCount = 0;

    while (Date.now() - t0 < CFG.POLL_TIMEOUT) {
      await delay(CFG.POLL_INTERVALS[Math.min(pollCount, CFG.POLL_INTERVALS.length - 1)]);
      pollCount++;

      var headers = Object.assign({}, commonHeaders(), getDocsHostInfo(), {
        'accept': 'application/json, text/plain, */*',
        'f-version': 'docs-8-12-' + Date.now(),
      });
      delete headers['content-type'];

      var resp = await fetch(url, {
        headers: headers,
        credentials: 'include',
      });

      if (resp.status === 429) {
        L('Poll 429, retry after 3s... (count=' + pollCount + ')');
        await delay(3000);
        continue;
      }
      if (!resp.ok) throw new Error('poll HTTP ' + resp.status);
      var data = await resp.json();

      if (data.code !== 0) {
        E('Poll API error:', data.code, data.msg);
        throw new Error('poll error: ' + (data.msg || data.code));
      }

      // 内部 API 返回 data.data = {"result": {...}}，需要深入一层
      var result = (data.data && data.data.result) ? data.data.result : data.data;
      L('Poll result (count=' + pollCount + '):', JSON.stringify(result).substring(0, 500));
      if (!result) continue;

      // 内部 API 中 file_token 存在 = 导出已完成
      var fileToken = result.file_token || result.token || '';
      if (fileToken) {
        // 只要有 file_token 就说明导出完成了
        L('Export ready, file_token:', fileToken, 'file_name:', result.file_name, 'file_size:', result.file_size, 'ext:', result.file_extension);
        return {
          fileToken: fileToken,
          fileExtension: result.file_extension || 'zip',
          fileName: result.file_name || '',
        };
      }

      // 注意：job_status=2 并不代表失败，而可能是服务端仍在处理中（大文档导出较慢）。
      // 因此不要在这里抛错/重试，而是继续轮询同一个 ticket，等待 file_token 出现。
      // 仅当 job_error_msg 明确给出错误信息时才判定失败。
      if (result.job_error_msg && result.job_error_msg !== 'success') {
        throw new Error('导出任务失败: ' + result.job_error_msg);
      }

      // 没有 file_token，仍在处理中
      if (onProgress) onProgress('processing', pollCount);
    }

    throw new Error('导出轮询超时（' + pollCount + '次轮询）');
  }

  async function downloadExportedFile(fileToken, fileExtension, onProgress) {
    var host = driveStreamHost();
    var url = 'https://' + host + '/space/api/box/stream/download/all/' + fileToken + '/';

    L('Download URL:', url, 'fileExtension:', fileExtension);

    // 直接用 GET 请求下载（HEAD 在 cross-origin 下可能失败）
    var dlHeaders = Object.assign({}, commonHeaders(), getDocsHostInfo(), {
      'accept': 'application/json, text/plain, */*',
    });
    delete dlHeaders['content-type'];

    var expectZip = (fileExtension !== 'md');

    // 遇到 429 或非 zip 响应时重试
    var maxRetries = 3;
    var r = null, blob = null;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      r = await fetch(url, { headers: dlHeaders, credentials: 'include' });
      L('Download response status:', r.status, 'content-type:', r.headers.get('content-type'), 'content-length:', r.headers.get('content-length'));

      if (r.status === 429) {
        var wait = 3000 * (attempt + 1);
        L('download 429, retry after', wait, 'ms (attempt', attempt + 1, ')');
        await delay(wait);
        continue;
      }

      if (!r.ok) {
        var errText = '';
        try { errText = await r.text(); } catch(ex) {}
        throw new Error('download HTTP ' + r.status + ': ' + errText.substring(0, 200));
      }

      // 流式读取
      var total = parseInt(r.headers.get('content-length') || '0', 10);
      var reader = r.body.getReader();
      var parts = [], got = 0, t0 = Date.now();
      while (true) {
        var res = await reader.read();
        if (res.done) break;
        parts.push(res.value);
        got += res.value.length;
        if (onProgress) onProgress(got, total || got, t0);
      }
      blob = new Blob(parts);
      L('Download complete, size:', fmtsz(got));

      // 纯 md 导出（无图片）不校验 zip
      if (!expectZip) {
        return blob;
      }

      // 校验是否为有效 zip（前 2 字节应为 PK）
      if (got < 4) {
        L('download got too few bytes, retry...');
        await delay(2000);
        continue;
      }
      var head = new Uint8Array(parts[0]).slice(0, 2);
      if (head[0] !== 0x50 || head[1] !== 0x4B) { // 'P''K'
        // 非 zip 内容，可能是错误响应
        var sample = '';
        try { sample = await new Blob(parts.slice(0, 3)).text(); } catch(e) {}
        throw new Error('下载内容不是有效 zip（可能是限频或错误响应）: ' + sample.substring(0, 120));
      }
      return blob;
    }

    throw new Error('download 持续失败，已重试 ' + maxRetries + ' 次');
  }

  async function streamDirect(url, total, onProgress) {
    var headers = Object.assign({}, commonHeaders(), getDocsHostInfo(), {
      'accept': 'application/json, text/plain, */*',
    });
    delete headers['content-type'];

    var r = await fetch(url, { headers: headers, credentials: 'include' });
    if (!r.ok) throw new Error('download HTTP ' + r.status);

    var reader = r.body.getReader();
    var parts = [], got = 0, t0 = Date.now();
    while (true) {
      var res = await reader.read();
      if (res.done) break;
      parts.push(res.value);
      got += res.value.length;
      if (onProgress) onProgress(got, total || got, t0);
    }
    return new Blob(parts);
  }

  async function streamChunked(url, total, onProgress) {
    var cs = CFG.CHUNK_SIZE, n = Math.ceil(total / cs);
    var chunks = new Array(n), failed = false, got = 0, t0 = Date.now();
    var jobs = [];
    for (var i = 0; i < n; i++) jobs.push({ i: i, s: i * cs, e: Math.min((i + 1) * cs - 1, total - 1) });

    async function wk() {
      while (jobs.length && !failed) {
        var job = jobs.shift();
        var headers = Object.assign({}, commonHeaders(), getDocsHostInfo(), {
          'accept': 'application/json, text/plain, */*',
          'Range': 'bytes=' + job.s + '-' + job.e,
        });
        delete headers['content-type'];

        var r = await fetch(url, { headers: headers, credentials: 'include' });
        if (!r.ok && r.status !== 206) { failed = true; throw new Error('Chunk ' + job.i + ' ' + r.status); }
        var buf = await r.arrayBuffer();
        chunks[job.i] = new Uint8Array(buf);
        got += buf.byteLength;
        if (onProgress) onProgress(got, total, t0);
      }
    }

    var ws = [];
    for (var p = 0; p < CFG.CHUNK_PARALLEL; p++) ws.push(wk());
    await Promise.all(ws);
    if (failed) throw new Error('Chunk download failed');

    var merged = new Uint8Array(total), off = 0;
    for (var c = 0; c < chunks.length; c++) {
      if (!chunks[c]) throw new Error('missing chunk ' + c);
      merged.set(chunks[c], off); off += chunks[c].length;
    }
    return new Blob([merged]);
  }

  async function exportAndDownload(objToken, onProgress) {
    // 完整的导出流程：创建任务 → 轮询结果 → 下载文件
    // 注意：不要在导出失败后重新 create 任务——飞书服务端对同一文档的重复导出请求会拒绝。
    // 正确做法是 pollExportResult 内部持续轮询同一个 ticket，等待 file_token 出现。
    if (onProgress) onProgress('creating');
    var ticket = await createExportTask(objToken);

    if (onProgress) onProgress('polling');
    var poll = await pollExportResult(ticket, objToken, function(status, count) {
      if (onProgress) onProgress('polling', count);
    });

    if (onProgress) onProgress('downloading');
    var blob = await downloadExportedFile(poll.fileToken, poll.fileExtension, function(got, total, t0) {
      if (onProgress) onProgress('downloading', got, total, t0);
    });

    return { blob: blob, fileExtension: poll.fileExtension, fileName: poll.fileName };
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块3：文件保存（JSZip 解压 + 保存）
  // ══════════════════════════════════════════════════════════════════

  async function unzipAndSave(blob, opts, masterZip) {
    // opts: { title, mdPath, mdDir, attachName, attachBaseDir, docRel }
    var mdPath = opts.mdPath;
    var mdDir = opts.mdDir;
    var attachName = opts.attachName;
    var attachBaseDir = opts.attachBaseDir;
    var docRel = opts.docRel;

    L('unzipAndSave called, blob size:', fmtsz(blob.size), 'mdPath:', mdPath, 'attachBaseDir:', attachBaseDir);

    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip 未加载！请检查网络连接或 CDN 是否可访问');
    }

    var zip = await JSZip.loadAsync(blob);
    var mdContent = null;
    var images = {};

    // 遍历 zip 内容
    var files = Object.keys(zip.files);
    L('ZIP contents:', files);

    for (var i = 0; i < files.length; i++) {
      var fname = files[i];
      var fobj = zip.files[fname];
      if (fobj.dir) continue;

      var lower = fname.toLowerCase();
      if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        mdContent = await fobj.async('string');
      } else if (lower.match(/\.(png|jpg|jpeg|gif|svg|webp|bmp)$/)) {
        var imgData = await fobj.async('uint8array');
        var imgName = fname.substring(fname.lastIndexOf('/') + 1);
        images[imgName] = imgData;
      }
    }

    if (!mdContent) {
      // 没有 .md 文件，直接把原始 zip 放进去
      W('No .md found in zip, keeping original zip');
      masterZip.file(mdPath.replace(/\.md$/i, '') + '.zip', await blob.arrayBuffer());
      return;
    }

    // 修正图片引用路径（相对 md 所在目录）
    mdContent = mdContent.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function(match, alt, path) {
      var raw = path.split('?')[0];
      var imgName = raw.substring(raw.lastIndexOf('/') + 1);
      try { imgName = decodeURIComponent(imgName); } catch (e) {}
      if (images[imgName]) {
        var imgFullPath = [attachBaseDir, attachName, docRel, imgName].filter(Boolean).join('/');
        var ref = relPath(mdDir, imgFullPath);
        if (ref.indexOf('../') !== 0 && ref.indexOf('./') !== 0) ref = './' + ref;
        return '![' + alt + '](' + ref + ')';
      }
      return match;
    });

    // 写入 .md 到 masterZip
    masterZip.file(mdPath, mdContent);

    // 写入图片
    var imgNames = Object.keys(images);
    for (var j = 0; j < imgNames.length; j++) {
      var imgFullPath = [attachBaseDir, attachName, docRel, imgNames[j]].filter(Boolean).join('/');
      masterZip.file(imgFullPath, images[imgNames[j]]);
    }

    L('Collected:', mdPath, '+', imgNames.length, 'images');
    return { md: mdPath, imgCount: imgNames.length };
  }

  function saveText(content, filename) {
    var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    saveBlob(blob, filename);
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.cssText = 'display:none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 60000);
  }

  // ══════════════════════════════════════════════════════════════════
  //  模块4：UI
  // ══════════════════════════════════════════════════════════════════

  GM_addStyle(`
    .wb-toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.82); color:#fff; padding:10px 24px; border-radius:8px; font-size:14px; z-index:999999; font-family:sans-serif; pointer-events:none; transition:opacity .3s; }
    #wb-panel { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:600px; max-height:80vh; background:#fff; border:1px solid #e0e0e0; border-radius:12px; box-shadow:0 12px 48px rgba(0,0,0,.2); z-index:99999; display:flex; flex-direction:column; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; }
    #wb-panel .wb-hd { padding:14px 20px; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; font-weight:600; font-size:15px; display:flex; justify-content:space-between; align-items:center; }
    #wb-panel .wb-tree { flex:1; overflow-y:auto; padding:8px 0; max-height:50vh; }
    #wb-panel .wb-tree-node { display:flex; align-items:center; padding:5px 12px; cursor:pointer; user-select:none; }
    #wb-panel .wb-tree-node:hover { background:#f0f4ff; }
    #wb-panel .wb-tree-node.selected { background:#e8edff; }
    #wb-panel .wb-tree-check { margin-right:8px; width:16px; height:16px; accent-color:#667eea; }
    #wb-panel .wb-tree-expand { margin-right:4px; width:16px; text-align:center; font-size:10px; color:#999; }
    #wb-panel .wb-tree-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #wb-panel .wb-tree-type { margin-left:8px; font-size:11px; color:#999; flex-shrink:0; }
    #wb-panel .wb-prog { padding:8px 20px; border-top:1px solid #eee; max-height:150px; overflow-y:auto; font-size:12px; }
    #wb-panel .wb-prog-item { display:flex; align-items:center; padding:3px 0; gap:8px; }
    #wb-panel .wb-prog-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #wb-panel .wb-prog-status { flex-shrink:0; font-size:11px; }
    #wb-panel .wb-bar-wrap { padding:4px 20px 8px; }
    #wb-panel .wb-bar { width:100%; height:6px; background:#eee; border-radius:3px; overflow:hidden; }
    #wb-panel .wb-bar-fill { width:0%; height:100%; background:linear-gradient(90deg,#667eea,#764ba2); border-radius:3px; transition:width .3s; }
    #wb-panel .wb-act { padding:10px 20px 14px; display:flex; gap:10px; align-items:center; border-top:1px solid #eee; }
    #wb-panel .wb-btn { padding:8px 20px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600; }
    #wb-panel .wb-btn-primary { background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; }
    #wb-panel .wb-btn-primary:hover { opacity:0.9; }
    #wb-panel .wb-btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
    #wb-panel .wb-btn-cancel { border:1px solid #ddd; background:#fff; color:#666; }
    #wb-panel .wb-count { flex:1; font-size:12px; color:#888; }
    #wb-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.3); z-index:99998; }
    .wb-float { position:fixed; right:20px; bottom:20px; z-index:999999; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; padding:12px 18px; border-radius:20px; box-shadow:0 4px 16px rgba(0,0,0,.25); cursor:pointer; font-size:13px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; gap:8px; }
    #wb-panel .wb-hd-btn { background:rgba(255,255,255,0.2); color:#fff; border:1px solid rgba(255,255,255,0.45); border-radius:4px; padding:2px 10px; cursor:pointer; font-size:12px; }
    #wb-panel .wb-hd-btn:hover { background:rgba(255,255,255,0.32); }
    #wb-panel .wb-cfg { padding:8px 20px; border-bottom:1px solid #eee; display:flex; gap:12px; align-items:center; font-size:12px; color:#555; }
    #wb-panel .wb-cfg input { width:90px; padding:4px 8px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
    #wb-panel .wb-cfg select { padding:4px 6px; border:1px solid #ddd; border-radius:4px; font-size:12px; }
  `);

  function showToast(msg, dur) {
    var old = document.querySelector('.wb-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'wb-toast';
    el.textContent = msg;
    el.style.opacity = '1';
    document.body.appendChild(el);
    setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, dur || 3000);
  }

  function flattenTree(node, list) {
    list = list || [];
    if (node.nodeType === 'docx' || node.nodeType === 'root') {
      list.push(node);
    }
    for (var i = 0; i < node.children.length; i++) {
      flattenTree(node.children[i], list);
    }
    return list;
  }

  function countNodes(node) {
    var c = 1;
    for (var i = 0; i < node.children.length; i++) {
      c += countNodes(node.children[i]);
    }
    return c;
  }

  var panelOpen = false;
  var activePanel = null;       // 当前面板 DOM
  var activeOverlay = null;     // 当前遮罩 DOM
  var downloadRunning = false;  // 导出是否进行中
  var floatBox = null;          // 悬浮进度窗

  function showPanel(tree, spaceId) {
    if (panelOpen) return;
    panelOpen = true;

    // 选中状态
    var selected = new Set();
    var allNodes = flattenTree(tree);
    var nodeMap = {};
    var parentMap = {};
    var checkEls = {};
    (function indexTree(node, parent) {
      nodeMap[node.wikiToken] = node;
      if (parent) parentMap[node.wikiToken] = parent.wikiToken;
      for (var i = 0; i < node.children.length; i++) indexTree(node.children[i], node);
    })(tree, null);
    // 默认全选 docx 节点
    allNodes.forEach(function(n) { if (n.nodeType === 'docx') selected.add(n.wikiToken); });

    // 遮罩
    var overlay = document.createElement('div');
    overlay.id = 'wb-overlay';
    document.body.appendChild(overlay);

    // 面板
    var panel = document.createElement('div');
    panel.id = 'wb-panel';

    // 头部
    var hd = document.createElement('div');
    hd.className = 'wb-hd';
    hd.innerHTML = '<span>📁 Wiki 批量导出 Markdown</span><span style="display:flex;align-items:center;gap:8px;"><button class="wb-hd-btn" id="wb-sel-all">全选</button><button class="wb-hd-btn" id="wb-sel-none">全不选</button><span id="wb-close" style="cursor:pointer;font-size:18px;line-height:1;padding:0 4px;">×</span></span>';
    panel.appendChild(hd);

    // 附件目录配置区
    var cfgDiv = document.createElement('div');
    cfgDiv.className = 'wb-cfg';
    cfgDiv.innerHTML = '<span>附件目录名</span><input id="wb-attach-name" type="text" value="images">' +
      '<span>附件层级</span><select id="wb-attach-level">' +
      '<option value="0">同级</option>' +
      '<option value="1">上一级</option>' +
      '<option value="2">上上级</option>' +
      '</select>';
    panel.appendChild(cfgDiv);

    // 目录树
    var treeDiv = document.createElement('div');
    treeDiv.className = 'wb-tree';
    renderTree(treeDiv, tree, selected, 0);
    panel.appendChild(treeDiv);

    // 进度区域（初始隐藏）
    var progDiv = document.createElement('div');
    progDiv.className = 'wb-prog';
    progDiv.style.display = 'none';
    panel.appendChild(progDiv);

    // 进度条
    var barWrap = document.createElement('div');
    barWrap.className = 'wb-bar-wrap';
    barWrap.style.display = 'none';
    var bar = document.createElement('div');
    bar.className = 'wb-bar';
    var barFill = document.createElement('div');
    barFill.className = 'wb-bar-fill';
    bar.appendChild(barFill);
    barWrap.appendChild(bar);
    panel.appendChild(barWrap);

    // 操作按钮
    var act = document.createElement('div');
    act.className = 'wb-act';
    var countSpan = document.createElement('span');
    countSpan.className = 'wb-count';
    countSpan.id = 'wb-count';
    updateCount();
    var btnGo = document.createElement('button');
    btnGo.className = 'wb-btn wb-btn-primary';
    btnGo.textContent = '🚀 开始导出';
    var btnCancel = document.createElement('button');
    btnCancel.className = 'wb-btn wb-btn-cancel';
    btnCancel.textContent = '关闭';
    act.appendChild(countSpan);
    act.appendChild(btnCancel);
    act.appendChild(btnGo);
    panel.appendChild(act);

    document.body.appendChild(panel);

    // 保存引用，供关闭/悬浮恢复使用
    activePanel = panel;
    activeOverlay = overlay;

    function updateCount() {
      countSpan.textContent = '已选 ' + selected.size + ' 个文档';
    }

    function renderTree(container, node, selected, depth) {
      if (node.nodeType !== 'root' && node.nodeType !== 'docx') return;

      var row = document.createElement('div');
      row.className = 'wb-tree-node';

      var indent = document.createElement('span');
      indent.style.cssText = 'display:inline-block;width:' + (depth * 20) + 'px;flex-shrink:0;';
      row.appendChild(indent);

      if (node.children && node.children.length > 0) {
        var expand = document.createElement('span');
        expand.className = 'wb-tree-expand';
        var defaultExpand = (depth === 0);
        expand.textContent = defaultExpand ? '▼' : '▶';
        expand.dataset.expanded = defaultExpand ? 'true' : 'false';
        expand.style.cursor = 'pointer';
        row.appendChild(expand);
      } else {
        var spacer = document.createElement('span');
        spacer.className = 'wb-tree-expand';
        spacer.textContent = '·';
        row.appendChild(spacer);
      }

      if (node.nodeType === 'docx') {
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'wb-tree-check';
        check.checked = selected.has(node.wikiToken);
        checkEls[node.wikiToken] = check;
        check.addEventListener('change', function() {
          var checked = this.checked;
          // 勾选/取消父节点时递归同步所有后代
          setDescendants(node, checked);
          // 向上刷新祖先节点的半选态
          refreshAncestors(node);
          updateCount();
        });
        row.appendChild(check);
      }

      var title = document.createElement('span');
      title.className = 'wb-tree-title';
      title.textContent = node.title || node.wikiToken;
      row.appendChild(title);

      if (node.nodeType === 'docx') {
        var type = document.createElement('span');
        type.className = 'wb-tree-type';
        type.textContent = 'docx';
        row.appendChild(type);
      }

      container.appendChild(row);

      // 子节点容器
      if (node.children && node.children.length > 0) {
        var childDiv = document.createElement('div');
        childDiv.style.display = (depth === 0) ? 'block' : 'none';
        for (var i = 0; i < node.children.length; i++) {
          renderTree(childDiv, node.children[i], selected, depth + 1);
        }
        container.appendChild(childDiv);

        if (row.querySelector('.wb-tree-expand')) {
          row.querySelector('.wb-tree-expand').addEventListener('click', function(e) {
            e.stopPropagation();
            var expanded = this.dataset.expanded === 'true';
            this.dataset.expanded = expanded ? 'false' : 'true';
            this.textContent = expanded ? '▶' : '▼';
            childDiv.style.display = expanded ? 'none' : 'block';
          });
        }
      }
    }

    // ===== 三态复选框辅助 =====
    function collectDocxDescendants(node, list) {
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        if (child.nodeType === 'docx') list.push(child);
        collectDocxDescendants(child, list);
      }
    }

    // 递归设置节点及其所有后代的选中状态
    function setDescendants(node, checked) {
      if (node.nodeType === 'docx') {
        if (checked) selected.add(node.wikiToken);
        else selected.delete(node.wikiToken);
        if (checkEls[node.wikiToken]) {
          checkEls[node.wikiToken].checked = checked;
          checkEls[node.wikiToken].indeterminate = false;
        }
      }
      for (var i = 0; i < node.children.length; i++) {
        setDescendants(node.children[i], checked);
      }
    }

    // 刷新单个节点的勾选/半选状态（自身 + 后代）
    function refreshNodeState(node) {
      var el = checkEls[node.wikiToken];
      if (!el) return;
      var list = [];
      if (node.nodeType === 'docx') list.push(node);
      collectDocxDescendants(node, list);
      var checkedCount = 0;
      for (var i = 0; i < list.length; i++) {
        if (selected.has(list[i].wikiToken)) checkedCount++;
      }
      if (list.length === 0 || checkedCount === 0) {
        el.checked = false;
        el.indeterminate = false;
      } else if (checkedCount === list.length) {
        el.checked = true;
        el.indeterminate = false;
      } else {
        el.checked = false;
        el.indeterminate = true;
      }
    }

    // 向上刷新祖先节点的半选态
    function refreshAncestors(node) {
      var parentToken = parentMap[node.wikiToken];
      while (parentToken) {
        refreshNodeState(nodeMap[parentToken]);
        parentToken = parentMap[parentToken];
      }
    }

    // 全选 / 全不选
    function selectAll(checked) {
      for (var i = 0; i < allNodes.length; i++) {
        var n = allNodes[i];
        if (n.nodeType !== 'docx') continue;
        if (checked) selected.add(n.wikiToken);
        else selected.delete(n.wikiToken);
        var el = checkEls[n.wikiToken];
        if (el) { el.checked = checked; el.indeterminate = false; }
      }
      updateCount();
    }

    // 关闭
    function closePanel() {
      if (downloadRunning) {
        // 导出进行中：最小化为悬浮窗，不销毁
        panel.style.display = 'none';
        overlay.style.display = 'none';
        showFloatBox();
        return;
      }
      panel.remove();
      overlay.remove();
      panelOpen = false;
      activePanel = null;
      activeOverlay = null;
    }

    function showFloatBox() {
      if (floatBox) return;
      floatBox = document.createElement('div');
      floatBox.className = 'wb-float';
      floatBox.textContent = '📥 导出进行中，点击查看进度';
      floatBox.onclick = function() {
        if (floatBox) { floatBox.remove(); floatBox = null; }
        if (activePanel) activePanel.style.display = 'flex';
        if (activeOverlay) activeOverlay.style.display = 'block';
      };
      document.body.appendChild(floatBox);
    }

    document.getElementById('wb-close').onclick = closePanel;
    document.getElementById('wb-sel-all').onclick = function() { selectAll(true); };
    document.getElementById('wb-sel-none').onclick = function() { selectAll(false); };
    btnCancel.onclick = closePanel;
    overlay.onclick = closePanel;

    // 开始导出
    btnGo.onclick = async function() {
      var tokens = Array.from(selected);
      if (tokens.length === 0) {
        showToast('⚠ 请至少选择一个文档');
        return;
      }

      downloadRunning = true;
      btnGo.disabled = true;
      btnGo.textContent = '⏳ 导出中...';
      progDiv.style.display = 'block';
      barWrap.style.display = 'block';

      // 构建选中节点的信息映射
      var nodeMap = {};
      allNodes.forEach(function(n) { nodeMap[n.wikiToken] = n; });

      // 构建路径映射（叶子节点不建文件夹，.md 放父目录）
      var pathMap = {};
      function buildPaths(node, prefix) {
        var dir;
        if (node.children && node.children.length > 0) {
          dir = prefix ? prefix + '/' + safeName(node.title) : safeName(node.title);
        } else {
          dir = prefix || '';
        }
        pathMap[node.wikiToken] = dir;
        for (var i = 0; i < node.children.length; i++) {
          buildPaths(node.children[i], dir);
        }
      }
      buildPaths(tree, '');

      // 附件目录配置
      var attachName = (document.getElementById('wb-attach-name').value || '').trim() || 'images';
      var attachLevel = parseInt(document.getElementById('wb-attach-level').value, 10) || 0;

      if (typeof JSZip === 'undefined') {
        showToast('❌ JSZip 未加载，请检查网络后刷新重试');
        downloadRunning = false;
        btnGo.disabled = false;
        btnGo.textContent = '🚀 开始导出';
        return;
      }
      var masterZip = new JSZip();

      var total = tokens.length;
      var done = 0, success = 0, failed = 0;

      // 并发控制
      async function processOne(wikiToken) {
        var node = nodeMap[wikiToken];
        if (!node || !node.objToken) {
          failed++;
          return;
        }

        var name = node.title || wikiToken;
        var mdDir = pathMap[wikiToken] || '';
        var mdPath = (mdDir ? mdDir + '/' : '') + safeName(name) + '.md';
        var docPathNoExt = (mdDir ? mdDir + '/' : '') + safeName(name);
        var attachBaseDir = upDir(mdDir, attachLevel);
        var docRel = relPath(attachBaseDir, docPathNoExt);

        // 进度条目
        var item = document.createElement('div');
        item.className = 'wb-prog-item';
        item.innerHTML = '<span class="wb-prog-name" title="' + name + '">' + name + '</span><span class="wb-prog-status" style="color:#f90;">⏳</span>';
        progDiv.appendChild(item);
        progDiv.scrollTop = progDiv.scrollHeight;

        try {
          var result = await exportAndDownload(node.objToken, function(status) {
            if (status === 'creating') {
              item.querySelector('.wb-prog-status').textContent = '🔍 创建';
              item.querySelector('.wb-prog-status').style.color = '#f90';
            } else if (status === 'polling') {
              item.querySelector('.wb-prog-status').textContent = '⏳ 等待';
              item.querySelector('.wb-prog-status').style.color = '#f90';
            } else if (status === 'downloading') {
              item.querySelector('.wb-prog-status').textContent = '📥 下载';
              item.querySelector('.wb-prog-status').style.color = '#2196f3';
            }
          });

          // 纯 md 导出（无图片）直接写文本；zip 则解压收集
          if (result.fileExtension === 'md') {
            var mdText = await result.blob.text();
            masterZip.file(mdPath, mdText);
            L('Collected (pure md):', mdPath);
          } else {
            await unzipAndSave(result.blob, {
              title: name,
              mdPath: mdPath,
              mdDir: mdDir,
              attachName: attachName,
              attachBaseDir: attachBaseDir,
              docRel: docRel,
            }, masterZip);
          }

          item.querySelector('.wb-prog-status').textContent = '✅';
          item.querySelector('.wb-prog-status').style.color = '#4caf50';
          success++;
        } catch (e) {
          E('Export failed:', name, e);
          item.querySelector('.wb-prog-status').textContent = '❌';
          item.querySelector('.wb-prog-status').style.color = '#f44336';
          item.querySelector('.wb-prog-status').title = e.message || String(e);
          item.title = e.message || String(e);
          failed++;
        }

        done++;
        barFill.style.width = (done * 100 / total) + '%';
        countSpan.textContent = done + '/' + total + ' 完成';
      }

      // 带并发控制的任务队列
      var queue = tokens.slice();
      async function worker() {
        while (queue.length > 0) {
          var token = queue.shift();
          await processOne(token);
          if (queue.length > 0) await delay(CFG.REQUEST_DELAY);
        }
      }

      var workers = [];
      for (var w = 0; w < CFG.CONCURRENCY; w++) workers.push(worker());
      await Promise.all(workers);

      // 打包所有内容为一个 zip 并下载
      btnGo.textContent = '📦 打包中...';
      countSpan.textContent = '成功 ' + success + ' / 失败 ' + failed + '，正在打包...';

      var finalBlob = await masterZip.generateAsync({ type: 'blob' }, function(meta) {
        countSpan.textContent = '打包中 ' + Math.round(meta.percent) + '%';
      });

      var ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveBlob(finalBlob, '飞书Wiki导出_' + ts + '.zip');

      // 完成
      btnGo.textContent = '✅ 导出完成';
      btnGo.disabled = false;
      countSpan.textContent = '成功 ' + success + ' / 失败 ' + failed + ' / 共 ' + total;

      if (typeof GM_notification === 'function') {
        GM_notification({ text: 'Wiki 批量导出完成：' + success + '/' + total, timeout: 5000 });
      }
      downloadRunning = false;
      if (floatBox) { floatBox.remove(); floatBox = null; }
      // 若面板处于最小化状态，恢复显示以展示最终结果
      if (activePanel && activePanel.style.display === 'none') {
        activePanel.style.display = 'flex';
        if (activeOverlay) activeOverlay.style.display = 'block';
      }
      showToast('✅ 导出完成：' + success + '/' + total + ' 个文档', 5000);
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  入口：注入按钮
  // ══════════════════════════════════════════════════════════════════

  var btnInjected = false;

  function injectButton(retries) {
    if (retries === undefined) retries = 40;
    if (btnInjected || document.getElementById('wb-main-btn')) return;
    if (retries <= 0) { W('Button inject timeout'); return; }

    // 查找锚点：工具栏或头部区域
    var anchor = document.querySelector('[class*="wiki-setting"]')
      || document.querySelector('[class*="header"] button')
      || Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === '分享'; })
      || Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.includes('更多'); })
      || document.querySelector('[class*="toolbar"]')
      || document.querySelector('[class*="header"]');

    if (!anchor) {
      setTimeout(function() { injectButton(retries - 1); }, 1000);
      return;
    }

    var btn = document.createElement('button');
    btn.id = 'wb-main-btn';
    btn.textContent = '📥 批量导出';
    btn.title = '批量导出 Wiki 目录下所有文档为 Markdown（含图片）';
    Object.assign(btn.style, {
      background: 'linear-gradient(135deg,#667eea,#764ba2)',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      padding: '6px 16px',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
      margin: '0 8px',
      fontFamily: 'inherit',
      zIndex: '9999',
      transition: 'opacity .15s,transform .15s',
      whiteSpace: 'nowrap',
    });
    btn.addEventListener('mouseenter', function() { btn.style.opacity = '0.9'; btn.style.transform = 'scale(1.02)'; });
    btn.addEventListener('mouseleave', function() { btn.style.opacity = '1'; btn.style.transform = 'none'; });

    btn.onclick = async function() {
      btn.disabled = true;
      btn.textContent = '🔍 枚举目录...';
      showToast('⏳ 正在枚举 Wiki 目录树...', 60000);

      try {
        var spaceId = getSpaceId();
        var wikiToken = getCurrentWikiToken();

        if (!spaceId) {
          // 尝试从 API 响应中获取
          W('space_id not found in DOM, trying API...');
          showToast('⚠ 无法获取 space_id，请刷新页面重试', 5000);
          btn.disabled = false;
          btn.textContent = '📥 批量导出';
          return;
        }

        if (!wikiToken) {
          showToast('⚠ 无法识别当前 Wiki 页面', 5000);
          btn.disabled = false;
          btn.textContent = '📥 批量导出';
          return;
        }

        var tree = await buildWikiTree(spaceId, wikiToken, function(fetched, total) {
          btn.textContent = '🔍 枚举中 (' + fetched + ')...';
        });

        var nodeCount = countNodes(tree);
        L('Wiki tree built:', nodeCount, 'nodes');

        btn.disabled = false;
        btn.textContent = '📥 批量导出';
        showToast('📁 目录树加载完成：' + nodeCount + ' 个节点', 3000);

        showPanel(tree, spaceId);
      } catch (e) {
        E('Tree build failed:', e);
        showToast('❌ 目录枚举失败：' + e.message, 5000);
        btn.disabled = false;
        btn.textContent = '📥 批量导出';
      }
    };

    if (anchor.tagName === 'BUTTON') {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    } else {
      anchor.appendChild(btn);
    }

    btnInjected = true;
    L('Button injected');
  }

  // 注册油猴菜单
  try {
    GM_registerMenuCommand('📥 批量导出 Wiki', function() {
      if (!btnInjected) injectButton();
      var btn = document.getElementById('wb-main-btn');
      if (btn) btn.click();
    });
  } catch (_) {}

  // 延迟注入，等待页面加载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(injectButton, 3000); });
  } else {
    setTimeout(injectButton, 3000);
  }

  // SPA 路由变化时重新注入
  var lastUrl = location.href;
  new MutationObserver(function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      btnInjected = false;
      var oldBtn = document.getElementById('wb-main-btn');
      if (oldBtn) oldBtn.remove();
      setTimeout(injectButton, 3000);
    }
  }).observe(document, { subtree: true, childList: true });

})();
