# Ternimal Relay — 中继服务器部署指南

> 设计文档：`docs/relay-design.md` · 行动计划：`docs/relay-plan.md`（D-R5）

纯字节管道中继：内网 Ternimal 主机（插件）出站注册通道，外网浏览器出示
子码接入，relay 将两端 WebSocket 逐字节对接——不解析内层协议。

## 快速开始（部署到公网 VPS）

```bash
# 1. Node ≥18 + 依赖（单依赖 ws）
cd relay && npm install        # 或直接复用主仓库 node_modules

# 2. 签发主码（明文仅显示一次！立即保存到密码管理器）
node cli.mjs add-master
# → trelay_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 3. 启动（默认 127.0.0.1:8080 明文，交给 Caddy 前置）
node cli.mjs serve --webroot ../dist/web   # 可选：托管 web 客户端静态资源
```

生产建议用 systemd 常驻：

```ini
# /etc/systemd/system/ternimal-relay.service
[Service]
WorkingDirectory=/opt/ternimal-relay
ExecStart=/usr/bin/node cli.mjs serve --webroot /opt/ternimal-relay/web
Restart=always
DynamicUser=yes
```

## TLS 形态（方案书 §3.7）

| 形态 | 配置 | 适用 |
|------|------|------|
| **Caddy 前置（推荐）** | `Caddyfile` 反代 127.0.0.1:8080 | 有域名，自动 Let's Encrypt |
| 内置 TLS | config: `"tls": {"cert": "…pem", "key": "…pem"}` | 无反代、自签/已有证书 |
| `--insecure` | 显式 flag，仅限 0.0.0.0 明文 | 临时验证 |

启用反代后设置 `trustedProxy: true`，relay 才会采信 `X-Forwarded-For`
做限流（仅信任 loopback 来源的代理头）。

## 配置文件（relay/relay-config.json，勿提交）

> **模板：`relay-config.json.example`** —— 含全部字段与中文说明，复制即用：
> `cp relay-config.json.example relay-config.json`（凭据字段由 CLI 生成，勿手写）

`add-master` 自动生成/维护；字段见 `src/config.mjs` 默认值：监听地址/端口、
TLS 路径、trustedProxy、webRoot 与全部阈值（子码 TTL、并发管道上限、
背压上限、限速窗口等，方案书 §3.5 默认参数表）。

## 端点一览

| 端点 | 方向 | 用途 |
|------|------|------|
| `WSS /control` | host 出站 | register（主码）→ registered / client-offer |
| `WSS /join` | 客户端 | join（子码）→ 挂起 → 管道对接后透传 |
| `WSS /pipe` | host 出站 | pipe（主码+clientId）→ 与客户端对接 |
| `POST/GET /api/channels/subcodes` | host 应用 | 子码签发/列表（Bearer 主码） |
| `DELETE /api/channels/subcodes/:id` | host 应用 | 吊销（立即断其管道） |
| `GET /health` | 运维 | 存活与通道计数 |
| `GET /`、`/static/*` | 浏览器 | web 客户端托管（可选） |

## 安全备忘

- 主码配置只存 SHA-256 哈希；泄露应急 = `add-master` 换码 + 删除旧哈希
  （旧通道与全部管道立即失效）；
- 子码短 TTL + 可吊销；子码泄露只需吊销，不影响主码；
- relay 见不到 Ternimal Token 的校验（端到端发生在内网主机）；
  E2E 加密（挑战应答 + AES-GCM）在 R-M4 落地，公开服务前必须启用。
