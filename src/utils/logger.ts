import type { LogLevel } from '../types/rpgmaker.js';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = (process.env.LOG_LEVEL || 'info') as LogLevel;

function timestamp() {
  return new Date().toISOString();
}

function log(level: LogLevel, message: string, data?: unknown) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const prefix = '[' + timestamp() + '] [' + level.toUpperCase() + ']';
  if (data !== undefined) {
    console.error(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.error(prefix, message);
  }
}

export function debug(msg: string, data?: unknown) { log('debug', msg, data); }
export function info(msg: string, data?: unknown) { log('info', msg, data); }
export function warn(msg: string, data?: unknown) { log('warn', msg, data); }
export function error(msg: string, data?: unknown) { log('error', msg, data); }
export function setLevel(level: LogLevel) { currentLevel = level; }
