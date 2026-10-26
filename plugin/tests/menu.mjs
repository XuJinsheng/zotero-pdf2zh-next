import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

test("toolkit 6 menu mounts in the supplied window and dispatches both commands", () => {
    const commands = [];
    let menu;
    const popup = { appendChild: (element) => (menu = element) };
    const document = {
        getElementById: (id) => {
            assert.equal(id, "zotero-itemmenu");
            return popup;
        },
    };
    const exports = {};
    const source = fs.readFileSync(
        new URL("../src/modules/pdf2zh.ts", import.meta.url),
        "utf8",
    );
    vm.runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
        {
            exports,
            require: () => ({ getString: (key) => key }),
            addon: {
                data: { config: { addonRef: "pdf2zhnext" } },
                hooks: { onDialogEvents: (command) => commands.push(command) },
            },
            ztoolkit: {
                UI: {
                    createElement: (target, tag, props) => {
                        assert.equal(target, document);
                        assert.equal(tag, "menu");
                        // `menu` also exists in HTML; toolkit defaults to HTML
                        // unless XUL is explicit. Children inherit this namespace.
                        assert.equal(props.namespace, "xul");
                        return props;
                    },
                },
            },
        },
    );
    exports.PDF2zhUIFactory.registerRightClickMenuItem({ document });
    const items = menu.children[0].children;
    assert.equal(items.length, 2);
    for (const item of items) {
        assert.equal(item.listeners[0].type, "command");
        item.listeners[0].listener();
    }
    assert.deepEqual(commands, ["translatePDF", "openTaskManager"]);
});
