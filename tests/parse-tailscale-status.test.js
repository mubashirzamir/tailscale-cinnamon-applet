'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('parseTailscaleStatus', () => {
  // Seam 1: parse raw tailscale status JSON into structured state
  function parseTailscaleStatus(jsonString) {
    try {
      let data = JSON.parse(jsonString);
      if (data.Self && data.Self.Online === true) {
        if (data.ExitNodeStatus && data.ExitNodeStatus.HostName) {
          return { state: 'up-exit', exitNode: data.ExitNodeStatus.HostName };
        }
        return { state: 'up', exitNode: null };
      }
    } catch (e) {
      // fall through
    }
    return { state: 'down', exitNode: null };
  }

  it('returns {state:"up", exitNode:null} when online with no exit node', () => {
    const json = JSON.stringify({
      Self: { Online: true },
    });
    const result = parseTailscaleStatus(json);
    assert.deepStrictEqual(result, { state: 'up', exitNode: null });
  });

  it('returns {state:"up-exit", exitNode:"nyc"} when online with exit node', () => {
    const json = JSON.stringify({
      Self: { Online: true },
      ExitNodeStatus: { HostName: 'nyc' },
    });
    const result = parseTailscaleStatus(json);
    assert.deepStrictEqual(result, { state: 'up-exit', exitNode: 'nyc' });
  });

  it('returns {state:"down", exitNode:null} when Self.Online is false', () => {
    const json = JSON.stringify({
      Self: { Online: false },
    });
    const result = parseTailscaleStatus(json);
    assert.deepStrictEqual(result, { state: 'down', exitNode: null });
  });

  it('returns {state:"down", exitNode:null} for invalid JSON', () => {
    const result = parseTailscaleStatus('not json');
    assert.deepStrictEqual(result, { state: 'down', exitNode: null });
  });
});
