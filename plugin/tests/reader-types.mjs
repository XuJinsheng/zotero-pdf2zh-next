import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

test("Zotero reader declarations resolve their directly managed EPUB and PDF types", () => {
    const entry = fs.realpathSync(require.resolve("zotero-types/package.json"));
    const declarationFiles = [
        entry.replace("package.json", "types/reader/dom/epub/epubjs.d.ts"),
        entry.replace("package.json", "types/reader/pdf/pdfjs.d.ts"),
    ];
    const resolved = new Set();
    for (const file of declarationFiles) {
        const source = fs.readFileSync(file, "utf8");
        for (const [, name] of source.matchAll(/import\("([^"]+)"\)/g)) {
            const result = ts.resolveModuleName(
                name,
                file,
                { moduleResolution: ts.ModuleResolutionKind.Node10 },
                ts.sys,
            ).resolvedModule;
            assert.ok(result, `${name} must resolve from ${file}`);
            assert.equal(result.extension, ts.Extension.Dts);
            resolved.add(name.split("/")[0]);
        }
    }
    assert.deepEqual([...resolved].sort(), ["epubjs", "pdfjs-dist"]);
});
