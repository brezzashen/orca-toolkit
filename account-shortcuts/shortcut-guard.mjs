// Native process locking serializes desktop shortcuts; claimed terminals stay single-use.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOCKED_ARGUMENT = '--shortcut-locked';
export const stateDirectory = () => join(homedir(), '.orca', 'account-shortcuts', 'runtime');

export async function runWithProcessLock(command, args, options = {}) {
  const directory = options.directory ?? stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'launch.lock');
  // -k keeps one inode for all waiters; the OS releases the lock when its owner exits.
  const child = spawn('/usr/bin/lockf', ['-k', '-s', '-t', '45', lock, command, ...args], {
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Shortcut lock owner exited with ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

// Call only while holding this directory's process lock.
export function createTerminalClaims(directory = stateDirectory()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'claimed-terminals.json');
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(entries) || entries.some(value => typeof value !== 'string')) {
      throw new Error('Invalid shortcut terminal claims; refusing to reuse a terminal.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = (environment, handle) => JSON.stringify([environment, handle]);
  const claimed = new Set(entries);
  return {
    has: (environment, handle) => claimed.has(key(environment, handle)),
    claim(environment, handle) {
      const value = key(environment, handle);
      if (claimed.has(value)) return false;
      const next = [...entries, value].slice(-4096);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, path);
      entries = next;
      claimed.add(value);
      return true;
    },
  };
}
