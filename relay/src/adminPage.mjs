// adminPage.mjs — relay 管理页（/admin）。单文件内联 HTML+JS，无框架依赖。
// 面向后续计费运维：通道/子码用量总览、吊销、CSV 导出。
// 鉴权：管理密码（scrypt 落盘）→ 内存会话令牌（12h）；与主码体系独立。
import * as fs from 'node:fs';
// 构建号：本文件 mtime（脚本 URL 带版本参数破缓存；页脚可见，杜绝新旧分不清）
const BUILD = new Date(fs.statSync(new URL(import.meta.url)).mtime).toISOString().slice(0, 16).replace('T', ' ');

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self';">
<title>Ternimal Relay Admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #101418; color: #d7dde3; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #232a31; }
  header h1 { font-size: 16px; margin: 0; }
  header .sub { color: #7b8794; font-size: 12px; }
  main { padding: 20px; max-width: 1080px; margin: 0 auto; }
  .card { background: #161c22; border: 1px solid #232a31; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .kpis { display: flex; gap: 12px; flex-wrap: wrap; }
  .kpi { flex: 1 1 140px; background: #1b232b; border-radius: 6px; padding: 10px 12px; }
  .kpi b { display: block; font-size: 20px; color: #7ee2b8; }
  .kpi span { color: #7b8794; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #232a31; white-space: nowrap; }
  th { color: #7b8794; font-weight: 500; }
  td.num { font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; }
  .tag.ok { background: #123526; color: #7ee2b8; }
  .tag.off { background: #33231a; color: #e8a87c; }
  .tag.rev { background: #331a1a; color: #e87c7c; }
  button { background: #26303a; color: #d7dde3; border: 1px solid #38434e; border-radius: 5px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  button:hover { background: #2e3a46; }
  button.danger { border-color: #5c2a2a; color: #e87c7c; }
  input { background: #10151a; color: #d7dde3; border: 1px solid #38434e; border-radius: 5px; padding: 7px 10px; font-size: 14px; width: 100%; }
  .login { max-width: 340px; margin: 12vh auto; }
  .login h2 { font-size: 15px; margin: 0 0 12px; }
  .err { color: #e87c7c; font-size: 12px; min-height: 16px; }
  .muted { color: #7b8794; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  select { background: #10151a; color: #d7dde3; border: 1px solid #38434e; border-radius: 5px; padding: 5px 8px; }
  .bar { height: 4px; background: #1b232b; border-radius: 2px; overflow: hidden; margin-top: 8px; }
  .bar i { display: block; height: 100%; background: #7ee2b8; width: 0; transition: width .3s; }
  details summary { cursor: pointer; color: #9fb0bf; }
</style>
</head>
<body>
<div id="app">
  <div class="login card">
    <h2>Ternimal Relay 管理登录</h2>
    <div class="row"><input id="pw" type="password" placeholder="管理密码" autocomplete="current-password" style="flex:1">
      <label style="display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer"><input type="checkbox" id="pw-show">显示密码</label></div>
    <div class="err" id="err"></div>
    <div class="row"><button id="go">登录</button><span class="muted">密码经 scrypt 校验，会话 12 小时</span></div>
    <div class="muted" style="margin-top:10px">build ${BUILD}（旧于此刻请强刷 Ctrl+F5）</div>
  </div>
</div>
<script src="/static/admin.js?v=${BUILD}"></script>
</body>
</html>`;

export const ADMIN_JS = `// admin.js — 管理页逻辑：登录 → 总览轮询 → 吊销/签发/导出。
(function () {
  var VER = '${BUILD}';
  var TOK = sessionStorage.getItem('adminTok') || '';
  var app = document.getElementById('app');
  var lastIss = null; // 最近签发主码（内存态；隐藏/刷新即弃，不落任何存储）
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 已尽力 */ }
    document.body.removeChild(ta);
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        TOK ? { authorization: 'Bearer ' + TOK } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) { TOK = ''; sessionStorage.removeItem('adminTok'); throw new Error('unauthorized'); }
      return r.json().catch(function () { return {}; });
    });
  }

  function fmtBytes(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GiB';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MiB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
    return n + ' B';
  }
  function fmtWhen(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function login() {
    var pw = document.getElementById('pw').value;
    document.getElementById('err').textContent = '';
    fetch('/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (o) {
        if (o.s !== 200) { document.getElementById('err').textContent = o.j.error || '登录失败'; return; }
        TOK = o.j.token; sessionStorage.setItem('adminTok', TOK);
        render();
      })
      .catch(function () { document.getElementById('err').textContent = '网络错误'; });
  }

  var DATA = null;
  function render() {
    api('GET', '/api/admin/overview').then(function (d) {
      DATA = d;
      var chans = d.channels || [];
      var totalBytes = chans.reduce(function (a, c) { return a + (c.bytesIn + c.bytesOut); }, 0);
      var totalJoins = chans.reduce(function (a, c) { return a + c.joins; }, 0);
      var subs = chans.reduce(function (a, c) { return a + (c.subcodes || []).length; }, 0);

      var h = '<header><h1>Ternimal Relay 管理</h1><span class="sub">build ' + VER + ' · uptime ' + Math.floor(d.uptimeMs / 60000) +
        ' 分钟 · ' + (d.service || '') + '</span><button id="logout">退出</button></header><main>' +
        '<div class="card"><div class="kpis">' +
        '<div class="kpi"><b>' + chans.length + '</b><span>通道</span></div>' +
        '<div class="kpi"><b>' + subs + '</b><span>子码</span></div>' +
        '<div class="kpi"><b>' + totalJoins + '</b><span>累计接入</span></div>' +
        '<div class="kpi"><b>' + fmtBytes(totalBytes) + '</b><span>累计流量</span></div>' +
        '<div class="kpi"><b>' + d.pipes + '</b><span>活跃管道</span></div>' +
        '</div><div class="bar"><i style="width:' + Math.min(100, (d.pipes / Math.max(1, d.maxPipes)) * 100) + '%"></i></div>' +
        '<div class="muted">管道水位 ' + d.pipes + ' / ' + d.maxPipes + '（全服务合计）</div></div>';

      chans.forEach(function (c) {
        h += '<div class="card"><div class="row"><b>' + esc(c.id.slice(0, 12)) + '…</b>' +
          '<span class="tag ' + (c.online ? 'ok' : 'off') + '">' + (c.online ? '插件在线' : '离线') + '</span>' +
          '<span class="muted">首见 ' + fmtWhen(c.firstSeen) + ' · 流量 ' + fmtBytes(c.bytesIn + c.bytesOut) +
          ' (↑' + fmtBytes(c.bytesOut) + ' ↓' + fmtBytes(c.bytesIn) + ') · 接入 ' + c.joins + '</span></div>';
        h += '<table><tr><th>子码</th><th>标签</th><th>状态</th><th>到期</th><th>joins</th><th>bytes</th><th></th></tr>';
        (c.subcodes || []).forEach(function (s) {
          var st = s.revoked ? '<span class="tag rev">已吊销</span>'
            : (s.expiresAt > Date.now() ? '<span class="tag ok">有效</span>' : '<span class="tag off">已过期</span>');
          h += '<tr><td><code>' + esc(String(s.code).slice(0, 14)) + '…</code></td><td>' + esc(s.label || '') +
            '</td><td>' + st + '</td><td>' + fmtWhen(s.expiresAt) + '</td><td class="num">' + s.stats.joins +
            '</td><td class="num">' + fmtBytes(s.stats.bytes) + '</td>' +
            '<td>' + (s.revoked ? '' : '<button class="danger" data-rev="' + esc(c.id) + '/' + esc(s.id) + '">吊销</button>') + '</td></tr>';
        });
        h += '</table>';
        h += '<details><summary>为此通道签发子码</summary><div class="row">' +
          '<input id="lbl-' + esc(c.id) + '" placeholder="标签（如 customer-a）" style="width:200px">' +
          '<select id="ttl-' + esc(c.id) + '"><option value="1">1 小时</option><option value="24" selected>24 小时</option><option value="168">7 天</option></select>' +
          '<button data-issue="' + esc(c.id) + '">签发</button></div></details>';
        h += '</div>';
      });

      // 主码生命周期（计费核心）：手动签发（带有效期）/续期/吊销，到期 sweep 自停
      h += '<div class="card"><h3 style="margin:0 0 8px">主码（付费通道）</h3>' +
        '<table><tr><th>id</th><th>标签</th><th>状态</th><th>到期</th><th>剩余</th><th></th></tr>';
      (d.masters || []).forEach(function (m) {
        var st = m.permanent ? '<span class="tag off">永久</span>'
          : m.status === 'revoked' ? '<span class="tag rev">已吊销</span>'
          : m.status === 'expired' ? '<span class="tag rev">已过期</span>'
          : '<span class="tag ok">有效</span>';
        var rem = m.remainingMs == null ? '—'
          : Math.floor(m.remainingMs / 86400000) + '天' + Math.floor((m.remainingMs % 86400000) / 3600000) + '时';
        h += '<tr><td><code>' + esc(m.id) + '</code></td><td>' + esc(m.label) + '</td><td>' + st +
          '</td><td>' + (m.expiresAt ? fmtWhen(m.expiresAt) : '—') + '</td><td>' + rem + '</td>' +
          '<td>' + (m.permanent ? '' :
            '<button data-renew="' + esc(m.id) + '">+30天</button> ' +
            '<button data-renew7="' + esc(m.id) + '">+7天</button> ' +
            (m.status === 'revoked' ? '' : '<button class="danger" data-mrev="' + esc(m.id) + '">吊销</button>')) +
          '</td></tr>';
      });
      h += '</table><div class="row">' +
        '<input id="m-label" placeholder="客户标签（如 customer-a）" style="width:180px">' +
        '<select id="m-days"><option value="1">1 天</option><option value="7">7 天</option>' +
        '<option value="30" selected>30 天</option><option value="90">90 天</option><option value="365">365 天</option></select>' +
        '<button id="m-issue">签发主码</button>' +
        '<span class="muted">明文仅签发时显示一次；到期自动停止、续期即恢复</span></div></div>';

      // 最近签发面板：明文仅签发时生成，留在内存直到隐藏/刷新（复制按钮）
      if (lastIss) {
        h += '<div class="card" id="last-iss" style="border:1px solid #2f6fdb">' +
          '<div class="row"><b>最近签发主码（' + esc(lastIss.label) + '）</b>' +
          '<span class="tag ok">仅此一次显示</span></div>' +
          '<div class="row"><code id="iss-code" style="font-size:15px;padding:6px 10px;background:#111;border-radius:6px">' +
          esc(lastIss.code) + '</code>' +
          '<button id="iss-copy" class="primary">复制主码</button>' +
          '<button id="iss-hide">我已保存，隐藏</button></div>' +
          '<div class="muted">有效期至 ' + new Date(lastIss.expiresAt).toLocaleString() +
          ' · 到期自动停止 · 续期在下方列表点 +30 天</div></div>';
      }

      h += '<div class="card"><div class="row"><button id="csv">导出用量 CSV</button>' +
        '<span class="muted">通道/子码粒度：joins、bytes——计费对账底稿</span></div></div></main>';
      app.innerHTML = h;

      document.getElementById('logout').onclick = function () { TOK = ''; sessionStorage.removeItem('adminTok'); location.reload(); };
      document.getElementById('csv').onclick = exportCsv;
      document.getElementById('m-issue').onclick = function () {
        api('POST', '/api/admin/masters', {
          label: (document.getElementById('m-label') || {}).value || '',
          days: Number((document.getElementById('m-days') || {}).value || 30),
        }).then(function (j) {
          if (j.code) lastIss = { code: j.code, label: j.label || '', expiresAt: j.expiresAt };
          render();
        });
      };
      var cpBtn = document.getElementById('iss-copy');
      if (cpBtn) {
        cpBtn.onclick = function () {
          var txt = (document.getElementById('iss-code') || {}).textContent || '';
          var done = function () {
            cpBtn.textContent = '已复制 ✓';
            setTimeout(function () { cpBtn.textContent = '复制主码'; }, 1600);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done(); });
          } else { fallbackCopy(txt); done(); }
        };
        document.getElementById('iss-hide').onclick = function () { lastIss = null; render(); };
      }

      Array.prototype.forEach.call(app.querySelectorAll('[data-renew]'), function (b) {
        b.onclick = function () { api('POST', '/api/admin/masters/' + b.getAttribute('data-renew') + '/renew', { days: 30 }).then(render); };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-renew7]'), function (b) {
        b.onclick = function () { api('POST', '/api/admin/masters/' + b.getAttribute('data-renew7') + '/renew', { days: 7 }).then(render); };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-mrev]'), function (b) {
        b.onclick = function () {
          if (!confirm('吊销该主码？其通道（含全部管道）将立即停止。')) return;
          api('DELETE', '/api/admin/masters/' + b.getAttribute('data-mrev')).then(render);
        };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-rev]'), function (b) {
        b.onclick = function () {
          var parts = b.getAttribute('data-rev').split('/');
          if (!confirm('吊销该子码？其管道将立即断开。')) return;
          api('DELETE', '/api/channels/subcodes/' + encodeURIComponent(parts[1]) + '?channel=' + encodeURIComponent(parts[0]))
            .then(render);
        };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-issue]'), function (b) {
        b.onclick = function () {
          var cid = b.getAttribute('data-issue');
          api('POST', '/api/channels/subcodes', {
            channelId: cid,
            label: (document.getElementById('lbl-' + cid) || {}).value || '',
            ttlHours: Number((document.getElementById('ttl-' + cid) || {}).value || 24),
          }).then(function (j) {
            if (j.subCode) alert('已签发：' + j.subCode + '\\n（复制保存，关闭后不再完整显示）');
            render();
          });
        };
      });
    }).catch(function () { location.reload(); });
  }

  function exportCsv() {
    var rows = [['channel', 'label', 'subcode', 'revoked', 'expiresAt', 'joins', 'bytes']];
    (DATA.channels || []).forEach(function (c) {
      (c.subcodes || []).forEach(function (s) {
        rows.push([c.id, s.label || '', s.code, s.revoked, new Date(s.expiresAt).toISOString(), s.stats.joins, s.stats.bytes]);
      });
      if (!(c.subcodes || []).length) rows.push([c.id, '(no subcodes)', '', '', '', c.joins, c.bytesIn + c.bytesOut]);
    });
    var csv = rows.map(function (r) { return r.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(','); }).join('\\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'relay-usage-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }

  document.getElementById('go').onclick = login;
  document.getElementById('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
  document.getElementById('pw-show').addEventListener('change', function (e) {
    document.getElementById('pw').type = e.target.checked ? 'text' : 'password';
  });
  if (TOK) render();
})();
`;
