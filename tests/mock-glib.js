'use strict';

class MockGLib {
  constructor() {
    this.reset();
    this.PRIORITY_DEFAULT = 0;
    this.SpawnFlags = { SEARCH_PATH: 1, DO_NOT_REAP_CHILD: 2 };
  }

  reset() {
    this.calls = [];
    this._parseResult = [true, []];
    this._spawnResult = [true];
    this._childExitStatus = 0;
    this._childWatchCallbacks = [];
    this._nextPid = 1000;
    this._nextSourceId = 100;
  }

  setParseResult(ok, argv) {
    this._parseResult = [ok, argv];
  }

  setSpawnResult(ok) {
    this._spawnResult = [ok];
  }

  setChildExitStatus(status) {
    this._childExitStatus = status;
  }

  fireChildWatch() {
    const cbs = this._childWatchCallbacks.slice();
    this._childWatchCallbacks = [];
    for (const cb of cbs) {
      cb(0, this._childExitStatus);
    }
  }

  shell_parse_argv(command) {
    this.calls.push({ method: 'shell_parse_argv', command });
    return this._parseResult;
  }

  spawn_async(cwd, argv, env, flags, childSetup, userData) {
    this.calls.push({ method: 'spawn_async', cwd, argv, env, flags });
    if (!this._spawnResult[0]) return [false];
    const pid = this._nextPid++;
    return [true, pid];
  }

  get_current_dir() {
    return '/tmp';
  }

  child_watch_add(priority, pid, callback) {
    this.calls.push({ method: 'child_watch_add', priority, pid });
    const sourceId = this._nextSourceId++;
    this._childWatchCallbacks.push(callback);
    return sourceId;
  }

  spawn_check_wait_status(status) {
    this.calls.push({ method: 'spawn_check_wait_status', status });
    return status === 0;
  }
}

module.exports = { MockGLib };
