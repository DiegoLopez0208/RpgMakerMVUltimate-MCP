// @ts-nocheck
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

var currentLevel = process.env.LOG_LEVEL || 'info';

function timestamp() {
  return new Date().toISOString();
}

function log(level, message, data) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  var prefix = '[' + timestamp() + '] [' + level.toUpperCase() + ']';
  if (data !== undefined) {
    console.error(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.error(prefix, message);
  }
}

export function debug(msg, data) { log('debug', msg, data); }
export function info(msg, data) { log('info', msg, data); }
export function warn(msg, data) { log('warn', msg, data); }
export function error(msg, data) { log('error', msg, data); }
export function setLevel(level) { currentLevel = level; }
