const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runProtocol(args, octsshHome, extraEnv = {}) {
  return spawnSync('node', ['dist/index.js', ...args], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      OCTSSH_HOME: octsshHome,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 3000,
  });
}

test('env-manager protocol returns default octssh env schema without side effects', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-env-protocol-'));
  const octsshHome = path.join(tmp, 'octssh-home');

  const result = runProtocol(['--env-manager-protocol'], octsshHome);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(octsshHome), false);

  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    version: '1.0',
    program: 'octssh',
    env_vars: [
      { name: 'OCTSSH_HOME', type: 'path', default: path.join(os.homedir(), '.octssh') },
      { name: 'OCTSSH_SSH_CONFIG', type: 'path', default: path.join(os.homedir(), '.ssh', 'config') },
      { name: 'OCTSSH_TOOL_PREFIX', type: 'string', default: '' },
      { name: 'OCTSSH_REMOTE_SHELL', type: 'string', default: 'sh' },
    ],
  });
});

test('env-manager protocol includes the remote shell for init', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-env-protocol-init-'));
  const octsshHome = path.join(tmp, 'octssh-home');

  const result = runProtocol(['init', '--env-manager-protocol'], octsshHome);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(octsshHome), false);

  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.env_vars, [
    { name: 'OCTSSH_HOME', type: 'path', default: path.join(os.homedir(), '.octssh') },
    { name: 'OCTSSH_SSH_CONFIG', type: 'path', default: path.join(os.homedir(), '.ssh', 'config') },
    { name: 'OCTSSH_REMOTE_SHELL', type: 'string', default: 'sh' },
  ]);
});

test('env-manager protocol prefers serve schema over starting the serve server', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-env-protocol-serve-'));
  const octsshHome = path.join(tmp, 'octssh-home');

  const result = runProtocol(['serve', '--env-manager-protocol'], octsshHome, {
    OCTSSH_TOOL_PREFIX: 'custom_prefix_',
    OCTSSH_SERVE_HOST: '0.0.0.0',
    OCTSSH_SERVE_PORT: '9999',
    OCTSSH_SERVE_KEY: 'super-secret',
    OCTSSH_SERVE_DEBUG: 'true',
    OCTSSH_DEBUG: 'true',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(octsshHome), false);

  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed, {
    version: '1.0',
    program: 'octssh',
    env_vars: [
      { name: 'OCTSSH_HOME', type: 'path', default: path.join(os.homedir(), '.octssh') },
      { name: 'OCTSSH_TOOL_PREFIX', type: 'string', default: '' },
      { name: 'OCTSSH_SHELL', type: 'enum', default: '' },
      { name: 'OCTSSH_SERVE_HOST', type: 'string', default: '127.0.0.1' },
      { name: 'OCTSSH_SERVE_PORT', type: 'number', default: 8787 },
      { name: 'OCTSSH_SERVE_KEY', type: 'secret', default: '' },
      { name: 'OCTSSH_SERVE_DEBUG', type: 'boolean', default: false },
      { name: 'OCTSSH_DEBUG', type: 'boolean', default: false },
    ],
  });
});
