import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOMATOR_RUNNER, elapsedSeconds, reapIdleAutomatorRunners } from './runner-reaper.ts';

test('elapsedSeconds reads every ps etime form', () => {
  assert.equal(elapsedSeconds('00:59'), 59);
  assert.equal(elapsedSeconds('01:02:03'), 3723);
  assert.equal(elapsedSeconds('2-00:00:01'), 172801);
});

test('reaps only childless runners older than a minute that are not the caller', () => {
  const table = [
    `  1     0 5-00:00:00 /sbin/launchd`,
    ` 10     1   22:31:07 ${AUTOMATOR_RUNNER}`, // idle: reaped
    ` 11     1      00:30 ${AUTOMATOR_RUNNER}`, // too young: may still be starting its workflow
    ` 12     1      05:00 ${AUTOMATOR_RUNNER}`, // has a child shell: still running a workflow
    ` 13    12      04:59 /bin/zsh`,
    ` 20     1      03:00 ${AUTOMATOR_RUNNER}`, // the caller's own runner
    ` 21    20      00:02 /bin/zsh`,
    ` 22    21      00:01 /Users/alice/.local/node/bin/node`,
    ` 30     1      10:00 /Applications/Other.app/Contents/MacOS/Other`,
  ].join('\n');
  const killed: number[] = [];
  const reaped = reapIdleAutomatorRunners({ readTable: () => table, kill: (pid) => killed.push(pid), selfPid: 22 });
  assert.deepEqual(reaped, [10]);
  assert.deepEqual(killed, [10]);
});

test('a failing process table never throws', () => {
  assert.deepEqual(reapIdleAutomatorRunners({ readTable: () => { throw new Error('ps timed out'); }, kill: () => assert.fail('no kill') }), []);
});
