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
  after-sign.js          electron-builder afterSign 钩子（本地自签名时主程序由 electron-builder 原生签）
  sign-setup.js          postdist 步骤（安装包签名检查）
.github/workflows/       构建 + 发 Release 的 CI
```

## 本地开发 / 构建

```bash
npm install
npm run dist          # 打包 Windows x64 安装包
```

- `predist` 会在打包前**自动把版本号 +1**，并同步更新 `package.json` / `data.json` / `package-lock.json`。
- 未配置本地签名证书时，照常产出**未签名**安装包，不会报错。
- 使用 `npm run bump` 可单独递增版本号；`npm run start`（或 `start-app.bat`）用于本地启动调试。

## 版本号规则

| 场景 | 行为 |
| --- | --- |
| 本地 `npm run dist` | 每次打包自动 +1 |
| CI 打 `v*` tag 发布 | 用 `scripts/set-version.js` 把版本号**对齐到 tag**（去掉 `v` 前缀），并通过 `SKIP_BUMP=1` 跳过自动 +1，保证打出的版本与 tag 完全一致 |

## 代码签名（本地自签名，不依赖外部服务）

代码签名由 electron-builder 原生 CSC 完成（主程序 `PcAsMobile.exe` 与安装包 `setup.exe` 都会签），无需改动业务代码，也不依赖任何外部签名服务。

### 启用（可选）

准备一个 PFX（含私钥）及其导出密码，在仓库 `Settings → Secrets and variables → Actions` 添加：

- `CSC_LINK`：PFX 文件的 **base64**（例如 `base64 -w0 cert.pfx` 的输出）
- `CSC_KEY_PASSWORD`：PFX 的导出密码

CI 构建时会自动把 `CSC_LINK` 解码为 `sign.pfx` 并交给 electron-builder 签名；不配置这两个密钥则出未签名包。

> 注意：自签名证书**不会被 Windows / SmartScreen 信任**，安装时仍可能提示“未知发布者”。要获得系统信任的签名，需使用 CA 签发的代码签名证书（商业 OV/EV）。

## 发布流程（CI 自动构建 + 发版）

```bash
git tag v1.0.7
git push origin v1.0.7
```

工作流会自动：

1. 把版本号对齐到 tag；
2. `npm run dist` 构建（若配置了 `CSC_LINK` 则本地自签名）；
3. 创建 GitHub Release 并附上 `setup.exe`（自动生成更新说明）。

也可在仓库 `Actions` 页面手动 `workflow_dispatch` 触发：仅上传构建产物（artifact），不创建 Release。

## 备注

- 免费 OSS 证书为 **OV 级**：新证书初期 SmartScreen 仍可能提示，需要一定下载量积累信誉后才不再报警。
- 若希望签名后**立刻**不触发 SmartScreen 警告，需改用 **EV 证书**或 **Azure Trusted Signing**。
