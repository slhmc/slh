import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseVersion } from './release-version.mjs';

test('renders numeric hotfix components in public release tags', () => {
  assert.equal(releaseVersion('0.2.2+1.2.3'), '0.2.2.1.2.3');
  assert.equal(releaseVersion('0.2.2-rc.1+1.2'), '0.2.2.1.2-rc.1');
  assert.equal(releaseVersion('0.2.2+build.4'), '0.2.2+build.4');
  assert.equal(releaseVersion('0.2.3'), '0.2.3');
});
