#!/usr/bin/env node
'use strict';

const apiBase = (process.env.STEM_API_BASE || 'https://stem-api-o0ij.onrender.com').replace(/\/+$/, '');
const frontendUrl = process.env.STEM_FRONTEND_URL || 'https://demtaiwo1-eng.github.io/stem.github.io/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(url + ' returned non-JSON HTTP ' + response.status); }
  if (!response.ok) throw new Error(url + ' returned HTTP ' + response.status + ': ' + (data.error || response.statusText));
  return data;
}

async function main() {
  console.log('[STEM] Checking Render API and GitHub Pages wiring.');
  let health;
  let lastError;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      health = await getJson(apiBase + '/health');
      break;
    } catch (error) {
      lastError = error;
      await sleep(10000);
    }
  }
  if (!health) throw lastError || new Error('Render API did not become reachable.');
  console.log('[STEM] Render API is reachable; database=' + health.database + ', objectStorage=' + health.objectStorage + ', falConfigured=' + health.falConfigured + '.');

  const configUrl = new URL('api-config.js', frontendUrl).toString();
  const configResponse = await fetch(configUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!configResponse.ok) throw new Error('GitHub Pages api-config.js returned HTTP ' + configResponse.status);
  const config = await configResponse.text();
  if (!config.includes('window.STEM_API_BASE = ' + JSON.stringify(apiBase) + ';')) {
    throw new Error('GitHub Pages is not yet serving the configured Render API URL.');
  }

  const capabilities = await getJson(apiBase + '/api/capabilities');
  for (const stem of ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']) {
    if (!capabilities.sources?.includes(stem)) throw new Error('Missing advertised stem: ' + stem);
  }
  for (const format of ['wav', 'mp3']) {
    if (!capabilities.formats?.includes(format)) throw new Error('Missing output format: ' + format);
  }
  if (capabilities.zipUploads !== true) throw new Error('ZIP upload support is not enabled.');

  if (health.ok !== true || health.database !== 'connected' || health.objectStorage !== true || health.falConfigured !== true) {
    const missing = [];
    if (health.database !== 'connected') missing.push('Neon database');
    if (health.objectStorage !== true) missing.push('Neon private object storage');
    if (health.falConfigured !== true) missing.push('FAL_API_KEY');
    throw new Error('Service is reachable and frontend is connected, but processing setup is incomplete: ' + missing.join(', ') + '.');
  }
  console.log('[STEM] PASS: Render health, Neon, FAL configuration, six-stem capabilities, WAV/MP3, ZIP and Pages API URL.');
}

main().catch(error => {
  console.error('[STEM] RELEASE CHECK FAILED: ' + error.message);
  process.exitCode = 1;
});
