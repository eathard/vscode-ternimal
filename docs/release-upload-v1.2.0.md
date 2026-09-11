# v1.2.0 Release 上传清单（给用户手动操作）

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
