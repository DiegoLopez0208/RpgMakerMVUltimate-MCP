import { describe, it, expect } from 'vitest';
import {
  parsePluginAnnotations,
  parsePluginsJs,
  defaultAnnotationBlock,
  mergePluginRegistries,
} from '../../src/parity/validation/pluginManifest.js';

/** A faithful copy of the official ButtonPicture.js header (MZ sample plugin). */
const BUTTON_PICTURE = `//=============================================================================
// RPG Maker MZ - Button Picture
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Makes a picture clickable.
 * @author Yoji Ojima
 *
 * @help ButtonPicture.js
 *
 * This plugin provides a command to call a common event when a picture is
 * clicked.
 *
 * @command set
 * @text Set Button Picture
 * @desc Makes the specified picture clickable.
 *
 * @arg pictureId
 * @type number
 * @min 1
 * @max 100
 * @default 1
 * @text Picture Number
 * @desc Control number of the picture.
 *
 * @arg commonEventId
 * @type common_event
 * @default 1
 * @text Common Event
 * @desc Common event to call when the picture is clicked.
 */

/*:ja
 * @target MZ
 * @plugindesc ピクチャをクリック可能にします。
 * @author Yoji Ojima
 *
 * @command set
 * @text ボタンピクチャの設定
 * @desc 指定したピクチャをクリック可能にします。
 *
 * @arg pictureId
 * @text ピクチャ番号
 */

(() => {});
`;

describe('parsePluginAnnotations', () => {
  it('reads a real MZ sample plugin: commands, args, types and defaults', () => {
    const spec = parsePluginAnnotations(BUTTON_PICTURE)!;

    expect(spec.description).toBe('Makes a picture clickable.');
    expect(Object.keys(spec.commands)).toEqual(['set']);

    const set = spec.commands.set;
    expect(set.label).toBe('Set Button Picture');
    expect(set.description).toBe('Makes the specified picture clickable.');
    expect(set.args).toEqual([
      {
        name: 'pictureId',
        type: 'number',
        default: '1',
        text: 'Picture Number',
        description: 'Control number of the picture.',
      },
      {
        name: 'commonEventId',
        type: 'common_event',
        default: '1',
        text: 'Common Event',
        description: 'Common event to call when the picture is clicked.',
      },
    ]);
  });

  it('never infers `required` (MZ has no such annotation)', () => {
    const spec = parsePluginAnnotations(BUTTON_PICTURE)!;
    for (const arg of spec.commands.set.args ?? []) {
      expect(arg.required).toBeUndefined();
    }
  });

  it('ignores the localized /*:ja block so its @text cannot win', () => {
    const spec = parsePluginAnnotations(BUTTON_PICTURE)!;
    expect(spec.commands.set.label).toBe('Set Button Picture');
    expect(spec.commands.set.args?.[0].text).toBe('Picture Number');
  });

  it('does not attach a plugin @param to the preceding command', () => {
    const source = `/*:
 * @plugindesc Test
 * @command go
 * @text Go
 *
 * @param speed
 * @text Speed Setting
 * @desc A plugin parameter, not a command arg.
 *
 * @arg stray
 */
`;
    const spec = parsePluginAnnotations(source)!;
    expect(spec.commands.go.label).toBe('Go');
    // The @param closed the command scope, so neither its @text nor the @arg
    // that follows may leak onto `go`.
    expect(spec.commands.go.description).toBeUndefined();
    expect(spec.commands.go.args).toBeUndefined();
  });

  it('keeps a run of args attached to their command across @help', () => {
    const source = `/*:
 * @plugindesc Test
 *
 * @command a
 * @arg one
 * @arg two
 *
 * @command b
 * @arg three
 */
`;
    const spec = parsePluginAnnotations(source)!;
    expect(spec.commands.a.args?.map((x) => x.name)).toEqual(['one', 'two']);
    expect(spec.commands.b.args?.map((x) => x.name)).toEqual(['three']);
  });

  it('returns a spec with no commands for an annotated plugin that registers none', () => {
    const spec = parsePluginAnnotations(`/*:
 * @plugindesc Just a tweak.
 * @author Someone
 */
`)!;
    expect(spec.description).toBe('Just a tweak.');
    expect(spec.commands).toEqual({});
  });

  it('returns null when there is no default-locale annotation block', () => {
    expect(parsePluginAnnotations('// just code\n(() => {})();')).toBeNull();
    // A Japanese-only block is not a default block.
    expect(parsePluginAnnotations('/*:ja\n * @plugindesc x\n */')).toBeNull();
  });

  it('does not mistake a struct definition for the annotation block', () => {
    const source = `/*~struct~Item:
 * @param name
 */

/*:
 * @plugindesc Real block.
 * @command go
 */
`;
    const spec = parsePluginAnnotations(source)!;
    expect(spec.description).toBe('Real block.');
    expect(Object.keys(spec.commands)).toEqual(['go']);
  });
});

describe('defaultAnnotationBlock', () => {
  it('picks the untagged block even when a localized one comes first', () => {
    const block = defaultAnnotationBlock(
      '/*:ja\n * @plugindesc JA\n */\n/*:\n * @plugindesc EN\n */',
    );
    expect(block).toContain('@plugindesc EN');
    expect(block).not.toContain('JA');
  });
});

describe('mergePluginRegistries', () => {
  const builtin = {
    TextPicture: {
      description: 'Curated.',
      commands: {
        set: {
          label: 'Curated label',
          args: [{ name: 'text', required: true, description: 'Curated desc.' }],
        },
      },
    },
  };

  it('keeps the curated `required` that annotations cannot express', () => {
    const scanned = {
      TextPicture: {
        description: 'Displays text as a picture.',
        enabled: true,
        commands: {
          set: {
            label: 'Set Text Picture',
            args: [{ name: 'text', type: 'multiline_string' }],
          },
        },
      },
    };

    const merged = mergePluginRegistries(builtin, scanned);
    const arg = merged.TextPicture.commands.set.args![0];
    // Scan wins on structure...
    expect(arg.type).toBe('multiline_string');
    expect(merged.TextPicture.commands.set.label).toBe('Set Text Picture');
    expect(merged.TextPicture.enabled).toBe(true);
    // ...but the curated knowledge survives.
    expect(arg.required).toBe(true);
    expect(arg.description).toBe('Curated desc.');
  });

  it('lets a scan add plugins and commands the allowlist never knew', () => {
    const merged = mergePluginRegistries(builtin, {
      ButtonPicture: { commands: { set: { label: 'Set Button Picture' } }, enabled: false },
    });
    expect(Object.keys(merged).sort()).toEqual(['ButtonPicture', 'TextPicture']);
    // The untouched curated entry is preserved as-is.
    expect(merged.TextPicture.commands.set.args![0].required).toBe(true);
  });

  it('keeps curated args when the scan found none for that command', () => {
    const merged = mergePluginRegistries(builtin, {
      TextPicture: { commands: { set: { label: 'Set Text Picture' } } },
    });
    expect(merged.TextPicture.commands.set.args).toEqual([
      { name: 'text', required: true, description: 'Curated desc.' },
    ]);
  });
});

describe('parsePluginsJs', () => {
  it('reads the editor-generated manifest', () => {
    const source = `// Generated by RPG Maker.
// Do not edit this file directly.
var $plugins =
[
{"name":"ButtonPicture","status":true,"description":"Makes a picture clickable.","parameters":{}},
{"name":"TextPicture","status":false,"description":"Draws text.","parameters":{}}
];`;
    expect(parsePluginsJs(source)).toEqual([
      { name: 'ButtonPicture', status: true, description: 'Makes a picture clickable.' },
      { name: 'TextPicture', status: false, description: 'Draws text.' },
    ]);
  });

  it('handles the empty manifest a fresh project ships', () => {
    expect(parsePluginsJs('var $plugins =\n[\n];')).toEqual([]);
  });

  it('fails soft on an unparseable manifest', () => {
    expect(parsePluginsJs('var $plugins = [ not json ];')).toEqual([]);
    expect(parsePluginsJs('nonsense')).toEqual([]);
  });
});
