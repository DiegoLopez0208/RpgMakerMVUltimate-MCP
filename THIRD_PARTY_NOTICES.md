# Third-party notices

The event-command builders and validation workflow in
`src/utils/eventCommandBuilders.ts`, `src/utils/eventCommandValidation.ts`, and
their tests adapt patterns from [Redseb/rpgmaker-mz-mcp](https://github.com/Redseb/rpgmaker-mz-mcp),
reviewed at commit `7e8dcc09684f0e627ef31dfd69929401f5bff5f2`.
They have been adapted to RPG Maker MV's command format and interpreter behavior.

The additional authoring, database, tile, validation, deployment and headless
runtime modules in `src/parity/`, associated parity tests, the
`skill/mv-tileset-catalog/` helpers, and selected formula/analysis and bridge
hardening patterns also adapt that project, reviewed at commit
`c863b4d4e10209391ab7a112cfcd36107d36f020`. MV-specific command layouts, engine
APIs, tile fingerprinting and raw-text plugin commands replace MZ assumptions.
The license below applies to these adaptations as well.

## RPG Maker MZ MCP — MIT License

Copyright (c) 2026 Mikolaj Zyzanski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The optional runtime verification script reads the user's local RPG Maker MV
engine installation. No RPG Maker engine source or purchased assets are included
in this repository or package.
