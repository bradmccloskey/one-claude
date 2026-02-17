'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeSemaphore, claudeP, claudePWithSemaphore, _semaphore } = require('../lib/exec');

describe('ClaudeSemaphore', () => {
  it('allows up to maxConcurrent simultaneous acquires', async () => {
    const sem = new ClaudeSemaphore(2);

    await sem.acquire();
    await sem.acquire();

    assert.equal(sem.active, 2);
    assert.equal(sem.pending, 0);

    sem.release();
    sem.release();

    assert.equal(sem.active, 0);
  });

  it('third acquire waits until release', async () => {
    const sem = new ClaudeSemaphore(2);

    await sem.acquire();
    await sem.acquire();
    assert.equal(sem.active, 2);

    // Third acquire should NOT resolve immediately
    let thirdResolved = false;
    const thirdPromise = sem.acquire().then(() => {
      thirdResolved = true;
    });

    // Yield to microtask queue so .then runs if it was going to
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(thirdResolved, false, 'third acquire should be pending');
    assert.equal(sem.pending, 1);

    // Release one slot -- third should resolve
    sem.release();
    await thirdPromise;

    assert.equal(thirdResolved, true);
    assert.equal(sem.active, 2);
    assert.equal(sem.pending, 0);

    // Cleanup
    sem.release();
    sem.release();
  });

  it('release resolves waiters in FIFO order', async () => {
    const sem = new ClaudeSemaphore(1);
    const order = [];

    await sem.acquire();

    // Queue two waiters in order
    const promiseA = sem.acquire().then(() => order.push('A'));
    const promiseB = sem.acquire().then(() => order.push('B'));

    assert.equal(sem.pending, 2);

    // Release first slot -- A should resolve first
    sem.release();
    await promiseA;
    assert.deepEqual(order, ['A']);

    // Release again -- B should resolve
    sem.release();
    await promiseB;
    assert.deepEqual(order, ['A', 'B']);

    // Cleanup
    sem.release();
  });

  it('exports expected module interface', () => {
    assert.equal(typeof claudeP, 'function');
    assert.equal(typeof claudePWithSemaphore, 'function');
    assert.equal(typeof ClaudeSemaphore, 'function');
    assert.ok(_semaphore instanceof ClaudeSemaphore);
    assert.equal(_semaphore._max, 2, 'singleton semaphore should have max=2');
  });
});
