// Every Service run starts a fresh com.apple.automator.runner XPC instance that stays idle after
// the workflow ends: 106 had piled up by 2026-10-20 (about 4 GB, each a LaunchServices app that
// the Dock and WindowServer track). They ignore SIGTERM, so SIGKILL the childless ones older than
// a minute. The calling run's own runner is an ancestor of this process and is never a candidate.
import { execFileSync } from 'node:child_process';

export const AUTOMATOR_RUNNER = '/System/Library/Frameworks/Automator.framework/Versions/A/XPCServices/com.apple.automator.runner.xpc/Contents/MacOS/com.apple.automator.runner';
const RUNNER_IDLE_MIN_SECONDS = 60;

type Deps = { readTable?: () => string; kill?: (pid: number) => void; selfPid?: number };

export function reapIdleAutomatorRunners(deps: Deps = {}): number[] {
  const readTable = deps.readTable ?? (() => String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,etime=,comm='], { encoding: 'utf8', timeout: 5_000 })));
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const reaped: number[] = [];
  try {
    const rows = readTable().split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), seconds: elapsedSeconds(match[3]), command: match[4] }] : [];
    });
    const parents = new Set(rows.map(({ ppid }) => ppid));
    const parentOf = new Map(rows.map(({ pid, ppid }) => [pid, ppid]));
    const ancestors = new Set<number>();
    for (let pid = deps.selfPid ?? process.pid; pid > 1 && !ancestors.has(pid); pid = parentOf.get(pid) ?? 0) ancestors.add(pid);
    for (const { pid, seconds, command } of rows) {
      if (command !== AUTOMATOR_RUNNER || parents.has(pid) || ancestors.has(pid) || seconds < RUNNER_IDLE_MIN_SECONDS) continue;
      try {
        kill(pid);
        reaped.push(pid);
      } catch {}
    }
  } catch {
    // Housekeeping only: never fail the shortcut over it.
  }
  return reaped;
}

// ps etime is [[dd-]hh:]mm:ss.
export function elapsedSeconds(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  return clock.split(':').map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
}
