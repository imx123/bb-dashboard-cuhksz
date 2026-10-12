import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardStartupHistory } from '../src/dashboard/startup-history.js';

test('first use remains first use across restarts until verified login is recorded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dashboard-first-use-'));
  try {
    for (let i = 0; i < 2; i++) {
      const history = new DashboardStartupHistory(home);
      await history.initialize();
      assert.equal(history.canRestore, false);
    }
    await assert.rejects(readFile(join(home, 'dashboard-startup.json')), { code: 'ENOENT' });
    const history = new DashboardStartupHistory(home);
    await history.recordVerifiedLogin();
    const restarted = new DashboardStartupHistory(home);
    await restarted.initialize();
    assert.equal(restarted.canRestore, true);
    assert.deepEqual(JSON.parse(await readFile(history.file, 'utf8')), { version: 1, hasVerifiedLogin: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid or unsupported setup metadata cannot enable session or cache restoration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dashboard-invalid-setup-'));
  try {
    const history = new DashboardStartupHistory(home);
    for (const value of ['null', '{"version":2,"hasVerifiedLogin":true}', '{"version":1,"hasVerifiedLogin":"true"}']) {
      await writeFile(history.file, value);
      await history.initialize();
      assert.equal(history.canRestore, false);
    }
    await writeFile(history.file, 'broken-json');
    await assert.rejects(history.initialize());
    assert.equal(history.canRestore, false);
    assert.equal(await readFile(history.file, 'utf8'), 'broken-json');
  } finally { await rm(home, { recursive: true, force: true }); }
});
