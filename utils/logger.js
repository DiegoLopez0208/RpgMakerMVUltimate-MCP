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

module.exports = {
  debug: function(msg, data) { log('debug', msg, data); },
  info: function(msg, data) { log('info', msg, data); },
  warn: function(msg, data) { log('warn', msg, data); },
  error: function(msg, data) { log('error', msg, data); },
  setLevel: function(level) { currentLevel = level; }
};
