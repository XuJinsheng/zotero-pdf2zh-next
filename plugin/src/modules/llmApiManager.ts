import { getPref, setPref } from "../utils/prefs";

export interface LLMServiceConfig {
    name: string;
    models?: string[];
    urls?: string[];
    extraData?: any[];
}

export interface RuntimeSettings {
    qps?: number;
    poolSize?: number;
    retryCount?: number;
    retryInterval?: number;
}

export function resolveRuntimeSettings(
    defaults: Record<keyof RuntimeSettings, string>,
    overrides?: RuntimeSettings,
): Record<keyof RuntimeSettings, string> {
    return {
        qps: String(overrides?.qps ?? defaults.qps),
        poolSize: String(overrides?.poolSize ?? defaults.poolSize),
        retryCount: String(overrides?.retryCount ?? defaults.retryCount),
        retryInterval: String(
            overrides?.retryInterval ?? defaults.retryInterval,
        ),
    };
}

export interface LLMApiData {
    key: string;
    service: string;
    apiKey: string;
    apiUrl: string;
    model: string;
    name: string;
    runtime?: RuntimeSettings;
    extraData?: Record<string, any>;
}

export const emptyLLMApi: LLMApiData = {
    key: "",
    service: "",
    apiKey: "",
    apiUrl: "",
    model: "",
    name: "",
    extraData: {},
};

class LLMApiManager {
    private data = new Map<string, LLMApiData>();
    public updateLLMApi(llmApi: LLMApiData): string {
        let key = llmApi.key;
        if (!key) {
            key = Zotero.Utilities.generateObjectKey();
            llmApi.key = key;
        }
        this.data.set(key, llmApi);
        return key;
    }
    public clear(): void {
        this.data.clear();
    }

    public getLLMApi(key: string): LLMApiData | undefined {
        return this.data.get(key);
    }

    public getAllLLMApis(): LLMApiData[] {
        return Array.from(this.data.values());
    }

    public deleteLLMApi(key: string): boolean {
        return this.data.delete(key);
    }
}

export const llmApiManager = new LLMApiManager();
export function getAllLLMApiConfigs(): LLMApiData[] {
    return llmApiManager.getAllLLMApis();
}

export function validateLLMApiName(
    name: string,
    entries: LLMApiData[],
    key?: string,
): string {
    const trimmed = name.trim();
    if (!trimmed) return "llm-name-required";
    if (entries.some((entry) => entry.key !== key && entry.name === trimmed)) {
        return "llm-name-duplicate";
    }
    return "";
}

export function migrateLLMProfiles(
    entries: (LLMApiData & { activate?: boolean })[],
    legacyService: string,
) {
    const valid = entries.filter((entry) => entry.key && entry.service);
    const matching = valid.filter(
        (entry) =>
            normalizeServiceName(entry.service) ===
            normalizeServiceName(legacyService),
    );
    const selectedKey =
        (matching.find((entry) => entry.activate) || matching[0])?.key || "";
    const used = new Set(
        valid
            .filter((entry) => entry.name?.trim())
            .map((entry) => entry.name.trim()),
    );
    const profiles = valid.map((entry) => {
        const { activate: _activate, ...profile } = entry;
        profile.service = normalizeServiceName(profile.service);
        profile.name = profile.name?.trim() || "";
        if (!profile.name) {
            const base = profile.model
                ? `${profile.service} / ${profile.model}`
                : profile.service;
            let name = base;
            let number = 2;
            while (used.has(name)) name = `${base} (${number++})`;
            profile.name = name;
            used.add(name);
        }
        profile.extraData ||= {};
        return profile;
    });
    return { profiles, selectedKey };
}

// 辅助函数：从表单数据创建 LLM API 数据
export function createLLMApiFromFormData(
    formData: Partial<LLMApiData> & {
        serviceselect?: string;
        modelselect?: string;
    },
): LLMApiData {
    return {
        key: formData.key || "",
        service: normalizeServiceName(
            formData.service || formData.serviceselect || "",
        ),
        apiKey: formData.apiKey || "",
        apiUrl: formData.apiUrl || "",
        model: formData.model || formData.modelselect || "",
        name: (formData.name || "").trim(),
        runtime: formData.runtime,
        extraData: formData.extraData || {},
    };
}

// 格式化 extraData 为显示字符串
export function formatExtraDataForDisplay(
    extraData?: Record<string, any>,
): string {
    if (!extraData || typeof extraData !== "object") {
        return "";
    }
    const pairs: string[] = [];
    for (const [key, value] of Object.entries(extraData)) {
        if (key && key.trim()) {
            // 截断长值以保持表格整洁
            const text = String(value || "");
            const displayValue =
                text.length > 10 ? text.substring(0, 10) + "..." : text;
            pairs.push(`${key}=${displayValue}`);
        }
    }
    // 限制总长度，避免表格列过宽
    const result = pairs.join(", ");
    return result.length > 50 ? result.substring(0, 47) + "..." : result;
}

function normalizeServiceName(value: string): string {
    return value.trim().toLowerCase().replace(/[-_]/g, "");
}

export function saveLLMApisToPrefs() {
    setPref("llmApis", JSON.stringify(llmApiManager.getAllLLMApis()));
}

export function loadLLMApisFromPrefs() {
    const llmApisJson = getPref("llmApis");
    llmApiManager.clear();
    if (!llmApisJson || typeof llmApisJson !== "string") {
        setPref("selectedLLMApiKey", "");
        setPref("llmSelectionMigrated", true);
        return;
    }
    try {
        const llmApisArray = JSON.parse(llmApisJson);
        if (!Array.isArray(llmApisArray)) {
            return;
        }
        const { profiles, selectedKey } = migrateLLMProfiles(
            llmApisArray,
            getPref("service")?.toString() || "siliconflowfree",
        );
        if (!getPref("llmSelectionMigrated")) {
            setPref("selectedLLMApiKey", selectedKey);
            setPref("llmSelectionMigrated", true);
        }
        const selected = getPref("selectedLLMApiKey")?.toString() || "";
        if (selected && !profiles.some((entry) => entry.key === selected))
            setPref("selectedLLMApiKey", "");
        profiles.forEach((llmApi) => {
            llmApiManager.updateLLMApi(llmApi);
        });
        const migratedJson = JSON.stringify(profiles);
        if (migratedJson !== llmApisJson) setPref("llmApis", migratedJson);
    } catch (error) {
        ztoolkit.log("Error loading LLM APIs from prefs:", error);
    }
}

export function getSelectedLLMApi(): LLMApiData | undefined {
    loadLLMApisFromPrefs();
    return llmApiManager.getLLMApi(
        getPref("selectedLLMApiKey")?.toString() || "",
    );
}
