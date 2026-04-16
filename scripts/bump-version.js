#!/usr/bin/env node
/**
 * Updates js/version.js with the current git commit hash.
 * Run this before every push, or wire it into a git pre-push hook.
 *
 * Usage:  node scripts/bump-version.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const commit = execSync('git rev-parse HEAD').toString().trim();
const repo   = 'VedBhatnagar03/Melody-Match';
const branch = 'master';

const content = `/* ───────────────────────────────────────────────
   VERSION — updated automatically on each push
   Run: node scripts/bump-version.js
   Or set COMMIT_HASH manually after deploying.
─────────────────────────────────────────────── */
const APP_VERSION = {
  commit: '${commit}',
  repo:   '${repo}',
  branch: '${branch}',
};
`;

const outPath = path.join(__dirname, '..', 'js', 'version.js');
fs.writeFileSync(outPath, content);
console.log(`version.js updated → ${commit.slice(0, 7)}`);
