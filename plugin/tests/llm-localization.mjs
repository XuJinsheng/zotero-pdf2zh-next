import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";
import ts from "typescript";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../addon/content/llmApiEditor.xhtml");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join("\n");
const editorKeys = new Set([
    ...[
        ...html.matchAll(/data-editor-(?:text|placeholder|title)="([^"]+)"/g),
    ].map((match) => match[1]),
    ...[...html.matchAll(/editorText\("([^"]+)"/g)].map((match) => match[1]),
]);

function locale(lang) {
    const messages = new Map(
        [
            ...read(`../addon/locale/${lang}/addon.ftl`).matchAll(
                /^([a-z][a-z0-9-]*) = (.*)$/gm,
            ),
        ].map((match) => [match[1], match[2]]),
    );
    const exports = {};
    vm.runInNewContext(
        ts.transpileModule(read("../src/utils/locale.ts"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
        {
            exports,
            require: () => ({ config: { addonRef: "test" } }),
            addon: {
                data: {
                    locale: {
                        current: {
                            formatMessagesSync: (requests) =>
                                requests.map(({ id, args }) => ({
                                    value: messages
                                        .get(id.replace(/^test-/, ""))
                                        ?.replace(
                                            /\{ \$([a-z]+) \}/g,
                                            (_match, name) => args[name],
                                        ),
                                })),
                        },
                    },
                },
            },
        },
    );
    return { getString: exports.getString, messages };
}

for (const lang of ["zh-CN", "en-US"]) {
    test(`${lang} supplies every editor message and applies text, placeholders and tooltips`, () => {
        const { getString, messages } = locale(lang);
        for (const key of editorKeys)
            assert.ok(messages.has(key), `Missing ${lang}: ${key}`);
        const attributes = ["text", "placeholder", "title"];
        const nodes = attributes.map((attribute) => ({
            attribute,
            getAttribute: () => "llm-editor-name",
            setAttribute(name, value) {
                this[name] = value;
            },
        }));
        const context = vm.createContext({
            document: {
                addEventListener() {},
                querySelectorAll: (selector) =>
                    nodes.filter(
                        (node) =>
                            selector === `[data-editor-${node.attribute}]`,
                    ),
            },
            window: { arguments: [{ getString }] },
        });
        vm.runInContext(script, context);
        context.localizeEditor();
        const expected =
            lang === "zh-CN"
                ? "LLM \u670d\u52a1\u540d\u79f0"
                : "LLM service name";
        assert.equal(nodes[0].textContent, expected);
        assert.equal(nodes[1].placeholder, expected);
        assert.equal(nodes[2].title, expected);
        assert.ok(
            !context
                .editorText("llm-editor-confirm-delete", { service: "example" })
                .includes("$service"),
        );
        if (lang === "en-US") {
            for (const key of editorKeys)
                assert.doesNotMatch(messages.get(key), /[\p{Script=Han}]/u);
        }
    });
}

test("language resources have matching LLM keys and contain no bilingual labels", () => {
    const zh = locale("zh-CN").messages;
    const en = locale("en-US").messages;
    assert.deepEqual(
        [...zh.keys()].filter((key) => key.startsWith("llm-")).sort(),
        [...en.keys()].filter((key) => key.startsWith("llm-")).sort(),
    );
    for (const value of zh.values())
        assert.doesNotMatch(value, /[\p{Script=Han}].* \/ [A-Za-z]/u);
    assert.doesNotMatch(
        read("../addon/locale/zh-CN/preferences.ftl"),
        /[\uff08(](name|provider|modelname)[\uff09)]/,
    );
});
