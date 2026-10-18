import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";

const html = fs.readFileSync(
    new URL("../addon/content/llmApiEditor.xhtml", import.meta.url),
    "utf8",
);
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join("\n");

function editor(data = {}) {
    const elements = new Map();
    const rows = [];
    const document = {
        addEventListener() {},
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, {
                    value: "",
                    checked: false,
                    hidden: false,
                    classList: {
                        toggle(name, hidden) {
                            elements.get(id).hidden = hidden;
                        },
                    },
                    reportValidity: () => true,
                    getElementsByClassName: () => rows,
                });
            }
            return elements.get(id);
        },
    };
    const window = { arguments: [{ data }], close() {} };
    const context = vm.createContext({ document, window });
    vm.runInContext(source, context);
    // Keep the real form load/save and service binding, stub unrelated history UI.
    vm.runInContext(
        `populateServiceOptions = updateModelOptions = updateUrlSelectOptions =
        updateApiKeyOptions = updateDocLink = checkAllDeleteButtons = saveUserHistory = () => {};
        addExtraFieldRow = (key, value) => addRow(key, value);`,
        Object.assign(context, {
            addRow(key, value) {
                rows.push({
                    querySelector: (selector) => ({
                        value: selector === ".extra-key" ? key : value,
                    }),
                });
            },
        }),
    );
    context.initializeForm();
    return {
        context,
        element: (id) => document.getElementById(id),
        rows,
        save() {
            context.saveLLMApi();
            return JSON.parse(JSON.stringify(window.arguments[0].result.data));
        },
    };
}

test("stream option loads and persists booleans for both services", () => {
    for (const [service, key] of [
        ["openai", "openai_stream"],
        ["openaicompatible", "openai_compatible_stream"],
    ]) {
        for (const enabled of [true, false, "true", "false"]) {
            const form = editor({
                service,
                extraData: { [key]: enabled, other: "keep" },
            });
            assert.equal(form.element("stream-options").hidden, false);
            assert.equal(
                form.element("stream").checked,
                String(enabled) === "true",
            );
            assert.equal(form.rows.length, 1);
            const saved = form.save();
            assert.equal(saved.extraData[key], String(enabled) === "true");
            assert.equal(saved.extraData.other, "keep");
            assert.equal(
                editor(saved).element("stream").checked,
                String(enabled) === "true",
            );
        }
    }
});

test("old profiles default off and service changes update visibility", () => {
    const form = editor({ service: "openai" });
    assert.equal(form.element("stream").checked, false);
    assert.equal(form.save().extraData.openai_stream, false);
    form.context.bindInputSelectValue("deepseek", "service");
    assert.equal(form.element("stream-options").hidden, true);
    assert.deepEqual(form.save().extraData, {});
    form.context.bindInputSelectValue("openaicompatible", "service");
    assert.equal(form.element("stream-options").hidden, false);
    assert.equal(form.save().extraData.openai_compatible_stream, false);
});

test("checkbox overrides duplicate extra parameters including normalized keys", () => {
    const form = editor({ service: "openai" });
    form.context.addRow("openai_stream", "true");
    form.context.addRow(" openai-stream ", "true");
    assert.deepEqual(form.save().extraData, { openai_stream: false });
});
