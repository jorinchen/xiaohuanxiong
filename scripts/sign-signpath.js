#!/usr/bin/env node
/**
 * 通过 SignPath REST API 对文件进行代码签名（免费开源档需在公共 CI 中运行）。
 * 未设置 SIGNPATH_API_TOKEN 时直接跳过（本地构建仍可正常出包，只是未签名）。
 *
 * 对接的官方端点（https://docs.signpath.io/build-system-integration）：
 *   POST {ApiUrl}/{organizationId}/SigningRequests/SubmitWithArtifact   multipart 提交
 *   GET  {ApiUrl}/{organizationId}/SigningRequests/{id}                 轮询状态
 *   GET  {ApiUrl}/{organizationId}/SigningRequests/{id}/SignedArtifact  下载签名后文件
 *
 * 环境变量：
 *   SIGNPATH_API_TOKEN        必填（不设置则跳过）
 *   SIGNPATH_ORGANIZATION_ID  必填（组织 GUID，浏览器地址栏 / 组织设置可见）
 *   SIGNPATH_PROJECT_SLUG     必填（创建项目时填的 Slug，不是 GUID）
 *   SIGNPATH_SIGNING_POLICY   默认 release-signing（签名策略 slug）
 *   SIGNPATH_ARTIFACT_CONFIG  可选（artifactConfigurationSlug）
 *
 * 用法：node scripts/sign-signpath.js --path dist/setup.exe
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const API = 'https://app.signpath.io/Api/v1';

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
  const projectSlug = getEnv('SIGNPATH_PROJECT_SLUG');
  if (!org || !projectSlug) {
    console.error('[signpath] 缺少 SIGNPATH_ORGANIZATION_ID / SIGNPATH_PROJECT_SLUG 环境变量。');
    process.exit(1);
  }
  const policy = getEnv('SIGNPATH_SIGNING_POLICY', 'release-signing');
  const artifactConfig = getEnv('SIGNPATH_ARTIFACT_CONFIG');

  const auth = { Authorization: 'Bearer ' + token };

  // 1) 提交签名请求（multipart：projectSlug / signingPolicySlug / artifact）
  const submitUrl = API + '/' + org + '/SigningRequests/SubmitWithArtifact';
  const form = new FormData();
  form.append('projectSlug', projectSlug);
  form.append('signingPolicySlug', policy);
  if (artifactConfig) form.append('artifactConfigurationSlug', artifactConfig);
  form.append('description', 'xiaohuanxiong: ' + path.basename(target));
  form.append('artifact', new Blob([fs.readFileSync(target)]), path.basename(target));

  console.log('[signpath] 上传并提交签名请求: ' + target);
  let requestUrl = null;
  {
    const res = await fetch(submitUrl, { method: 'POST', headers: auth, body: form });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[signpath] 提交失败: ' + res.status + ' ' + txt);
      process.exit(1);
    }
    // 201：Location 头指向新创建的签名请求实体
    requestUrl = res.headers.get('location');
    if (!requestUrl) {
      // 兜底：响应体里找 id / signingRequestId
      const data = await res.json().catch(() => null);
      const id = data && (data.id || data.signingRequestId);
      if (id) requestUrl = API + '/' + org + '/SigningRequests/' + id;
    }
  }
  if (!requestUrl) {
    console.error('[signpath] 响应中未包含签名请求地址（Location 头或 id 均缺失）');
    process.exit(1);
  }
  console.log('[signpath] signingRequest: ' + requestUrl + '，等待签名完成…');

  // 2) 轮询状态（最多约 5 分钟）
  let status = '';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(requestUrl, { headers: auth });
    if (!res.ok) {
      console.error('[signpath] 查询状态失败: ' + res.status);
      process.exit(1);
    }
    const data = await res.json();
    status = data.status || data.Status || '';
    console.log('[signpath] 状态: ' + status);
    if (status === 'Completed') break;
    if (['Failed', 'Rejected', 'Canceled'].includes(status)) {
      console.error('[signpath] 签名失败/被拒: ' + status);
      process.exit(1);
    }
  }
  if (status !== 'Completed') {
    console.error('[signpath] 签名超时（5 分钟）');
    process.exit(1);
  }

  // 3) 下载已签名文件，覆盖原文件
  const dlUrl = requestUrl + '/SignedArtifact';
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
