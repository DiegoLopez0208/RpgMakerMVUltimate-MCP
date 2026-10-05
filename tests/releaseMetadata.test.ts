import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

// publish-registry.yml refuses a server.json that disagrees with package.json; 5.17.0 and
// 5.18.0 reached npm but never the MCP registry because server.json was not bumped with them.
describe('release metadata', () => {
  it('keeps both server.json versions equal to package.json', () => {
    const pkg = read('package.json');
    const server = read('server.json');
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.packages[0].identifier ?? server.packages[0].name).toBe(pkg.name);
  });

  it('has a CHANGELOG section for the version being released', () => {
    const version = read('package.json').version;
    expect(readFileSync('CHANGELOG.md', 'utf8')).toContain('## [' + version + ']');
  });
});
