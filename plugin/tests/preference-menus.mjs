import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

function loadModule(file, globals, extra = "") {
    const source = fs.readFileSync(
        new URL(`../src/modules/${file}`, import.meta.url),
        "utf8",
    );
    const { outputText } = ts.transpileModule(source + extra, {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    });
    const exports = {};
    vm.runInNewContext(outputText, { exports, ...globals });
    return exports;
}

test("preferences register the mixed XUL/HTML fragment as XUL", () => {
    let registered;
    const { PDF2zhBasicFactory } = loadModule("pdf2zh.ts", {
        require: () => ({ getString: (key) => key }),
        addon: { data: { config: { addonID: "test", addonRef: "test" } } },
        rootURI: "chrome://test/",
        Zotero: {
            PreferencePanes: { register: (pane) => (registered = pane) },
        },
    });
    PDF2zhBasicFactory.registerPrefs();
    assert.equal(registered.defaultXUL, true);
});

test("language menus contain native items and restore saved selections on reload", () => {
    const prefs = { sourceLang: "ja", targetLang: "zh-TW" };
    const makeMenu = () => {
        const popup = {
            children: [],
            replaceChildren() {
                this.children = [];
            },
            appendChild(item) {
                this.children.push(item);
            },
        };
        return {
            popup,
            querySelector: () => popup,
            set value(value) {
                this.selectedItem = popup.children.find(
                    (item) => item.value === value,
                );
            },
        };
    };
    const source = makeMenu();
    const target = makeMenu();
    const doc = {
        getElementById: (id) =>
            ({ sourceLangSelect: source, targetLangSelect: target })[
                id.replace("zotero-prefpane-test-", "")
            ],
        querySelector: () => null,
        createXULElement: (tag) => {
            assert.equal(tag, "menuitem");
            return {
                setAttribute(key, value) {
                    this[key] = value;
                },
                cloneNode() {
                    return { value: this.value, label: this.label };
                },
            };
        },
    };
    const { bindPrefEvents } = loadModule(
        "preferenceScript.ts",
        {
            require: (name) => {
                if (name === "../../package.json") {
                    return { config: { addonRef: "test" } };
                }
                if (name === "../utils/prefs") {
                    return { getPref: (key) => prefs[key] };
                }
                return {};
            },
            addon: { data: { prefs: { window: { document: doc } } } },
        },
        "\nexport { bindPrefEvents };",
    );
    bindPrefEvents();
    assert.equal(source.selectedItem.label, "Japanese");
    assert.equal(target.selectedItem.label, "Traditional Chinese - Taiwan");
    assert.notEqual(
        source.selectedItem,
        target.popup.children.find((item) => item.value === "ja"),
    );
    const count = source.popup.children.length;
    prefs.sourceLang = "en";
    bindPrefEvents();
    assert.equal(source.popup.children.length, count);
    assert.equal(source.selectedItem.label, "English");
});
