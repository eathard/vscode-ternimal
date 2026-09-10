# 公网中继部署报告（TC-R3-04 / checklist §6 部署项）

- 日期：本轮部署（实施者：agent）
- VPS：`146.56.214.137`（Ubuntu 24.04.4，4 vCPU / 3.7GB，华为云）
- 形态：checklist §1「Caddy 前置」标准形态

## 拓扑与常驻服务

```
浏览器/客户端 ──wss:443──▶ Caddy(internal CA) ──▶ relay 127.0.0.1:8080
                                                  ▲
Ternimal 主机（插件出站 wss）──────────────────────┘
```

| 服务 | 单元 | 说明 |
|------|------|------|
| `ternimal-relay.service` | systemd（enable+active） | `node /opt/ternimal-relay/relay/cli.mjs serve --webroot /opt/ternimal-relay/dist/web`，Restart=on-failure，NoNewPrivileges/ProtectSystem=full |
| `caddy.service` | systemd（active） | `:443 tls internal` + `default_sni <IP>`（IP 直连无 SNI 的握手坑）→ `reverse_proxy 127.0.0.1:8080` |
| 静态 web bundle | `/opt/ternimal-relay/dist/web` | 与 app 同一构建产物（双宿主 `/health` 区分） |

**主码（Ternimal 设置面板填入用，明文仅此记录；两枚均有效）**：
`<凭据已脱敏——两枚主码见服务器侧运营记录>`

## 公网端到端验证（`scripts/public-relay-probe.mjs`，真互联网）

| 步骤 | 结果 |
|------|------|
| 插件控制通道注册（本机 → VPS wss） | ✔ |
| 管理 API 签发子码（https） | ✔ 往返 191~308ms |
| 挑战应答 + **E2EE 协商**（公网链路） | ✔ 挑战往返 41~45ms |
| 密文业务往返（input→echo，AES-256-GCM） | ✔ 41~61ms |
| TLS 校验路径 | ✔ `NODE_EXTRA_CA_CERTS=<Caddy根>` 免豁免通过（另验证过 `rejectUnauthorized:false` 路径） |
| **真 Electron 应用注册** | ✔ 生产主进程 + utilityProcess 插件经 env 直连 VPS：`relay: registered (channel lDsL80…)`，无任何 TLS 豁免 |
| 服务健康 | ✔ `systemctl is-active` 双 active；`/health` {ok:true, service:'trelay'} |

## 与 checklist 的对应

- §1.1/1.2/1.5 → **已部署**（差异：暂无域名，用 Caddy 内部证书 + IP；公开
  正式服务前换域名 + Let's Encrypt）；
- §1.3/1.4 → ✔（webRoot 已托管；trustedProxy 未开——无反代链路采信需求）；
- §6.3（TC-R3-04 核心链路）→ **自动化部分完成**；剩余：手机蜂窝网络真浏览器
  打开 `https://146.56.214.137/#S=<子码>&T=<Token>` 的人工确认。

## 已知事项 / 后续

1. **内部 CA 信任**：手机浏览器打开会提示证书不受信（继续访问即可，安全
   上下文成立，挑战应答可用）；本机 Node/Electron 客户端需
   `NODE_EXTRA_CA_CERTS=<caddy-root.crt>`（已装入本机系统信任库，Node 需
   环境变量显式启用）。生产解法 = 域名 + Let's Encrypt，一并消除两类提示。
2. 健康检查曾见 `channels:1, controls:0`（探针异常退出遗留的通道壳）——
   join 得到 HOST_OFFLINE(4003) 瞬态语义、客户端退避重连，无功能影响；
   可在 v1.1 里把无控制通道的通道壳在 sweep 中一并清零。
3. relay 全部限速/配额为默认值（IP 5 次/分锁 1 分、通道 4 管道、背压 1MB）。

## 验收轮更新（binary 帧修复后）

- relay 重部署（`{ binary: isBinary }` 修复）+ 原/新主码均有效；
- **真 Chrome 公网验收 PASS**（`scripts/public-browser-check.mjs`）：零配置
  链接 → E2EE → 终端挂载 1845ms → 键入抵达 PTY；
- 抓包断言 PASS（`scripts/relay-capture-check.mjs`，本机 --insecure + tcpdump）：
  Token 明文 0 次、业务明文 0 次、secure 密文信封可见。

## 管理页（计费运维）

- 入口：`https://146.56.214.137/admin`
- 管理密码：`<凭据已脱敏——另行安全保存；轮换：cli.mjs set-admin>`
  （轮换：VPS 上 `node cli.mjs set-admin <新密码>` → `systemctl restart ternimal-relay`）
- 能力：通道/子码用量总览（进程级总账，通道清理不丢账）、签发/吊销子码、CSV 导出。
- 验证：verify-relay-admin 5/5 + 公网实测（页面 200 / 登录 / overview 返回通道在线）。

## 主码生命周期（收费时效）已上线

- 管理页 `/admin` 新增「主码（付费通道）」区块：签发（1/7/30/90/365 天，明文
  仅显示一次）、+7/+30 续期、吊销（立即生效）、到期自动停止（sweep ≤1 心跳周期）。
- CLI 同能力：`add-master --days N --label X`、`list-masters`、`renew-master
  <id> --days N`、`revoke-master <id>`。
- 存量两枚旧主码自动视为永久（零迁移）；管理 API 变更原子落盘。
- 验证：verify-relay-admin **10/10**（A×5 + B×5）+ VPS 实测签发→续期→吊销链路。

## 真浏览器验收（Chrome/CDP，2026-09-10）

- 新脚本 `scripts/admin-browser-check.mjs`（`npm run verify:admin-browser`）：无头
  Chrome 直连公网 /admin，全链路断言——登录 → 版本号 → 签发（内联面板明文，
  **不得弹 alert**）→ 复制按钮 `clipboard.writeText(主码全文)` 精确断言 +
  「已复制 ✓」反馈 → 主码列表出现（有效）→ 吊销（confirm 自动接受）→ 已吊销。
- 该测试当场抓获一处静默替换失败（alert 处理器未真正换成面板版，静态断言全绿
  但功能死路）——已修复并在 verify-relay-admin B-01 加硬断言（处理器必须走
  lastIss、前 400 字符不得出现 alert）。
- 截图存证：`docs/test-reports/shots/admin-browser.png`（1280×757）。
