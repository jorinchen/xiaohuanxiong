#!/usr/bin/env node
/**
 * 通过 SignPath REST API 对文件进行代码签名（免费开源档需在公共 CI 中运行）。
 * 未设置 SIGNPATH_API_TOKEN 时直接跳过（本地构建仍可正常出包，只是未签名）。
 *
 * 环境变量：
 *   SIGNPATH_API_TOKEN          必填（不设置则跳过）
 *   SIGNPATH_ORGANIZATION_ID    必填
 *   SIGNPATH_PROJECT_ID         必填
 *   SIGNPATH_SIGNING_POLICY     默认 release-signing
 *   SIGNPATH_ARTIFACT_CONFIG    可选（若 SignPath 项目要求指定 artifact configuration）
 *
 * 用法：node scripts/sign-signpath.js --path dist/setup.exe
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const API = 'https://app.signpath.io/API/v1';

function getEnv(name, fallback) {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  let target = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path') { target = args[i + 1]; i++; }
  }
  if (!target) target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('[signpath] 用法: node sign-signpath.js --path <文件>');
    process.exit(1);
  }
  target = path.resolve(target);

  const token = getEnv('SIGNPATH_API_TOKEN');
  if (!token) {
    console.log('[signpath] 未设置 SIGNPATH_API_TOKEN，跳过签名（本地构建）。');
    return;
  }
  const org = getEnv('SIGNPATH_ORGANIZATION_ID');
  const proj = getEnv('SIGNPATH_PROJECT_ID');
  if (!org || !proj) {
    console.error('[signpath] 缺少 SIGNPATH_ORGANIZATION_ID / SIGNPATH_PROJECT_ID 环境变量。');
    process.exit(1);
  }
  const policy = getEnv('SIGNPATH_SIGNING_POLICY', 'release-signing');
  const artifactConfig = getEnv('SIGNPATH_ARTIFACT_CONFIG');

  const auth = { Authorization: 'Bearer ' + token };

  // 1) 上传并提交签名请求
  let url = API + '/' + org + '/projects/' + proj +
    '/artifacts?signingPolicyName=' + encodeURIComponent(policy);
  if (artifactConfig) url += '&artifactConfigurationName=' + encodeURIComponent(artifactConfig);

  console.log('[signpath] 上传并提交签名请求: ' + target);
  let signingRequestId;
  {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: fs.createReadStream(target),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[signpath] 上传失败: ' + res.status + ' ' + txt);
      process.exit(1);
    }
    const data = await res.json();
    signingRequestId = data.signingRequestId;
  }
  if (!signingRequestId) {
    console.error('[signpath] 未返回 signingRequestId');
    process.exit(1);
  }
  console.log('[signpath] signingRequestId=' + signingRequestId + '，等待签名完成…');

  // 2) 轮询状态（最多约 5 分钟）
  let status = '';
  const srUrl = API + '/' + org + '/projects/' + proj + '/signing-requests/' + signingRequestId;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(srUrl, { headers: auth });
    if (!res.ok) {
      console.error('[signpath] 查询状态失败: ' + res.status);
      process.exit(1);
    }
    const data = await res.json();
    status = data.status;
    console.log('[signpath] 状态: ' + status);
    if (status === 'Completed') break;
    if (status === 'Failed' || status === 'Rejected') {
      console.error('[signpath] 签名失败/被拒: ' + status);
      process.exit(1);
    }
  }
  if (status !== 'Completed') {
    console.error('[signpath] 签名超时（5 分钟）');
    process.exit(1);
  }

  // 3) 下载已签名文件，覆盖原文件
  const dlUrl = srUrl + '/artifact';
  console.log('[signpath] 下载已签名文件: ' + target);
  const res = await fetch(dlUrl, { headers: auth });
  if (!res.ok) {
    console.error('[signpath] 下载签名文件失败: ' + res.status);
    process.exit(1);
  }
  await pipeline(res.body, fs.createWriteStream(target));
  console.log('[signpath] 已签名并写回: ' + target);
}

main().catch((e) => {
  console.error('[signpath] 异常: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
