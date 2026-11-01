import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {settingsDefaults,validateSettings} from './settings.js';

export function loadConfig(root = process.env.DARK_FABRIC_HOME || path.resolve('.darkfabric')) {
  root = path.resolve(root);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, 'config.json');
  const defaults = {
    ...settingsDefaults,
    port: 4317, codexPath: process.env.CODEX_BIN || 'codex', model: null,
    workers: 1, pollMs: 3000, turnTimeoutMs: 30 * 60_000,
    rpcTimeoutMs: 30_000, retryBaseMs: 30_000, maxAttempts: 4,
    maxRepairCycles: 4, dailyTurnLimit: 100, quotaPollMs: 300_000,
    unknownQuotaBackoffMs: 900_000, maxPlanTasks: 40,
    maxImprovementTasks: 3, retrospectiveEvery: 5, networkAccess: true,
    autoIntegrate: true, autoImprove: true,
    executionAccess: 'workspace', technicalRecovery: true,
  };
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n');
  const config = { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')), root };
  for (const key of ['port','workers','pollMs','turnTimeoutMs','rpcTimeoutMs','retryBaseMs','maxAttempts','maxRepairCycles','dailyTurnLimit','quotaPollMs','unknownQuotaBackoffMs','maxPlanTasks','maxImprovementTasks','retrospectiveEvery']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid config: ${key}`);
  }
  if (config.workers > 8 || config.port > 65535) throw new Error('Invalid workers/port');
  for (const key of ['autoIntegrate','autoImprove','networkAccess','technicalRecovery']) if (typeof config[key] !== 'boolean') throw new Error(`Invalid config: ${key}`);
  if(!['workspace','full'].includes(config.executionAccess))throw new Error('Invalid executionAccess');
  validateSettings(Object.fromEntries(Object.keys(settingsDefaults).map(k=>[k,config[k]])));
  return config;
}
