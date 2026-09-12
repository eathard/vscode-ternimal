# 中继 webroot 同步（手机端前端部署）

## 教训（2026-09-12 事故：「手机经常连不上」）

中继以 `--webroot /opt/ternimal-relay/dist/web` 直接从磁盘服务手机前端。
`npm run build` 只更新本机 `dist/web/`——**不会**同步 VPS。旧版前端在手机端
表现为：瞬态关闭码（4003/4004/1000）被当作可重试 → 无限重连 → 5 次失败
锁死宿主共享 `__relay__` 鉴权窗口 → 正确凭据在锁定期同样被拒（间歇性失败）。

## 同步步骤（每次改动 web bundle 后）

```bash
# 本机构建
npm run build
# 上传（以 ubuntu 用户，保住 relay-config 所有权纪律）
scp -O dist/web/{web.js,style.css,index.html} ubuntu@<relay-host>:/tmp/
ssh ubuntu@<relay-host> 'cp /tmp/web.js /tmp/style.css /tmp/index.html /opt/ternimal-relay/dist/web/'
# 验证线上指纹 = 本地
curl -sk https://<relay-host>/static/web.js | md5sum
md5sum dist/web/web.js
```

静态文件无需重启服务。改 relay 服务端（src/*.mjs）才需要 systemctl restart。
