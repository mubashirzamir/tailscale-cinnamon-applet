'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { MockGLib } = require('./mock-glib');

describe('_runTailscale (async)', () => {
  let glib;

  function _runTailscale(args, callback) {
    try {
      let [ok, argv] = glib.shell_parse_argv('pkexec tailscale ' + args);
      if (!ok) {
        if (callback) callback(false, 'Failed to parse command: ' + args);
        return;
      }

      let flags = glib.SpawnFlags.SEARCH_PATH | glib.SpawnFlags.DO_NOT_REAP_CHILD;
      let [success, pid] = glib.spawn_async(null, argv, null, flags, null);
      if (!success) {
        if (callback) callback(false, 'Failed to spawn tailscale');
        return;
      }

      glib.child_watch_add(glib.PRIORITY_DEFAULT, pid,
        function (pid, status) {
          let ok = glib.spawn_check_wait_status(status);
          if (callback) callback(ok, ok ? null : 'tailscale exited with status ' + status);
        }
      );
    } catch (e) {
      if (callback) callback(false, String(e));
    }
  }

  beforeEach(() => {
    glib = new MockGLib();
  });

  it('calls shell_parse_argv with "pkexec tailscale " + args', () => {
    glib.setParseResult(true, ['pkexec', 'tailscale', 'up', '--reset']);
    _runTailscale('up --reset', () => {});
    const call = glib.calls.find(c => c.method === 'shell_parse_argv');
    assert.ok(call, 'shell_parse_argv was not called');
    assert.strictEqual(call.command, 'pkexec tailscale up --reset');
  });

  it('calls callback(false, error) when shell_parse_argv fails', () => {
    glib.setParseResult(false, []);
    let called = false;
    _runTailscale('up --reset', (ok, msg) => {
      called = true;
      assert.strictEqual(ok, false);
      assert.ok(msg.includes('Failed to parse command'));
    });
    assert.ok(called, 'callback was not invoked');
  });

  it('calls spawn_async with parsed argv', () => {
    glib.setParseResult(true, ['pkexec', 'tailscale', 'down']);
    _runTailscale('down', () => {});
    const call = glib.calls.find(c => c.method === 'spawn_async');
    assert.ok(call, 'spawn_async was not called');
    assert.deepStrictEqual(call.argv, ['pkexec', 'tailscale', 'down']);
    assert.strictEqual(call.cwd, null);
  });

  it('calls callback(false, error) when spawn fails', () => {
    glib.setParseResult(true, ['tailscale', 'up']);
    glib.setSpawnResult(false);
    let called = false;
    _runTailscale('up', (ok, msg) => {
      called = true;
      assert.strictEqual(ok, false);
      assert.ok(msg.includes('Failed to spawn'));
    });
    assert.ok(called, 'callback was not invoked');
  });

  it('calls callback(true, null) on successful exit', () => {
    glib.setParseResult(true, ['tailscale', 'up']);
    glib.setChildExitStatus(0);
    let result;
    _runTailscale('up', (ok, msg) => { result = { ok, msg }; });
    glib.fireChildWatch();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.msg, null);
  });

  it('calls callback(false, statusMsg) on failed exit', () => {
    glib.setParseResult(true, ['tailscale', 'up']);
    glib.setChildExitStatus(1);
    let result;
    _runTailscale('up', (ok, msg) => { result = { ok, msg }; });
    glib.fireChildWatch();
    assert.strictEqual(result.ok, false);
    assert.ok(result.msg.includes('exited with status'));
  });

  it('calls child_watch_add to watch process exit', () => {
    glib.setParseResult(true, ['tailscale', 'status']);
    _runTailscale('status', () => {});
    const call = glib.calls.find(c => c.method === 'child_watch_add');
    assert.ok(call, 'child_watch_add was not called');
  });

  it('catches exceptions and calls callback with error', () => {
    glib.setParseResult(true, ['tailscale', 'up']);
    // make shell_parse_argv throw
    glib.shell_parse_argv = () => { throw new Error('unexpected error'); };
    let result;
    _runTailscale('up', (ok, msg) => { result = { ok, msg }; });
    assert.strictEqual(result.ok, false);
    assert.ok(result.msg.includes('unexpected error'));
  });
});
