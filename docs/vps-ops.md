# VPS 生产运维手册（ternimal-relay）

> 实例：`146.56.214.137`（ubuntu 用户，sudo -n 可用）。中继 systemd 单元 `ternimal-relay`，
> 以 **User=ubuntu** 运行，监听 `127.0.0.1:8080` 明文，前置 Caddy TLS 443（`tls internal` 自建 CA）。
> 面向运维者：部署、发码、绑定、故障、安全收口。

## 1. 部署与重启

```bash
# 本地打包（仅 .mjs 源码，零依赖无 node_modules）
tar czf /tmp/relay-deploy.tgz relay/src/*.mjs relay/cli.mjs
scp /tmp/relay-deploy.tgz ubuntu@146.56.214.137:/tmp/
ssh ubuntu@146.56.214.137 "tar xzf /tmp/relay-deploy.tgz -C /opt/ternimal-relay && sudo -n systemctl restart ternimal-relay"
curl http://127.0.0.1:8080/health   # {"ok":true,...}
```

- 重启会清空内存态：子码、通道。客户端 30s 内自动重连重注册；**用户需重新生成托盘分享链接**。
- 配置文件：`/opt/ternimal-relay/relay/relay-config.json`（属主必须 `ubuntu:ubuntu`，模式 600）。

## 2. ⚠️ 头号雷：不要对生产配置跑 sudo CLI

`saveConfig` 按当前用户重写配置文件。`sudo node cli.mjs bind-access/add-master/set-admin`
会把文件写成 `root:root 600`，服务用户 ubuntu 读不了 → **loadConfig 静默吞 EACCES 回退默认值**：
管理员消失（「admin not configured」）、主码全丢、绑定丢失——中继还在跑，极难察觉。

- 正确姿势：以 ubuntu 用户跑 CLI，或一律用**管理页**操作（进程内写盘，属主不变）。
- 中招修复：`sudo chown ubuntu:ubuntu /opt/ternimal-relay/relay/relay-config.json && sudo -n systemctl restart ternimal-relay`。

## 3. 管理页（首选操作入口）

`https://146.56.214.137/admin`（浏览器会警告自签证书，继续访问）。

| 操作 | 位置 |
|---|---|
| 一次性绑定对外地址 + CA 公钥（混合口令数据源） | 「接入配置」卡 |
| 签发主码（自动附混合口令） / 续期 / 吊销 | 「主码」卡 |
| 为既有主码补铸口令 | 主码行「口令」按钮 → 粘主码明文 |
| 通道在线状态、子码代签 | 总览区 |
| 用量对账 CSV | 「导出用量 CSV」 |

管理密码以 scrypt 哈希存于配置 `adminHash`；修改用 `node cli.mjs set-admin`（ubuntu 用户）。

## 4. 混合口令（tconf_v1）发货速查

```
绑定一次：管理页「接入配置」← https://146.56.214.137 + Caddy root.crt 内容
发 货：「签发主码」→ 复制面板出现的 tconf_v1_… → 微信发给买家
买 家：App ⚙ 设置 → 顶部粘贴 → 解析预览 → 应用并连接（全自动，含 CA 落盘）
```

口令 = 地址+主码+CA 压缩编码，可重复使用，生命周期随主码（吊销/到期即失效）。

## 5. 健康检查

```bash
systemctl status ternimal-relay          # 活跃性
curl -s http://127.0.0.1:8080/health     # {"ok":true,"channels":N,"controls":N}
journalctl -u ternimal-relay -n 50       # 注册/发码/接管日志
sudo -n cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt | openssl x509 -noout -fingerprint   # CA 指纹 56:14:1F:94:CC:D2:…
```

## 6. 安全收口（待办清单）

- [ ] 轮换管理密码（当前密码在历史沟通中出现过，商用前必换）
- [ ] ufw 只放行 22/80/443
- [ ] 域名 + Let's Encrypt（退役自签 CA 与客户端 caPath）
- [ ] ssh 密钥登录、禁密码

## 7. 已知边界

- 用量/子码/通道为内存态：重启清空（持久化在 v1.1 backlog）。
- 主码哈希与配置才落盘；CLI `conf-token` 可离线铸口令（需 ubuntu 属主的配置 + 已绑定）。
- 自签证书链：Caddy `tls internal` 的根证书指纹需与口令内嵌 CA 一致（管理页「CA 已绑定」标签可核对）。
