# Release v1.2.0 — 一贴即配（tconf_v1 混合口令）

**代码**: tag `v1.2.0`（21588f1） · **验证**: verify 伞 82 项全绿（relay 55 + m1/m3/m4/softkeys）+ instances 5/5 + smoke-e2e ALL PASS
**双端实测**: Linux deb 与 Windows NSIS 均完成打包安装 + CDP 真机全旅程

## 新增

- **混合口令一键配置（tconf_v1）** —— 面向国内「裸 IP + 自签 CA」常态：
  - 管理页一次性绑定对外地址 + CA 公钥；签发主码即自动附带混合口令（地址+主码+CA 压缩编码，~1KB，微信可传，尾部校验和防截断）
  - App ⚙ 面板顶部粘贴框：粘贴 → 解析预览（掩码主码/证书指纹）→ 应用并连接；CA 自动落盘 userData/certs，用户全程不接触证书文件
  - 既有主码可在管理页行内「口令」按钮补铸；手动三件套入口保留（自建/域名用户）
  - B-09 6/6（往返/防篡改/绑定持久化/未知主码 404/签发即口令/管理鉴权）
- **管理页「下载为txt」** —— 口令可下载为带使用说明的 txt 文件（口令独占一行），微信发文件不怕长文本被流打断
- **文档** —— README 中英亮点补全中继特性；docs/relay-help.md 买家 FAQ + 卖家发货动线；docs/vps-ops.md 生产运维手册（含 sudo 属主雷修复）

## 修复与改进

- 混合口令应用即自动回填全部字段并连接（原需手动保存）
- VPS 运维：`sudo` CLI 重写配置属主导致服务静默回退默认值的故障已修复并文档化

## 已知边界

- 口令敏感度≈主码（base64 非加密），仅经购买渠道传输
- 中继用量/子码为内存态，重启清空（v1.1 backlog 持久化）

## 安装包

| 平台 | 产物 | 位置 |
|---|---|---|
| Windows x64 | `Ternimal Setup 1.2.0.exe`（83MB） | Windows 构建机 `C:\Users\zz\ternimal-build\release\`（已静默安装至测试机） |
| Linux deb | `ternimal_1.2.0_amd64.deb` | 本机 `release/`（已安装） |
| Linux AppImage | `Ternimal-1.2.0.AppImage` | 本机 `release/` |

> 发布到 GitHub Releases：本文件即说明文案；三个安装包手动上传即可。
