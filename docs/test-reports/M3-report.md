# M3 安全里程碑 — 测试报告

> 日期：本轮执行 | 执行人：实施者（AI agent）
> 依据：`docs/verification-standard.md` §3.3 | 计划书 WBS-M3-A～E

## 1. 结论

**M3 全部 5 项 WBS 完成；自动化验证全绿**（安全单元 14/14、协议+TLS 套件
18/18、M1 回归 13/13、真实应用 HTTPS 端到端 8/8）。M2 遗留的两个
SKIPPED(M3) 用例已补齐为真实用例并通过。手机端证书信任（TC-M3-01
后半）待需求方执行；托盘重置密码的 UI 入口（TC-M3-08）按计划随 M4 交付，
其核心逻辑（rotate→旧会话全灭）已在本轮单元测试覆盖。

## 2. 交付内容

| 任务 | 文件 | 状态 |
|------|------|------|
| WBS-M3-A 自签证书 | `src/main/certManager.ts`（selfsigned 5.5、RSA-2048、SHA-256 签名、365 天、SAN= localhost/127.0.0.1/::1/全部内网 IPv4、私钥 0600、指纹冒号十六进制展示于登录页） | ✅ |
| WBS-M3-B 登录+会话 | `src/main/authManager.ts`（scrypt N=16384 存储、`scrypt$salt$hash` 格式、cookie `HttpOnly; Secure; SameSite=Strict; Path=/`、256-bit token、7 天滑动过期、重启即全灭）；登录页内联于 `remoteServer.ts`（零外部资源，展示证书指纹） | ✅ |
| WBS-M3-C WS 认证 | upgrade 前校验 cookie，未认证 → HTTP 401 拒绝 | ✅ |
| WBS-M3-D 限速 | 每 IP 5 次失败/分钟 → 锁 1 分钟（429 + Retry-After）；成功登录重置窗口；窗口语义（滑动计数）有单元覆盖 | ✅ |
| WBS-M3-E HTTPS | `https.createServer` 全站；明文 HTTP 打到 TLS 端口得不到任何页面内容（TC-M3-06 断言“refused”） | ✅ |
| 配置存储 | `src/main/configStore.ts`（M4 完整 schema 的最小切片提前落地：port/host/passwordHash/certPath/replayBufferBytes/maxSessions，原子写） | ✅ |
| 接线 | `main.ts`：config → 密码（env `TERNIMAL_PASSWORD` 覆盖 > 存储哈希 > 首启随机并打印）→ 证书 → RemoteServer | ✅ |
| D8 脚本 | `scripts/verify-ratelimit.mjs`（14 用例）+ `verify-ws-protocol.mjs` 全面 TLS/认证化（18 用例）；`npm run verify:m3` | ✅ |

## 3. 自动化验证结果

```
$ npm run verify:m1        （回归）      ringbuffer 6/6 · registry 7/7
$ npm run verify:m3
auth+cert+config: 14/14 passed
  （scrypt 格式/防篡改、密码字符集、cookie 全属性、会话生命周期+滑动续期、
    限速锁定/解锁/窗口滑动/成功重置/分 IP、密码轮换灭旧会话、
    X.509 CN/SAN/私钥 0600、指纹跨重启稳定、配置默认值/原子写）
ws-protocol: 18/18 passed
  （TC-M3-06 明文拒绝 · 登录页指纹渲染 · TC-M3-02/03 密码+cookie ·
    页面 302 门禁 · TC-M3-04 未认证 WS 401/伪造 token 401 ·
    TC-M3-05 五次锁+对密码也 429+解锁 · TLS 上全协议回归 · 会话数上限 ·
    静态资源认证门禁+穿越防护）

$ node scripts/smoke-e2e.mjs   （真实 Electron + 真 bash + 真 TLS）
  PASS  /health=200 over TLS
  PASS  unauthenticated WS handshake refused with 401 (TC-M3-04)
  PASS  password login over HTTPS issues hardened cookie (TC-M3-02/03)
  PASS  authenticated ws connect
  PASS  created real session (pid 真实)
  PASS  input→PTY→bash→output roundtrip over WSS
  PASS  second client got ring-buffer replay
  PASS  session closed cleanly
```

## 4. 与方案书的偏差

1. **ConfigStore 最小切片提前至 M3**（原计划 M4）：密码哈希需要落盘，
   顺带固化 port/host/maxSessions。M4 补全 schema 与设置界面。
2. **错误密码返回 303 → /login?e=1**（Post/Redirect/Get，浏览器友好），
   而非 401 页面；429 保留 Retry-Header。语义等价、测试可辨。
3. **登录页内联在 remoteServer.ts**：零外部资源、单文件自洽，指纹注入
   简单；M4 若需美化可迁出到 web 构建产物（行为不变）。
4. **恢复通道**：密码仅首启明文打印一次（只存哈希，无法找回）。
   忘记密码用 `TERNIMAL_PASSWORD=新密码 npm run dev` 覆盖启动；
   M4 托盘提供菜单化重置。
5. selfsigned 5.5.0 的 API 与方案书假设略有出入（`days`→`notAfterDate`、
   IP 型 SAN 用 `ip` 字段、**默认签名算法是 sha1 必须显式指定 sha256**），
   已按真实类型实现并有 X.509 断言防回归。

## 5. 安全边界（现状声明）

- 自签证书：浏览器首次访问需手动信任（或核对登录页指纹）——方案书既定取舍。
- 会话内存态：重启即全部失效（防拖库长期冒用，方案书 §2.5 既定）。
- 限速内存态：重启清零（核心版本接受）。
- HTTP 明文在 8443 端口无任何回退服务。

## 6. 待需求方执行的手动用例

- [ ] TC-M3-01 手机/第二台电脑访问 `https://<主机IP>:8443`，浏览器警告页
      核对指纹 → 信任 → 登录页显示相同指纹
- [ ] 手机浏览器完整跑一遍 TC-M2-01～05（M2 遗留，此刻起在 HTTPS 下执行）

## 7. 缺陷清单

无未修复 P0/P1。P2：登录页为英文极简风（M4 美化）；证书指纹仅在登录页
展示（M4 托盘同步展示）。
