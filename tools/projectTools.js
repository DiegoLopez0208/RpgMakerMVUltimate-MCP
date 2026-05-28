const { readdirSync } = require('fs');
const { readFile } = require('fs/promises');
const path = require('path');
const { getDataPath, validateProjectPath } = require('../utils/fileHandler');

var _currentProjectPath = '';

function getCurrentPath() {
  return _currentProjectPath;
}

function setCurrentPath(p) {
  _currentProjectPath = p;
}

async function getProjectSummary(projectPath) {
  var result = { projectPath: projectPath, dataFiles: {} };
  const dataDir = getDataPath(projectPath, '');
  var files = [];
  try { files = readdirSync(dataDir); } catch (e) { result.error = 'Cannot read data directory'; return result; }
  var jsonFiles = files.filter(function(f) { return f.endsWith('.json'); });
  for (var i = 0; i < jsonFiles.length; i++) {
    var fname = jsonFiles[i];
    try {
      var content = await readFile(getDataPath(projectPath, fname), 'utf-8');
      var parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        var nonNull = parsed.filter(function(e) { return e !== null; }).length;
        result.dataFiles[fname] = { type: 'array', total: parsed.length, entries: nonNull };
      } else if (typeof parsed === 'object') {
        result.dataFiles[fname] = { type: 'object', keys: Object.keys(parsed).length };
      }
    } catch (e) {
      result.dataFiles[fname] = { type: 'error', message: e.message };
    }
  }
  var systemPath = getDataPath(projectPath, 'System.json');
  try {
    var sysContent = await readFile(systemPath, 'utf-8');
    var sys = JSON.parse(sysContent);
    result.gameTitle = sys.gameTitle || '';
    result.startMapId = sys.startMapId;
    result.startX = sys.startX;
    result.startY = sys.startY;
    result.switchCount = sys.switches ? sys.switches.filter(function(s) { return s && s.length > 0; }).length : 0;
    result.variableCount = sys.variables ? sys.variables.filter(function(v) { return v && v.length > 0; }).length : 0;
  } catch (e) {
    result.systemError = 'Cannot read System.json';
  }
  var mapFiles = files.filter(function(f) { return /^Map\d{3}\.json$/.test(f); });
  result.mapCount = mapFiles.length;
  return result;
}

async function setProjectPath(newPath) {
  var valid = await validateProjectPath(newPath);
  if (!valid) throw new Error('Invalid project path: ' + newPath + '. Must contain data/System.json');
  _currentProjectPath = newPath;
  return { projectPath: newPath, valid: true };
}

module.exports = { getProjectSummary, setProjectPath, getCurrentPath, setCurrentPath, getProjectPath: getCurrentPath, initProjectPath: setCurrentPath };
