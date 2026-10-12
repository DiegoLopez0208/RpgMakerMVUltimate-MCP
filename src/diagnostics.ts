import { access } from 'fs/promises';
import { resolveSafePath } from './utils/security.js';
import { validateProjectPath } from './utils/fileHandler.js';
import { findChromium } from './playtest/chromium.js';
import { loadPlaywright } from './playtest/session.js';

/** Read-only environment check; never starts a browser or exposes API keys/tokens. */
export async function diagnoseEnvironment(projectPath = process.env.RPGMAKER_PROJECT_PATH ?? '') {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeSupported = major > 20 || (major === 20 && minor >= 19);
  const projectValid = projectPath ? await validateProjectPath(projectPath) : false;
  const warnings: string[] = [];
  let chromium: string | null = null;
  let playwrightAvailable = false;
  try { chromium = findChromium(); } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  try { await loadPlaywright(); playwrightAvailable = true; } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  let bridgePluginInstalled = false;
  if (projectValid) {
    bridgePluginInstalled = await access(resolveSafePath(projectPath, 'js', 'plugins', 'McpBridge.js')).then(() => true, () => false);
  }
  if (!nodeSupported) warnings.push('Node.js 20.19.0 or newer is required.');
  if (!projectPath) warnings.push('Set RPGMAKER_PROJECT_PATH or pass a project directory after --doctor.');
  else if (!projectValid) warnings.push('Invalid MV System data or unsafe project path. A valid selection does not guarantee runnable assets/plugins.');
  if (!bridgePluginInstalled) warnings.push('Live bridge needs install_bridge_plugin, bridge_start and an NW.js playtest. Offline queries do not need it.');
  return {
    node: process.versions.node, nodeSupported, projectPath: projectPath || null, projectValid,
    coreReady: nodeSupported && projectValid,
    headlessReady: nodeSupported && projectValid && playwrightAvailable && chromium !== null,
    playwrightAvailable, chromium, bridgePluginInstalled,
    visionConfigured: Boolean(process.env.VISION_API_URL), warnings,
  };
}
