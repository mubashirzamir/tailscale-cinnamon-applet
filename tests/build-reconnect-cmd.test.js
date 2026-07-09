'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('buildReconnectCmd', () => {
  // Seam 2: given toggle target + known exit node, return the right command
  function buildReconnectCmd(isOn, activeExitNode) {
    if (!isOn) return 'down';
    if (activeExitNode) {
      return 'up --exit-node=' + activeExitNode + ' --exit-node-allow-lan-access=true --accept-routes';
    }
    return 'up --reset --accept-routes';
  }

  it('returns "down" when toggling off', () => {
    const cmd = buildReconnectCmd(false, null);
    assert.strictEqual(cmd, 'down');
  });

  it('includes --reset when toggling on with no known exit node', () => {
    const cmd = buildReconnectCmd(true, null);
    assert.ok(cmd.includes('--reset'));
    assert.ok(cmd.includes('--accept-routes'));
  });

  it('includes --exit-node=<node> when toggling on with known exit node', () => {
    const cmd = buildReconnectCmd(true, 'nyc');
    assert.ok(cmd.includes('--exit-node=nyc'));
    assert.ok(cmd.includes('--exit-node-allow-lan-access=true'));
    assert.ok(!cmd.includes('--reset'));
  });
});
