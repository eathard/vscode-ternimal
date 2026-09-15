# v1.2.0 Release 上传清单（已完成 ✅）

> 2026-09-12 经 CDP 驱动可见 Chrome 完成上传并验证：三产物公网下载 md5 与本地一致
>（deb cc9cfae7…/AppImage a7ab59e7…/exe f3f136e4…）。发布页 /releases/tag/v1.2.0。


> 产物-tag 匹配教训：v1.1.0 Release 曾误传早期构建（无中继代码）。本次三个产物
> 均构建自 **02f3549**（= 待打 tag 的提交），上传前请核对时间戳。

## 一、打 tag 并推送

```bash
cd ~/vscode-ternimal
git tag -f v1.2.0 02f3549
git push origin v1.2.0 --force
```

（v1.2.0 旧 tag 指向 38fa303，缺少后续四个修复：跟随模式几何、WebGL 误伤撤销、
TTY 环境净化、角标清理——必须重打。）

## 二、上传三个产物

GitHub → Releases → Draft a new release → 选 tag v1.2.0 → 附文件：

| 产物 | 位置 | 校验（构建时间） |
|---|---|---|
| ternimal_1.2.0_amd64.deb | ~/vscode-ternimal/release/ | 09-12 00:4x |
| Ternimal-1.2.0.AppImage | ~/vscode-ternimal/release/ | 09-12 00:4x |
| Ternimal Setup 1.2.0.exe | Windows 机 zz 桌面（00:50 构建） | 拷回或从 C:\Users\zz\ternimal-build\release\ 上传 |

Release 说明直接粘贴：`docs/release-notes-v1.2.0.md` 内容（已含混合口令、
WebGL/几何修复、帮助按钮等条目；建议在文首追加一行「v1.2.1 热修：手机跟随
模式几何+PTY 颜色环境净化」）。

## 三、上传后验证（5 分钟）

1. `curl -sL -o /tmp/check.deb <release下载URL> && md5sum /tmp/check.deb` 与本地比对
2. 下载页点开 tag → 「Browse files」应显示 02f3549 的树（与本地 `git ls-tree` 一致）
3. 新机器装 deb → ⚙ 面板粘贴 tconf_v1 口令 → 已连接

## 备注

- 无 gh CLI/PAT，故需网页手动上传；若提供 PAT，可一条命令完成：
  `gh release create v1.2.0 release/ternimal_1.2.0_amd64.deb release/Ternimal-1.2.0.AppImage --title "Ternimal v1.2.0" --notes-file docs/release-notes-v1.2.0.md`

---

## v1.2.1 追记（2026-09-14）

- 发布页 /releases/tag/v1.2.1；三资产公网 md5 与本地一致（deb 40fa93d7 / AppImage a2bfd19b / exe 9340d0b5，exe 83.0MB）
- **Windows 体积事故与防御**：构建机 dist/ 残留 1.0.0 时代产物（win-unpacked 592MB + 旧 exe 175MB）被 `files: dist/**/*` 打进 asar，首版 exe 膨胀至 438MB；已清残留重打包并在 electron-builder.yml 增加排除（`!dist/win-unpacked`、`!dist/*.exe*` 等），提交 1c85d00
- CDP 上传要点：资产必须挂 `.js-upload-release-file input[type=file]`（正文编辑器附件输入会走 RepositoryFile 白名单 → 422）

## 官网部署（vscode-ternimal.github.io，2026-09-14）

```bash
# website/ 是源；部署 = 复制到独立仓库推 main
DEPLOY=/tmp/io-deploy && rm -rf $DEPLOY && mkdir -p $DEPLOY
cp -r website/* $DEPLOY/ && cd $DEPLOY
git init -q -b main && git add -A
git -c user.name=eathard -c user.email=eathard@users.noreply.github.com commit -q -m "deploy: site"
git remote add origin git@github.com:vscode-ternimal/vscode-ternimal.github.io.git
git push -u origin main
```
- Pages 源：Deploy from a branch → main / (root)；构建不触发时推空提交即可重入队
- 仓库需 public（私有仓库 Pages 要付费计划）；已核：website/ 无密钥/内网信息方可公开

## v1.3.0 发版记录（2026-09-15）

- tag v1.3.0（1af3166）；三资产公网 md5=本地：deb a865a054 / AppImage d58fde1e / exe 846337f6（exe 83.1MB，取自 Windows build-13）
- verify 全伞（分批补跑）：vitest 72/72 · registry 8/8 · ws-protocol 18/18 · reconnect 8/8 · relay 14/14 · relay-e2e 13/13 · matrix 6/6 · admin 11/11 · takeover 5/5 · token 6/6
- 事故：verify 伞与打包/下载并行跑时 M-05 吞吐用例无限死等 35min（资源挤占）→ 已加 120s Promise.race 护栏
