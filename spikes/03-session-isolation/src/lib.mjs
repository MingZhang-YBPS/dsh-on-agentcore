// 本机脚本共用：读取 .state/state.env、写结果文件。
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS_DIR = join(SPIKE_DIR, 'results');

export function loadState() {
  const text = readFileSync(process.env.SPIKE_STATE_FILE || join(SPIKE_DIR, '.state', 'state.env'), 'utf8');
  const state = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) state[m[1]] = m[2].replace(/\\(.)/g, '$1').replace(/^'(.*)'$/, '$1');
  }
  for (const k of ['REGION', 'BUCKET', 'TABLE_NAME', 'GW_ROLE_ARN', 'WS_ROLE_ARN', 'EXEC_ROLE_ARN', 'RUNTIME_ARN', 'SESSION_A', 'SESSION_B', 'SETUP_STARTED_MS']) {
    if (!state[k]) throw new Error(`state.env 缺少 ${k}，先运行 setup.sh`);
  }
  return state;
}

export function resultsPath(name) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  return join(RESULTS_DIR, name);
}

export function writeJson(name, obj) {
  writeFileSync(resultsPath(name), JSON.stringify(obj, null, 2) + '\n');
}

export function writeJsonl(name, rows) {
  writeFileSync(resultsPath(name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function appendJsonl(name, row) {
  appendFileSync(resultsPath(name), JSON.stringify(row) + '\n');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
