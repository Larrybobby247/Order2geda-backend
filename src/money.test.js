import test from 'node:test'; import assert from 'node:assert';
import { closingThreshold, pct, shippingShare, naira } from './utils/money.js';
test('105% threshold', () => assert.equal(closingThreshold(naira(30000), 5), naira(31500)));
test('10% commission', () => assert.equal(pct(naira(20000), 10), naira(2000)));
test('shipping share', () => assert.equal(shippingShare(naira(1000), naira(20000), naira(100000)), naira(200)));
