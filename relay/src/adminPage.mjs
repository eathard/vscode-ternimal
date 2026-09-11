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
  var lastTok = null; // 最近生成混合口令（内存态；同上）
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
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status >= 400) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function fmtBytes(n) {
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GiB';
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MiB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
    return n + ' B';
  }
  function fmtWhen(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }

  function fmtRem(ms) {
    if (ms === null) return '长期';
    if (ms <= 0) return '已过期';
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), d = Math.floor(h / 24);
    if (d >= 1) return d + '天' + (h % 24) + '时';
    if (h >= 1) return h + '时' + m + '分';
    return m + '分';
  }

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
        h += '<table><tr><th>子码</th><th>标签</th><th>状态</th><th>到期</th><th>剩余</th><th>joins</th><th>bytes</th><th></th></tr>';
        (c.subcodes || []).forEach(function (s) {
          var st = s.revoked ? '<span class="tag rev">已吊销</span>'
            : (s.expiresAt > Date.now() ? '<span class="tag ok">有效</span>' : '<span class="tag off">已过期</span>');
          var rem = s.revoked ? '—' : fmtRem(s.expiresAt === null ? null : s.expiresAt - Date.now());
          var due = s.expiresAt === null ? '长期' : fmtWhen(s.expiresAt);
          var rn = s.revoked ? '' :
            '<button data-sr1="' + esc(c.id) + '/' + esc(s.id) + '">+1天</button> ' +
            '<button data-sr7="' + esc(c.id) + '/' + esc(s.id) + '">+7天</button> ' +
            '<button data-sp="' + esc(c.id) + '/' + esc(s.id) + '">长期</button> ';
          h += '<tr><td><code>' + esc(String(s.code).slice(0, 14)) + '…</code></td><td>' + esc(s.label || '') +
            '</td><td>' + st + '</td><td>' + due + '</td><td>' + rem + '</td><td class="num">' + s.stats.joins +
            '</td><td class="num">' + fmtBytes(s.stats.bytes) + '</td>' +
            '<td>' + rn + (s.revoked
              ? '<button class="danger" data-del="' + esc(c.id) + '/' + esc(s.id) + '">删除</button>'
              : '<button class="danger" data-rev="' + esc(c.id) + '/' + esc(s.id) + '">吊销</button>') + '</td></tr>';
        });
        h += '</table>';
        h += '<details><summary>为此通道签发子码</summary><div class="row">' +
          '<input id="lbl-' + esc(c.id) + '" placeholder="标签（如 customer-a）" style="width:200px">' +
          '<select id="ttl-' + esc(c.id) + '"><option value="1">1 小时</option><option value="6" selected>6 小时</option><option value="24">24 小时</option><option value="168">7 天</option></select>' +
          '<button data-issue="' + esc(c.id) + '">签发</button></div></details>';
        h += '</div>';
      });

      // 混合接入口令数据源：对外地址 + CA 公钥（绑定后签发/生成自动嵌入）
      h += '<div class="card"><h3 style="margin:0 0 8px">接入配置（混合口令）</h3>' +
        '<div class="row"><input id="ac-url" placeholder="对外地址 https://IP或域名" style="width:240px" value="' + esc((d.access && d.access.publicUrl) || '') + '">' +
        (d.access && d.access.caBound ? '<span class="tag ok">CA 已绑定 ' + esc(d.access.caFingerprint || '') + '</span>' : '<span class="tag rev">CA 未绑定</span>') +
        '<button id="ac-save">保存</button></div>' +
        '<div class="row"><textarea id="ac-ca" placeholder="CA 公钥 PEM（自建部署=Caddy root.crt 内容；域名+公共CA 留空）" style="width:100%;height:52px;font-size:11px"></textarea></div>' +
        '<div class="muted">用户购买后把「混合口令」整条发给他——App 里粘贴即自动配置地址/主码/证书。QR 说明：口令供桌面端粘贴，微信文本即达，无需扫码。</div></div>';

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
          ' <button data-tok="' + esc(m.id) + '" title="粘贴该客户主码明文生成混合口令">口令</button>' +
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
          ' · 到期自动停止 · 续期在下方列表点 +30 天</div>' +
          (lastIss.token ? '<div class="row" style="margin-top:6px"><b style="color:#d7ba7d">混合口令（发这条即可，App 粘贴即配）</b><button id="tok-copy" class="primary">复制口令</button>' +
          '<button id="tok-dl">下载为txt</button></div>' +
            '<div class="row"><code id="tok-code" style="width:100%;font-size:10px;padding:6px;background:#111;border-radius:6px;word-break:break-all">' + esc(lastIss.token) + '</code></div>' +
            '<div class="muted">含 地址+主码+CA证书 · 敏感度同主码，仅发给买家本人 · 校验段防截断</div>' : '') +
          '</div>';
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
          if (j.code) lastIss = { code: j.code, label: j.label || '', expiresAt: j.expiresAt, token: j.token || null };
          render();
        });
      };
      var acSave = document.getElementById('ac-save');
      if (acSave) {
        acSave.onclick = function () {
          var pemEl = document.getElementById('ac-ca');
          var body = { publicUrl: (document.getElementById('ac-url') || {}).value || '' };
          if (pemEl && pemEl.value.trim()) body.caPem = pemEl.value.trim();
          api('PUT', '/api/admin/access', body).then(function () { render(); }, function (e) { alert('保存失败: ' + (e && e.message ? e.message : e)); });
        };
      }
      var tokCopy = document.getElementById('tok-copy');
      if (tokCopy) {
        tokCopy.onclick = function () {
          var txt = (document.getElementById('tok-code') || {}).textContent || '';
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(function () { tokCopy.textContent = '已复制 ✓'; setTimeout(function () { tokCopy.textContent = '复制口令'; }, 1600); });
          } else { fallbackCopy(txt); tokCopy.textContent = '已复制 ✓'; }
        };
      }
      var tokDl = document.getElementById('tok-dl');
      if (tokDl) {
        tokDl.onclick = function () {
          var tok = ((document.getElementById('tok-code') || {}).textContent || '').trim();
          if (!tok) return;
          var safeLabel = String(lastIss && lastIss.label ? lastIss.label : '').replace(/[^0-9A-Za-z_-]+/g, '').slice(0, 24);
          var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          var body = 'Ternimal 接入口令\\n' +
            '================\\n\\n' +
            '使用方法：打开 Ternimal → ⚙ 设置 → 顶部「混合口令一键配置」，\\n' +
            '把下面整行（tconf 开头到结尾，含最后的校验段）完整复制粘贴进去，\\n' +
            '点「解析预览」核对后「应用并连接」即完成。\\n\\n' +
            tok + '\\n\\n' +
            '· 本文件等同密码（含主码），请勿转发他人\\n' +
            '· 换电脑可重复使用同一条口令；有效期随套餐\\n';
          var a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
          a.download = 'ternimal-token-' + (safeLabel ? safeLabel + '-' : '') + stamp + '.txt';
          a.click();
          tokDl.textContent = '已下载 ✓';
          setTimeout(function () { tokDl.textContent = '下载为txt'; }, 1600);
        };
      }
      Array.prototype.forEach.call(app.querySelectorAll('[data-tok]'), function (b) {
        b.onclick = function () {
          var code = prompt('粘贴该客户的主码明文（trelay_v1_…）生成混合口令：');
          if (!code) return;
          api('POST', '/api/admin/token', { code: code.trim() }).then(function (j) {
            lastIss = lastIss || { code: '(已隐藏)', label: '口令生成', expiresAt: 0 };
            lastIss.token = j.token; lastIss.label = '口令生成';
            render();
          }, function (e) { alert('生成失败: ' + (e && e.message ? e.message : e)); });
        };
      });
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
      Array.prototype.forEach.call(app.querySelectorAll('[data-sr1]'), function (b) {
        var parts = b.getAttribute('data-sr1').split('/');
        b.onclick = function () { api('POST', '/api/channels/subcodes/' + encodeURIComponent(parts[1]) + '/renew', { days: 1 }).then(render); };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-sr7]'), function (b) {
        var parts = b.getAttribute('data-sr7').split('/');
        b.onclick = function () { api('POST', '/api/channels/subcodes/' + encodeURIComponent(parts[1]) + '/renew', { days: 7 }).then(render); };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-sp]'), function (b) {
        var parts = b.getAttribute('data-sp').split('/');
        b.onclick = function () {
          if (!confirm('设为长期可用？该子码将永不过期。')) return;
          api('POST', '/api/channels/subcodes/' + encodeURIComponent(parts[1]) + '/renew', { permanent: true }).then(render);
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
      Array.prototype.forEach.call(app.querySelectorAll('[data-del]'), function (b) {
        var parts = b.getAttribute('data-del').split('/');
        b.onclick = function () {
          if (!confirm('删除该子码记录？将从列表移除（不可恢复）。')) return;
          api('DELETE', '/api/channels/subcodes/' + encodeURIComponent(parts[1]) + '?purge=1&channel=' + encodeURIComponent(parts[0]))
            .then(render);
        };
      });
      Array.prototype.forEach.call(app.querySelectorAll('[data-issue]'), function (b) {
        b.onclick = function () {
          var cid = b.getAttribute('data-issue');
          api('POST', '/api/channels/subcodes', {
            channelId: cid,
            label: (document.getElementById('lbl-' + cid) || {}).value || '',
            ttlHours: Number((document.getElementById('ttl-' + cid) || {}).value || 6),
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
