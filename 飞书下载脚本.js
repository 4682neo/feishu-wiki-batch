// ==UserScript==
// @name         飞书文档/文件全能下载
// @namespace    https://7998888.xyz
// @version      1.0
// @description  合二为一：飞书 wiki/doc 导出 Word/PDF/Markdown + 飞书/讯飞文件/文件夹流式下载 PDF
// @author       代可行
// @match        https://*.feishu.cn/wiki/*
// @match        https://*.feishu.cn/doc/*
// @match        https://*.feishu.cn/file/*
// @match        https://*.feishu.cn/drive/folder/*
// @match        https://*.feishu.com/file/*
// @match        https://*.feishu.com/drive/folder/*
// @match        https://*.larksuite.com/file/*
// @match        https://*.larksuite.com/drive/folder/*
// @match        https://*.xfchat.iflytek.com/file/*
// @match        https://*.xfchat.iflytek.com/drive/folder/*
// @icon         https://www.feishu.cn/favicon.ico
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      internal-api-drive-stream.xfchat.iflytek.com
// @connect      internal-api-drive-stream.feishu.cn
// @connect      internal-api-drive-stream.feishu.com
// @connect      internal-api-drive-stream.larksuite.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

// ══════════════════════════════════════════════════════════════════
// 第一部分：wiki/doc 页面 — DOM 提取导出 Word/PDF/Markdown
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const isWikiPage = () => location.pathname.match(/^\/(wiki|doc)\//);
  const isFilePage = () => location.pathname.match(/^\/(file|drive\/folder)\//);

  if (!isWikiPage() && !isFilePage()) return;

  // ─── 公用 CSS ─────────────────────────────────────────────────
  GM_addStyle(`
    .fp-toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.82); color:#fff; padding:10px 24px; border-radius:8px; font-size:14px; z-index:999999; font-family:sans-serif; pointer-events:none; transition:opacity .3s; }
  `);

  function showToast(msg, dur) {
    var old = document.querySelector('.fp-toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'fp-toast';
    el.textContent = msg;
    el.style.opacity = '1';
    document.body.appendChild(el);
    setTimeout(function() { el.style.opacity = '0'; setTimeout(function() { el.remove(); }, 300); }, dur || 2500);
  }

  // ══════════════════════════════════════════════════════════════
  // █ 模块 A：wiki/doc → 导出 Word/PDF/Markdown
  // ══════════════════════════════════════════════════════════════
  (function moduleWiki() {
    if (!isWikiPage()) return;

    GM_addStyle(`
      #__fsdl_btn { position:fixed; right:20px; bottom:100px; z-index:99999; font-family:-apple-system,"Helvetica Neue",sans-serif; }
      #__fsdl_btn .fsdl-main { background:#3370ff; color:#fff; border:none; border-radius:8px; padding:10px 20px; font-size:14px; font-weight:600; cursor:pointer; box-shadow:0 4px 14px rgba(51,112,255,0.45); transition:all .2s; white-space:nowrap; }
      #__fsdl_btn .fsdl-main:hover { background:#2560e0; transform:translateY(-1px); }
      #__fsdl_btn .fsdl-menu { display:none; position:absolute; bottom:calc(100% + 8px); right:0; background:#fff; border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,0.15); min-width:200px; overflow:hidden; border:1px solid #eee; padding:6px 0; }
      #__fsdl_btn .fsdl-item { padding:10px 18px; cursor:pointer; font-size:13px; color:#333; display:flex; align-items:center; gap:10px; transition:background .15s; white-space:nowrap; }
      #__fsdl_btn .fsdl-item:hover { background:#f0f4ff; }
    `);

    function waitContent(maxWait) {
      return new Promise(function(resolve) {
        var check = function() {
          if (getContentBlocks().length > 0) { resolve(); return; }
          setTimeout(check, 500);
        };
        check();
        setTimeout(resolve, maxWait || 10000);
      });
    }

    function getTitle() {
      var cat = document.querySelector('[class*="catalogue"] [class*="list-item"]');
      if (cat && cat.textContent.trim().length < 100) return cat.textContent.trim();
      var h = document.querySelector('.page-block-content h1, [class*="docTitle"], h1');
      if (h && h.textContent.trim()) return h.textContent.trim();
      return document.title.replace(/ - 飞书云?文档/, '').trim() || '飞书文档';
    }
    function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '_'); }

    function getMeta() {
      var t = document.querySelector('[class*="metaTime"]');
      var a = document.querySelector('.doc-info-wrapper [class*="author"], .doc-info-wrapper [class*="owner"]') || document.querySelector('[class*="owner"], [class*="author"]');
      return { author: a ? a.textContent.trim() : '', time: t ? t.textContent.trim() : '' };
    }

    function getContentBlocks() {
      var blocks = [];
      var wrapper = document.querySelector('.render-unit-wrapper') || document.querySelector('#docx .editor-container .root-render-unit-container, #docx .page-block-children');
      if (!wrapper) return [];

      for (var i = 0; i < wrapper.children.length; i++) {
        var child = wrapper.children[i];
        var cls = child.className || '';
        if (cls.indexOf('render-unit') !== -1 || cls.indexOf('zone-container') !== -1) {
          var innerBlocks = child.querySelectorAll(':scope > .block, :scope > [class*="block"]');
          if (innerBlocks.length > 0) {
            for (var j = 0; j < innerBlocks.length; j++) {
              var b = innerBlocks[j];
              if ((b.className||'').indexOf('table') !== -1) {
                var table = b.querySelector('table');
                if (table) blocks.push({ type:'table', el: table });
              } else {
                var txt = collectText(b);
                if (txt) blocks.push({ type:'p', text: txt });
              }
            }
            continue;
          }
        }
        if (cls.indexOf('docx-table-block') !== -1 || cls.indexOf('table') !== -1) {
          var tbl = child.querySelector('table');
          if (tbl) blocks.push({ type:'table', el: tbl });
        } else {
          var txt = collectText(child);
          if (txt && txt.length > 2) blocks.push({ type:'p', text: txt });
        }
      }

      if (blocks.length === 0) {
        document.querySelectorAll('.editor-container .ace-line, .editor-container .block > span, .editor-container [class*="block"]').forEach(function(el) {
          var txt = el.textContent.trim();
          if (txt && txt.length > 2) blocks.push({ type:'p', text: txt });
        });
      }
      return blocks;
    }

    function collectText(el) {
      var textParts = [];
      function walk(node) {
        if (node.nodeType === 3) { var t = node.textContent.trim(); if (t) textParts.push(t); }
        else if (node.nodeType === 1 && node.tagName !== 'TABLE' && node.tagName !== 'IFRAME') {
          for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
        }
      }
      walk(el);
      return textParts.join('');
    }

    function extractTable(tableEl) {
      var rows = [];
      var trs = tableEl.querySelectorAll('tr');
      if (trs.length) {
        for (var i = 0; i < trs.length; i++) {
          var cells = [];
          trs[i].querySelectorAll('td, th').forEach(function(td) { cells.push(td.textContent.trim()); });
          rows.push(cells);
        }
      } else {
        tableEl.querySelectorAll('[class*="row"],[class*="tr"]').forEach(function(r) {
          var cells = [];
          r.querySelectorAll('[class*="cell"],[class*="td"]').forEach(function(c) { cells.push(c.textContent.trim()); });
          if (cells.length) rows.push(cells);
        });
      }
      return rows;
    }

    function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function buildHTML() {
      var title = getTitle(), meta = getMeta(), blocks = getContentBlocks(), body = '';
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b.type === 'p' && b.text) body += '<p>' + esc(b.text) + '</p>\n';
        else if (b.type === 'table') {
          var rows = extractTable(b.el);
          if (rows.length) {
            body += '<table>\n';
            for (var ri = 0; ri < rows.length; ri++) {
              body += '  <tr>\n';
              for (var ci = 0; ci < rows[ri].length; ci++) {
                var tag = (ri === 0 && rows.length > 1) ? 'th' : 'td';
                body += '    <' + tag + '>' + esc(rows[ri][ci]) + '</' + tag + '>\n';
              }
              body += '  </tr>\n';
            }
            body += '</table>\n';
          }
        }
      }
      return '<!DOCTYPE html>\n<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">\n<head>\n<meta charset="utf-8">\n<meta name="ProgId" content="Word.Document">\n<title>' + esc(title) + '</title>\n<!--[if gte mso 9]>\n<xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml>\n<![endif]-->\n<style>\n'
        + '  @page { size: 21cm 29.7cm; margin: 3.7cm 2.8cm 3.5cm 2.8cm; mso-page-orientation: portrait; }\n'
        + '  body { font-family: 仿宋_GB2312, 仿宋, FangSong, serif; font-size: 16pt; line-height: 28pt; color: #222; }\n'
        + '  h1 { font-family: 黑体, SimHei, sans-serif; font-size: 22pt; text-align: center; font-weight: bold; margin: 20pt 0 12pt; line-height: 36pt; }\n'
        + '  h2 { font-family: 楷体_GB2312, 楷体, KaiTi, serif; font-size: 16pt; font-weight: bold; margin: 10pt 0 4pt; }\n'
        + '  p { text-indent: 32pt; margin: 0; line-height: 28pt; }\n'
        + '  .meta-right { text-align: right; color: #333; font-size: 16pt; margin: 6pt 0; text-indent: 0; line-height: 28pt; }\n'
        + '  table { border-collapse: collapse; margin: 8pt auto; width: 100%; }\n'
        + '  td, th { border: 1px solid #000; padding: 4pt 8pt; text-align: center; font-size: 14pt; line-height: 24pt; }\n'
        + '  th { font-weight: bold; }\n'
        + '</style>\n</head>\n<body>\n'
        + '  <h1>' + esc(title) + '</h1>\n'
        + (meta.author ? '  <div class="meta-right">' + esc(meta.author) + '</div>\n' : '')
        + (meta.time ? '  <div class="meta-right" style="color:#999;font-size:9pt">' + esc(meta.time) + '</div>\n' : '')
        + body + '</body>\n</html>';
    }

    function buildMarkdown() {
      var title = getTitle(), meta = getMeta(), blocks = getContentBlocks();
      var md = '# ' + title + '\n\n';
      if (meta.author) md += '> 作者：' + meta.author + '\n';
      if (meta.time) md += '> ' + meta.time + '\n\n';
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b.type === 'p' && b.text) md += b.text + '\n\n';
        else if (b.type === 'table') {
          var rows = extractTable(b.el);
          if (rows.length) {
            rows.forEach(function(row, ri) {
              md += '| ' + row.join(' | ') + ' |\n';
              if (ri === 0) {
                var sep = '|';
                for (var ci = 0; ci < row.length; ci++) sep += ' --- |';
                md += sep + '\n';
              }
            });
            md += '\n';
          }
        }
      }
      return md;
    }

    function gmDownload(content, name, mime) {
      var dataUri = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(content);
      GM_download({
        url: dataUri, name: name, saveAs: true,
        onload: function() { showToast('✅ 已下载：' + name); },
        onerror: function() {
          try {
            var blob = new Blob([content], { type: mime + ';charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a'); a.href = url; a.download = name;
            a.style.cssText = 'display:none'; document.body.appendChild(a); a.click();
            setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
            showToast('✅ 已下载：' + name);
          } catch(e2) { showToast('❌ 下载失败：' + e2.message); }
        }
      });
    }

    function downloadWord() {
      showToast('⏳ 正在生成 Word 文档...', 60000);
      try { gmDownload(buildHTML(), safeName(getTitle()) + '.doc', 'application/msword'); }
      catch (e) { showToast('❌ ' + e.message); }
    }
    function previewPdf() {
      showToast('🖨️ 打开打印预览...', 3000);
      try {
        var html = buildHTML().replace('</body>', '<div style="text-align:center;color:#999;font-size:9pt;margin-top:36pt;text-indent:0">— ' + getTitle() + ' —</div></body>');
        var win = window.open('', '_blank');
        if (win) { win.document.write(html); win.document.close(); }
        else showToast('⚠️ 弹窗被拦截，请允许弹窗');
      } catch (e) { showToast('❌ ' + e.message); }
    }
    function downloadMd() { gmDownload(buildMarkdown(), safeName(getTitle()) + '.md', 'text/markdown'); }
    function copyMd() {
      var md = buildMarkdown();
      try { GM_setClipboard(md); showToast('✅ 已复制到剪贴板'); }
      catch(_) { navigator.clipboard.writeText(md).then(function(){showToast('✅ 已复制到剪贴板');}).catch(function(){showToast('❌ 复制失败');}); }
    }

    // 面板按钮（wiki/doc）
    var wikiBtnAdded = false;
    function addWikiButton() {
      if (wikiBtnAdded) return;
      wikiBtnAdded = true;
      var wrap = document.createElement('div');
      wrap.id = '__fsdl_btn';
      var main = document.createElement('button');
      main.className = 'fsdl-main';
      main.textContent = '⬇ 导出';
      var menu = document.createElement('div');
      menu.className = 'fsdl-menu';
      function mi(icon, text, fn, sep) {
        var el = document.createElement('div');
        el.className = 'fsdl-item';
        el.innerHTML = '<span>' + icon + '</span> <span>' + text + '</span>';
        if (sep) el.style.borderTop = '1px solid #eee';
        el.onclick = function(e) { e.stopPropagation(); menu.style.display = 'none'; fn(); };
        menu.appendChild(el);
      }
      mi('📄', 'Word (.doc)', downloadWord);
      mi('📕', 'PDF（打印预览）', previewPdf);
      mi('📝', 'Markdown (.md)', downloadMd, true);
      mi('📋', '复制 Markdown', copyMd);
      main.onclick = function(e) { e.stopPropagation(); menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; };
      document.addEventListener('click', function(){menu.style.display='none';}, true);
      wrap.appendChild(menu); wrap.appendChild(main);
      document.body.appendChild(wrap);
    }

    try {
      GM_registerMenuCommand('📄 下载 Word (.doc)', downloadWord);
      GM_registerMenuCommand('📕 下载 PDF（打印预览）', previewPdf);
      GM_registerMenuCommand('📝 下载 Markdown', downloadMd);
      GM_registerMenuCommand('📋 复制 Markdown', copyMd);
    } catch (_) {}

    waitContent(8000).then(addWikiButton);

    var lastUrl = location.href;
    new MutationObserver(function() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        wikiBtnAdded = false;
        setTimeout(function(){waitContent(8000).then(addWikiButton);}, 1500);
      }
    }).observe(document, {subtree:true, childList:true});
  })();


  // ══════════════════════════════════════════════════════════════
  // █ 模块 B：文件/文件夹 → API 流式下载 PDF
  // ══════════════════════════════════════════════════════════════
  (function moduleFile() {
    if (!isFilePage()) return;

    const C = {
      CHUNK_SIZE: 4 * 1024 * 1024,
      PARALLEL: 3,
      DIRECT_LIMIT: 10 * 1024 * 1024,
      PREVIEW_TYPE: '9',
      MOUNT_POINT: 'explorer',
      LABEL: {
        idle: '📥 下载 PDF',
        folderIdle: '📥 批量下载 PDF',
        probing: '🔍 探测中...',
        done: '✅ 完成',
        error: '❌ 失败',
      },
    };

    const L = (...a) => console.log('[FP]', ...a);
    const W = (...a) => console.warn('[FP]', ...a);
    const E = (...a) => console.error('[FP]', ...a);

    const isFolder = () => location.pathname.startsWith('/drive/folder/');
    const isSingleFile = () => location.pathname.startsWith('/file/');

    function getFileToken() {
      var m = location.pathname.match(/\/file\/([\w.-]+)/);
      return m ? m[1] : null;
    }

    function getFilename() {
      var og = document.querySelector('meta[property="og:title"]');
      if (og) return og.getAttribute('content').trim();
      var t = document.querySelector('title');
      if (t) return t.textContent.replace(/\s*[-–—]\s*(飞书|i讯飞|Lark).*$/, '').trim() || getFileToken();
      return getFileToken() || 'download';
    }

    function apiHost() {
      var h = location.hostname;
      if (h.includes('xfchat.iflytek.com')) return 'internal-api-drive-stream.xfchat.iflytek.com';
      if (h.includes('feishu.cn')) return 'internal-api-drive-stream.feishu.cn';
      if (h.includes('feishu.com')) return 'internal-api-drive-stream.feishu.com';
      if (h.includes('larksuite.com')) return 'internal-api-drive-stream.larksuite.com';
      return h.replace(/^[^.]+/, 'internal-api-drive-stream');
    }

    function previewUrl(token) {
      var p = new URLSearchParams({ preview_type: C.PREVIEW_TYPE, mount_point: C.MOUNT_POINT });
      return 'https://' + apiHost() + '/space/api/box/stream/download/preview/' + token + '?' + p;
    }

    function reqHeaders(extra) {
      return Object.assign({ 'Referer': location.origin + '/', 'x-command': 'stream.download.preview' }, extra || {});
    }

    function fmtsz(b) {
      if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
      if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
      if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
      return b + ' B';
    }

    function save(blob, name) {
      var u = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(u); }, 60000);
    }

    function extractFilename(linkEl) {
      var children = linkEl.children;
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c.tagName === 'IMG' || c.tagName === 'BUTTON') continue;
        var t = c.textContent.trim();
        if (t.toLowerCase().includes('.pdf') && t.length < 120) return t;
      }
      var raw = linkEl.textContent.trim();
      raw = raw.replace(/[⠿⋮…]+$/, '').trim();
      raw = raw.replace(/\d{4}年\d{1,2}月\d{1,2}日.*$/, '').trim();
      raw = raw.replace(/\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}.*$/, '').trim();
      raw = raw.replace(/[\u4e00-\u9fa5]{2,6}\s+\w+\d*\s*$/, '').trim();
      return raw || linkEl.textContent.trim().split(/\d{4}年/)[0].trim();
    }

    function scanFolderPDFs() {
      var links = document.querySelectorAll('a[href*="/file/"]');
      var files = [], seen = new Set();
      links.forEach(function(a) {
        var m = a.href.match(/\/file\/([\w.-]+)/);
        if (!m || seen.has(m[1])) return;
        seen.add(m[1]);
        var name = extractFilename(a);
        if (!name || name.length < 2) return;
        if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
        files.push({ name: name, token: m[1] });
      });
      L('Scanned ' + files.length + ' PDFs');
      return files;
    }

    async function streamDirect(onProg, url, total) {
      var r = await fetch(url, { headers: reqHeaders(), credentials: 'include' });
      if (!r.ok) return r.status === 403 ? null : Promise.reject(new Error('HTTP ' + r.status));
      var ct = r.headers.get('content-type') || '';
      if (!ct.includes('pdf') && !ct.includes('octet-stream')) return null;
      var sz = parseInt(r.headers.get('content-length') || '0', 10);
      if (sz < 100) return null;
      var reader = r.body.getReader();
      var parts = [], got = 0, t0 = Date.now();
      while (true) {
        var res = await reader.read();
        if (res.done) break;
        parts.push(res.value); got += res.value.length;
        if (onProg) onProg({ received: got, total: sz, startTime: t0 });
      }
      return new Blob(parts, { type: 'application/pdf' });
    }

    async function streamChunked(onProg, url, total) {
      var cs = C.CHUNK_SIZE, n = Math.ceil(total / cs);
      var chunks = new Array(n), failed = false, got = 0, t0 = Date.now();
      var jobs = [];
      for (var i = 0; i < n; i++) jobs.push({ i: i, s: i * cs, e: Math.min((i + 1) * cs - 1, total - 1) });
      async function wk() {
        while (jobs.length && !failed) {
          var job = jobs.shift();
          var r = await fetch(url, { headers: reqHeaders({ Range: 'bytes=' + job.s + '-' + job.e }), credentials: 'include' });
          if (!r.ok && r.status !== 206) { failed = true; throw new Error('Chunk ' + job.i + ' ' + r.status); }
          var buf = await r.arrayBuffer();
          chunks[job.i] = new Uint8Array(buf);
          got += buf.byteLength;
          if (onProg) onProg({ received: got, total: total, startTime: t0 });
        }
      }
      var ws = [];
      for (var p = 0; p < C.PARALLEL; p++) ws.push(wk());
      await Promise.all(ws);
      if (failed) throw new Error('Chunk failed');
      var merged = new Uint8Array(total), off = 0;
      for (var c = 0; c < chunks.length; c++) {
        if (!chunks[c]) throw new Error('gap at chunk ' + c);
        merged.set(chunks[c], off); off += chunks[c].length;
      }
      return new Blob([merged], { type: 'application/pdf' });
    }

    async function dlOne(onProg, token) {
      var url = previewUrl(token);
      var probe = await fetch(url, { headers: reqHeaders({ Range: 'bytes=0-0' }), credentials: 'include' });
      var total = 0;
      if (probe.status === 200) total = parseInt(probe.headers.get('content-length') || '0', 10);
      else if (probe.status === 206) {
        var m = (probe.headers.get('Content-Range') || '').match(/\/(\d+)/);
        total = m ? parseInt(m[1], 10) : 0;
      }
      if (total < 100) {
        var d = await fetch(url, { headers: reqHeaders(), credentials: 'include' });
        total = parseInt(d.headers.get('content-length') || '0', 10);
      }
      if (total < 100) throw new Error('无法获取文件大小');
      L('DL ' + fmtsz(total));
      var blob;
      if (total <= C.DIRECT_LIMIT) blob = await streamDirect(onProg, url, total);
      if (!blob) blob = await streamChunked(onProg, url, total);
      if (!blob || blob.size < 100) throw new Error('文件为空');
      return blob;
    }

    async function downloadSingle(btn) {
      var token = getFileToken();
      if (!token) { alert('❌ 无法识别文件链接'); return; }
      btn.disabled = true; btn.textContent = C.LABEL.probing;
      try {
        var blob = await dlOne(function(p) { btn.textContent = '⏳ ' + Math.round(p.received * 100 / p.total) + '%'; }, token);
        var n = getFilename();
        save(blob, n.endsWith('.pdf') ? n : n + '.pdf');
        btn.textContent = C.LABEL.done;
        L('Done: ' + n + ' (' + fmtsz(blob.size) + ')');
      } catch (e) {
        E(e); btn.textContent = C.LABEL.error;
        alert('❌ 下载失败\n' + e.message + '\n\n提示：刷新页面后重试。');
      } finally {
        setTimeout(function() { btn.textContent = C.LABEL.idle; btn.disabled = false; }, 3000);
      }
    }

    function showPanel(files) {
      var old = document.getElementById('fp-panel'); if (old) old.remove();
      var p = document.createElement('div');
      p.id = 'fp-panel';
      Object.assign(p.style, {
        position: 'fixed', bottom: '20px', right: '20px', width: '400px', maxHeight: '520px',
        background: '#fff', border: '1px solid #e0e0e0', borderRadius: '10px',
        boxShadow: '0 8px 32px rgba(0,0,0,.18)', zIndex: '99999',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', fontSize: '13px',
      });
      var hd = document.createElement('div');
      Object.assign(hd.style, {
        padding: '12px 16px', background: 'linear-gradient(135deg,#667eea,#764ba2)',
        color: '#fff', fontWeight: '600', fontSize: '14px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      });
      hd.innerHTML = '<span>📁 文件夹下载</span><span style="display:flex;gap:8px;align-items:center;"><span id="fp-cnt" style="font-size:12px;opacity:.9">' + files.length + ' 个 PDF</span><button id="fp-close" style="background:none;border:none;color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;">×</button></span>';
      p.appendChild(hd);
      var lst = document.createElement('div');
      Object.assign(lst.style, { flex: '1', overflowY: 'auto', padding: '4px 0', maxHeight: '300px' });
      files.forEach(function(f, i) {
        var r = document.createElement('div');
        Object.assign(r.style, { display: 'flex', alignItems: 'center', padding: '6px 16px', borderBottom: '1px solid #f0f0f0', fontSize: '12px' });
        r.id = 'fp-r-' + i;
        r.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;" title="' + f.name + '">' + f.name + '</span><span id="fp-s-' + i + '" style="color:#aaa;flex-shrink:0;">等待</span>';
        lst.appendChild(r);
      });
      p.appendChild(lst);
      var bw = document.createElement('div');
      Object.assign(bw.style, { padding: '4px 16px 8px' });
      var b = document.createElement('div');
      Object.assign(b.style, { width: '100%', height: '4px', background: '#eee', borderRadius: '2px', overflow: 'hidden' });
      var bf = document.createElement('div');
      bf.id = 'fp-bar';
      Object.assign(bf.style, { width: '0%', height: '100%', background: 'linear-gradient(90deg,#667eea,#764ba2)', borderRadius: '2px', transition: 'width .3s' });
      b.appendChild(bf); bw.appendChild(b); p.appendChild(bw);
      var act = document.createElement('div');
      Object.assign(act.style, { padding: '8px 16px 12px', display: 'flex', gap: '8px' });
      var btnGo = document.createElement('button');
      btnGo.textContent = '🚀 全部下载';
      Object.assign(btnGo.style, { flex: '1', padding: '8px', border: 'none', borderRadius: '6px', background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '600' });
      var btnHide = document.createElement('button');
      btnHide.textContent = '关闭';
      Object.assign(btnHide.style, { padding: '8px 12px', border: '1px solid #ddd', borderRadius: '6px', background: '#fff', color: '#666', cursor: 'pointer', fontSize: '13px' });
      act.appendChild(btnGo); act.appendChild(btnHide); p.appendChild(act);
      document.body.appendChild(p);
      document.getElementById('fp-close').onclick = function() { p.remove(); };
      btnHide.onclick = function() { p.remove(); };

      btnGo.onclick = async function() {
        btnGo.disabled = true; btnGo.textContent = '⏳ 下载中...';
        var total = files.length, done = 0;
        for (var i = 0; i < total; i++) {
          var f = files[i];
          var sEl = document.getElementById('fp-s-' + i);
          var barEl = document.getElementById('fp-bar');
          var cntEl = document.getElementById('fp-cnt');
          sEl.textContent = '🔍'; sEl.style.color = '#f90';
          try {
            var blob = await dlOne(function(p) { sEl.textContent = Math.round(p.received * 100 / p.total) + '%'; }, f.token);
            save(blob, f.name.endsWith('.pdf') ? f.name : f.name + '.pdf');
            sEl.textContent = '✅'; sEl.style.color = '#4caf50';
          } catch (e) {
            sEl.textContent = '❌'; sEl.style.color = '#f44336';
            E('Failed: ' + f.name, e);
          }
          done++;
          barEl.style.width = (done * 100 / total) + '%';
          cntEl.textContent = done + '/' + total;
          if (done < total) await new Promise(function(r) { setTimeout(r, 1500); });
        }
        btnGo.textContent = '✅ 完成';
        cntEl.textContent = done + '/' + total + ' 完成';
        if (typeof GM_notification === 'function') {
          GM_notification({ text: '文件夹下载完成：' + done + '/' + total + ' 个 PDF', timeout: 5000 });
        }
      };
    }

    function mkBtn(label, title) {
      var b = document.createElement('button');
      b.id = 'fp-btn';
      b.textContent = label; b.title = title;
      Object.assign(b.style, {
        background: 'linear-gradient(135deg,#667eea,#764ba2)', color: '#fff',
        border: 'none', borderRadius: '6px', padding: '6px 16px', fontSize: '14px',
        cursor: 'pointer', margin: '0 8px', fontFamily: 'inherit', zIndex: '9999',
        transition: 'opacity .15s,transform .15s', minWidth: '130px', whiteSpace: 'nowrap',
      });
      b.addEventListener('mouseenter', function() { b.style.opacity = '0.9'; b.style.transform = 'scale(1.02)'; });
      b.addEventListener('mouseleave', function() { b.style.opacity = '1'; b.style.transform = 'none'; });
      return b;
    }

    function inject(retries) {
      if (retries === undefined) retries = 40;
      if (document.getElementById('fp-btn')) return;
      if (retries <= 0) { W('Inject timeout'); return; }
      var anchor = null;
      if (isFolder()) {
        anchor = document.querySelector('[class*="header"] button')
          || Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === '上传'; })
          || Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === '新建'; })
          || document.querySelector('[class*="toolbar"]')
          || document.querySelector('[class*="header"]');
      } else {
        anchor = Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === '下载'; })
          || Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.includes('分享'); })
          || document.querySelector('[class*="toolbar"]')
          || document.querySelector('[class*="header"]');
      }
      if (anchor) {
        var btn = mkBtn(isFolder() ? C.LABEL.folderIdle : C.LABEL.idle, isFolder() ? '批量下载文件夹内所有 PDF' : '下载完整 PDF（支持大文件）');
        if (isFolder()) {
          btn.onclick = function() {
            var files = scanFolderPDFs();
            if (files.length === 0) { alert('⚠ 未在此文件夹中发现 PDF 文件\n\n请确认文件夹中包含 .pdf 文件。'); return; }
            showPanel(files);
          };
        } else {
          btn.onclick = function() { downloadSingle(btn); };
        }
        if (anchor.tagName === 'BUTTON') {
          anchor.parentNode.insertBefore(btn, anchor.nextSibling);
        } else {
          anchor.appendChild(btn);
        }
        L('Button injected', isFolder() ? '(folder)' : '(file)');
      } else {
        setTimeout(function() { inject(retries - 1); }, 800);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { setTimeout(inject, 2000); });
    } else {
      setTimeout(inject, 2000);
    }
  })();
})();
