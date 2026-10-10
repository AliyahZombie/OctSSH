const test = require('node:test');
const assert = require('node:assert/strict');

test('remote shell wrappers escape single quotes', () => {
  const mod = require('../dist/ssh/shell.js');

  const cmd = "echo 'hi'";
  const sh = mod.wrapRemoteShell(cmd);
  const sudo = mod.wrapSudoRemoteShell(cmd);

  assert.ok(sh.startsWith('sh -lc '));
  assert.ok(sudo.startsWith('sudo -n -- sh -lc '));
  // Ensure the inner single quote was escaped.
  assert.ok(sh.includes("'\\''"));
});

test('remote shell defaults to sh and can be configured', () => {
  const mod = require('../dist/ssh/shell.js');

  assert.equal(mod.getRemoteShell({}), 'sh');
  assert.equal(mod.getRemoteShell({ OCTSSH_REMOTE_SHELL: '  ' }), 'sh');
  assert.equal(mod.getRemoteShell({ OCTSSH_REMOTE_SHELL: ' /bin/bash ' }), '/bin/bash');
  assert.equal(mod.wrapRemoteShell('echo "$0"', 'bash'), `bash -lc 'echo "$0"'`);
  assert.equal(
    mod.wrapSudoRemoteShell('echo "$0"', '/usr/bin/zsh'),
    `sudo -n -- /usr/bin/zsh -lc 'echo "$0"'`
  );
});

test('remote shell value is quoted as one executable', () => {
  const mod = require('../dist/ssh/shell.js');
  const wrapped = mod.wrapRemoteShell('echo ok', 'bash; echo injected');

  assert.equal(wrapped, `'bash; echo injected' -lc 'echo ok'`);
});

test('legacy sh wrapper names remain compatible', () => {
  const mod = require('../dist/ssh/shell.js');

  assert.equal(mod.wrapSh, mod.wrapRemoteShell);
  assert.equal(mod.wrapSudoSh, mod.wrapSudoRemoteShell);
});

test('isSudoPasswordError detects common messages', () => {
  const mod = require('../dist/ssh/shell.js');
  assert.equal(mod.isSudoPasswordError('sudo: a password is required'), true);
  assert.equal(mod.isSudoPasswordError('something else'), false);
});
