import { readFileSync } from 'fs';
import path from 'path';
import { CompilerConfig } from '@ton/blueprint';

// LayerZero TON classlib root. Includes starting with "lz/" are
// resolved here; everything else relative to cwd (project root).
const LZ_TON = path.resolve(
    __dirname,
    '../arbitrum/lib/LayerZero-v2/packages/layerzero-v2/ton/src'
);

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['contracts/oapp/main.fc'],
    sources: (p: string) => {
        // FunC resolves #include relative to the source file's dir.
        // Our files live in contracts/oapp/, so an include written as
        // "lz/funC++/foo.fc" arrives here as "contracts/oapp/lz/funC++/foo.fc".
        // We strip everything up to and including the "lz/" marker, then
        // resolve the remainder against the LayerZero TON classlib root.
        // LZ's own internal includes use relative paths (no "lz/" prefix),
        // so they resolve correctly once the first file is found in LZ_TON.
        const lzPos = p.indexOf('/lz/');
        const resolved = lzPos !== -1 ? 'lz/' + p.slice(lzPos + 4) : p;
        return readFileSync(
            resolved.startsWith('lz/') ? path.join(LZ_TON, resolved.slice(3)) : resolved,
            'utf-8'
        );
    },
};
