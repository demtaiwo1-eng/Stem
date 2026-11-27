#!/usr/bin/env node
'use strict';

/**
 * STEM release orchestrator.
 *
 * Runs code checks, deploys the backend through the configured hosting CLI,
 * updates the GitHub Pages API endpoint, waits for Pages to publish it,
 * checks backend health/capabilities, and (when explicitly enabled) runs
 * paid FAL end-to-end tests for WAV, MP3 and ZIP uploads.
 *
 * Never prints secret values. A full pass requires the hosting provider's
 * deploy command and the required runtime credentials to be configured as
 * environment variables in the release runner.
 */

const { spawn } = require('node:child_process');
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const archiver = require('archiver');
const unzipper = require('unzipper');

const require = createRequire(import.meta.url);
const API_BASE = (process.env.STEM_API_BASE || '').replace(/\/+$/, '');
const FRONTEND_REPO = process.env.STEM_FRONTEND_REPO || 'demtaiwo1-eng/stem.github.io';
const FRONTEND_BRANCH = process.env.STEM_FRONTEND_BRANCH || 'main';
const FRONTEND_URL = (process.env.STEM_FRONTEND_URL || 'https://demtaiwo1-eng.github.io/stem.github.io/').replace(/\/?$/, '/');
const GH_TOKEN = process.env.STEM_FRONTEND_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const PAID_E2E = process.env.STEM_RUN_PAID_E2E === 'true';
const TIMEOUT_MS = Number(process.env.STEM_JOB_TIMEOUT_MS || 20 * 60 * 1000);
const EXPECTED_STEMS = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];

function log(message) {
  process.stdout.write('[STEM RELEASE] ' + message + '\n');
}
function fail(message) {
  throw new Error(message);
}
function required(name) {
  const value = process.env[name];
  if (!value) fail('Missing required configuration: ' + name);
  return value;
}
async function request(url, options = {}, label = url) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    fail(label + ' failed (' + response.status + '): ' + body.slice(0, 500));
  }
  return response;
}
async function runCommand(command) {
  log('Running backend deployment command.');
  const child = spawn(command, { shell: true, stdio: 'inherit', env: process.env });
  const [code] = await once(child, 'exit');
  if (code !== 0) fail('Backend deployment command failed with exit code ' + code + '.');
}
async function githubRequest(url, options = {}) {
  return request(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + GH_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  }, 'GitHub API request');
}
async function publishFrontendApiBase() {
  if (!GH_TOKEN) fail('STEM_FRONTEND_GITHUB_TOKEN (or GITHUB_TOKEN) is required to update the separate GitHub Pages repository.');
  const apiUrl = 'https://api.github.com/repos/' + FRONTEND_REPO + '/contents/api-config.js?ref=' + encodeURIComponent(FRONTEND_BRANCH);
  const current = await (await githubRequest(apiUrl)).json();
  const source = Buffer.from(current.content.replace(/\n/g, ''), 'base64').toString('utf8');
  const updated = source.replace(
    /window\.STEM_API_BASE\s*=\s*(['"]).*?\1\s*;/,
    'window.STEM_API_BASE = ' + JSON.stringify(API_BASE) + ';'
  );
  if (updated === source && !/window\.STEM_API_BASE\s*=/.test(source)) {
    fail('Could not locate window.STEM_API_BASE in the frontend api-config.js.');
  }
  if (updated === source) {
    log('Frontend API configuration already matches the target API.');
    return;
  }
  const body = {
    message: 'chore: connect GitHub Pages frontend to live STEM API',
    content: Buffer.from(updated, 'utf8').toString('base64'),
    sha: current.sha,
    branch: FRONTEND_BRANCH
  };
  await githubRequest('https://api.github.com/repos/' + FRONTEND_REPO + '/contents/api-config.js', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  log('Committed the live API address to the GitHub Pages frontend.');
}
async function waitForFrontendConfig() {
  const configUrl = new URL('api-config.js', FRONTEND_URL).toString();
  const deadline = Date.now() + 4 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const text = await (await fetch(configUrl, { cache: 'no-store' })).text();
      if (text.includes('window.STEM_API_BASE = ' + JSON.stringify(API_BASE) + ';')) {
        log('GitHub Pages now serves the correct API address.');
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  fail('GitHub Pages did not publish the API configuration within four minutes.');
}
async function checkFrontend() {
  const page = await (await request(FRONTEND_URL, {}, 'GitHub Pages landing page')).text();
  if (!page.includes('upload-form') || !page.includes('submit-btn') || !page.includes('audio-file')) {
    fail('The published landing page is missing the audio upload form or Convert STEM control.');
  }
  const appUrl = new URL('app.js', FRONTEND_URL).toString();
  const app = await (await request(appUrl, {}, 'Published frontend JavaScript')).text();
  if (!app.includes("form.addEventListener('submit'") || !app.includes("apiFetch('/api/jobs'")) {
    fail('The published Convert STEM control is not wired to the backend upload endpoint.');
  }
  log('Published landing page, upload form and Convert STEM submit handler passed.');
}
async function checkService() {
  const health = await (await request(API_BASE + '/health', {}, 'Backend health check')).json();
  if (health.ok !== true || health.database !== 'connected' || health.objectStorage !== true || health.falConfigured !== true) {
    fail('Backend health check is incomplete. Expected database, private storage and FAL all ready.');
  }
  const capabilities = await (await request(API_BASE + '/api/capabilities', {}, 'Backend capabilities check')).json();
  for (const stem of EXPECTED_STEMS) {
    if (!capabilities.sources?.includes(stem)) fail('Backend does not advertise the required stem: ' + stem);
  }
  for (const format of ['wav', 'mp3']) {
    if (!capabilities.formats?.includes(format)) fail('Backend does not advertise ' + format.toUpperCase() + ' output.');
  }
  if (capabilities.zipUploads !== true) fail('Backend does not advertise ZIP upload support.');
  log('Backend health and capabilities passed.');
}
function makeWav(seconds = 24, sampleRate = 44100) {
  const channels = 2;
  const bits = 16;
  const dataBytes = seconds * sampleRate * channels * (bits / 8);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  buffer.writeUInt16LE(channels * bits / 8, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < seconds * sampleRate; i++) {
    const t = i / sampleRate;
    const sample = Math.max(-1, Math.min(1,
      0.28 * Math.sin(2 * Math.PI * 220 * t) +
      0.16 * Math.sin(2 * Math.PI * 329.63 * t) +
      0.10 * Math.sin(2 * Math.PI * 440 * t)
    ));
    const value = Math.round(sample * 32767);
    buffer.writeInt16LE(value, 44 + i * 4);
    buffer.writeInt16LE(value, 46 + i * 4);
  }
  return buffer;
}
async function createZip(filePath, audioBuffer) {
  const output = require('node:fs').createWriteStream(filePath);
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(output);
  archive.append(audioBuffer, { name: 'release-test-tone.wav' });
  const finished = once(output, 'close');
  await archive.finalize();
  await finished;
}
async function submitJob(fileBuffer, fileName, outputFormat) {
  const form = new FormData();
  form.append('audio', new Blob([fileBuffer]), fileName);
  form.append('outputFormat', outputFormat);
  const response = await request(API_BASE + '/api/jobs', { method: 'POST', body: form }, 'Upload ' + fileName);
  const job = await response.json();
  if (!job.id) fail('Upload was accepted without a job ID.');
  log('Created ' + outputFormat.toUpperCase() + ' test job ' + job.id + '.');
  return job.id;
}
async function waitForJob(id) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await (await request(API_BASE + '/api/jobs/' + encodeURIComponent(id), {}, 'Job status')).json();
    if (job.status === 'completed') return job;
    if (job.status === 'failed') fail('Job ' + id + ' failed: ' + (job.message || 'Unknown processing error.'));
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  fail('Job ' + id + ' exceeded the configured processing timeout.');
}
async function verifyCompletedJob(id, expectedFormat) {
  const job = await waitForJob(id);
  if (job.progress !== 100) fail('Completed job did not report 100% progress.');
  const manifest = await (await request(API_BASE + '/api/jobs/' + id + '/results', {}, 'Result manifest')).json();
  if (manifest.outputFormat !== expectedFormat) fail('Output format does not match the requested format.');
  const found = new Set((manifest.files || []).map(file => file.stem));
  const missing = EXPECTED_STEMS.filter(stem => !found.has(stem));
  if (missing.length) fail('The conversion did not return all six stems: ' + missing.join(', '));
  for (const file of manifest.files) {
    if (!file.downloadUrl) fail('Missing signed download URL for ' + file.stem + '.');
    const response = await request(file.downloadUrl, {}, 'Stem download ' + file.stem);
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) fail('Downloaded stem is empty: ' + file.stem);
  }
  const zipResponse = await request(API_BASE + '/api/jobs/' + id + '/download', {}, 'ZIP result download');
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer());
  if (zipBytes.length < 4 || zipBytes.readUInt32LE(0) !== 0x04034b50) fail('The downloadable results archive is not a valid ZIP file.');
  const directory = await unzipper.Open.buffer(zipBytes);
  if (directory.files.length < EXPECTED_STEMS.length) fail('The result ZIP contains fewer than six files.');
  log('Verified six non-empty ' + expectedFormat.toUpperCase() + ' stems and a valid downloadable ZIP for job ' + id + '.');
}
async function runPaidEndToEnd() {
  if (!PAID_E2E) fail('Full conversion tests are disabled. Set STEM_RUN_PAID_E2E=true only when FAL usage charges are approved.');
  const directory = await mkdtemp(path.join(tmpdir(), 'stem-release-'));
  try {
    const wav = makeWav();
    const zipPath = path.join(directory, 'release-test.zip');
    await createZip(zipPath, wav);
    const zipBuffer = await readFile(zipPath);

    const wavJob = await submitJob(wav, 'release-test.wav', 'wav');
    await verifyCompletedJob(wavJob, 'wav');

    const mp3Job = await submitJob(wav, 'release-test.wav', 'mp3');
    await verifyCompletedJob(mp3Job, 'mp3');

    const zipJob = await submitJob(zipBuffer, 'release-test.zip', 'wav');
    await verifyCompletedJob(zipJob, 'wav');
    log('Full live conversion suite passed: WAV, MP3, ZIP, six stems, previews and downloads.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js 20 or later is required.');
  required('DATABASE_URL');
  required('AWS_ENDPOINT_URL_S3');
  required('AWS_ACCESS_KEY_ID');
  required('AWS_SECRET_ACCESS_KEY');
  required('FAL_API_KEY');
  required('STEM_API_BASE');
  required('STEM_DEPLOY_COMMAND');
  if (!API_BASE.startsWith('https://')) fail('STEM_API_BASE must be an HTTPS URL.');
  if (!GH_TOKEN) fail('A GitHub token with contents:write access to ' + FRONTEND_REPO + ' is required.');
  if (!PAID_E2E) fail('Full conversion verification is disabled. Re-run the workflow with run_paid_e2e=true only when FAL usage charges are approved. No deployment was started.');

  log('Running backend syntax/dependency checks.');
  const check = spawn('npm', ['run', 'check'], { stdio: 'inherit' });
  const [checkCode] = await once(check, 'exit');
  if (checkCode !== 0) fail('Backend code checks failed.');

  await runCommand(required('STEM_DEPLOY_COMMAND'));
  await publishFrontendApiBase();
  await waitForFrontendConfig();
  await checkFrontend();
  await checkService();
  await runPaidEndToEnd();
  log('RELEASE PASS: backend deployed, frontend connected, health verified and live conversions downloaded.');
}
main().catch(error => {
  console.error('[STEM RELEASE] RELEASE FAILED: ' + error.message);
  process.exitCode = 1;
});
