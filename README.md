# 小浣熊移动内核桌面浏览器

基于 Electron 的桌面浏览器，可在桌面端模拟 iOS / Android 内核的网页渲染与请求行为（移动端 UA、UA-CH、Referer、Cookie 补齐等），并内置 F12 控制台、页面放大、全屏、加密收藏等能力。

## 目录结构（核心）

```
main.js                  主进程：窗口、本地服务、网络请求头改写
page-*.js                渲染进程注入脚本（指纹/设备模拟）
preload.js / popup-*.js  预加载与弹窗逻辑
scripts/
  bump-version.js        打包时自动递增版本号（+1）
  set-version.js         CI 中把版本号对齐到 tag
  after-sign.js          electron-builder afterSign 钩子（签主程序 PcAsMobile.exe）
  sign-setup.js          postdist 步骤（签 setup.exe）
  sign-signpath.js       SignPath 签名客户端（无令牌时自动跳过）
.github/workflows/       构建 + 签名 + 发 Release 的 CI
```

## 本地开发 / 构建

```bash
npm install
npm run dist          # 打包 Windows x64 安装包
```

- `predist` 会在打包前**自动把版本号 +1**，并同步更新 `package.json` / `data.json` / `package-lock.json`。
- 未配置 SignPath 令牌时，签名步骤**自动跳过**，照常产出未签名安装包，不会报错。
- 使用 `npm run bump` 可单独递增版本号；`npm run start`（或 `start-app.bat`）用于本地启动调试。

## 版本号规则

| 场景 | 行为 |
| --- | --- |
| 本地 `npm run dist` | 每次打包自动 +1 |
| CI 打 `v*` tag 发布 | 用 `scripts/set-version.js` 把版本号**对齐到 tag**（去掉 `v` 前缀），并通过 `SKIP_BUMP=1` 跳过自动 +1，保证打出的版本与 tag 完全一致 |

## 代码签名（SignPath 免费开源档）

签名已接入构建流程，无需改动业务代码：

- **afterSign**：打包阶段先给主程序 `PcAsMobile.exe` 签名（装后运行的 exe 也是已签名的）。
- **postdist**：打包完成后给最终安装包 `setup.exe` 签名。
- 本地无令牌 → 跳过；CI 配了 `SIGNPATH_*` 密钥 → 自动调用 SignPath REST API 签名。

### 1. SignPath 控制台（一次性）

1. 注册 [signpath.io](https://signpath.io)，创建 **Organization** 与 **Project**。
2. 项目内建 **Signing Policy**（名称 `release-signing`）+ 对应的 **Artifact Configuration**（PE / 可执行文件）。
3. 生成 **API Token**。
4. 免费开源档要求：**仓库保持 Public**，并在 SignPath 中连接 GitHub、授权 CI（免费档只在受信任的 CI 构建中签名）。

### 2. GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions` 添加：

- `SIGNPATH_API_TOKEN`
- `SIGNPATH_ORGANIZATION_ID`（组织 GUID）
- `SIGNPATH_PROJECT_SLUG`（创建项目时填的 Slug，不是 GUID）

（可选 `SIGNPATH_SIGNING_POLICY`，默认 `release-signing`；`SIGNPATH_ARTIFACT_CONFIG` 指定 artifact configuration slug）

## 发布流程（CI 自动构建 + 签名 + 发版）

```bash
git tag v1.0.7
git push origin v1.0.7
```

工作流会自动：

1. 把版本号对齐到 tag；
2. `npm run dist` 构建（含 afterSign / postdist 签名）；
3. 用 SignPath 完成代码签名；
4. 创建 GitHub Release 并附上已签名的 `setup.exe`（自动生成更新说明）。

也可在仓库 `Actions` 页面手动 `workflow_dispatch` 触发：仅上传构建产物（artifact），不创建 Release。

## 备注

- 免费 OSS 证书为 **OV 级**：新证书初期 SmartScreen 仍可能提示，需要一定下载量积累信誉后才不再报警。
- 若希望签名后**立刻**不触发 SmartScreen 警告，需改用 **EV 证书**或 **Azure Trusted Signing**。
