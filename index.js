const { app, action, core } = require("photoshop");
const { storage } = require("uxp").storage;
const fs = require("uxp").storage.localFileSystem;

const DESCRIPTOR_JSON_PATH = "parsed_neural_output.json";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".tif",
    ".tiff",
    ".psd",
    ".psb",
    ".webp"
]);

const STYLE_ALIASES = {
    "ast-hokusai": ["ast-hokusai"],
    "wave": ["wave", "wave_2048", "wave_1024"],
    "wave_2048": ["wave_2048", "wave"],
    "wave_1024": ["wave_1024", "wave"]
};

let inputFolder = null;
let outputFolder = null;
let shouldCancel = false;
let descriptorCache = null;

// Keep this listener enabled so a fresh executable Neural Filter descriptor can be captured.
action.addNotificationListener(["neuralGalleryFilters", "invokeCommand"], (event, descriptor) => {
    console.log("Neural filter event:", event);
    console.log("Neural filter descriptor:", JSON.stringify(descriptor, null, 2));
});

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("select-input-folder-btn").addEventListener("click", selectInputFolder);
    document.getElementById("select-output-folder-btn").addEventListener("click", selectOutputFolder);
    document.getElementById("process-folder-btn").addEventListener("click", () => {
        core.executeAsModal(processFolder, { commandName: "JPEG 5000 Batch Style Transfer" });
    });
    document.getElementById("cancel-btn").addEventListener("click", () => {
        shouldCancel = true;
        updateProgressText("Cancel requested. Current image will finish first...");
    });
});

async function selectInputFolder() {
    try {
        const folder = await fs.getFolder();
        if (!folder) {
            return;
        }
        inputFolder = folder;
        document.getElementById("input-folder-name").textContent = folder.nativePath || folder.name;
        showResult(`Input folder selected: ${folder.name}`, false);
    } catch (error) {
        showError("Failed to select input folder: " + error.message);
    }
}

async function selectOutputFolder() {
    try {
        const folder = await fs.getFolder();
        if (!folder) {
            return;
        }
        outputFolder = folder;
        document.getElementById("output-folder-name").textContent = folder.nativePath || folder.name;
        showResult(`Output folder selected: ${folder.name}`, false);
    } catch (error) {
        showError("Failed to select output folder: " + error.message);
    }
}

async function processFolder() {
    if (!inputFolder) {
        showError("Choose an input folder first.");
        return;
    }
    if (!outputFolder) {
        showError("Choose an output folder first.");
        return;
    }

    const styleName = document.getElementById("style-select").value;
    const processButton = document.getElementById("process-folder-btn");
    const cancelButton = document.getElementById("cancel-btn");
    const results = [];

    shouldCancel = false;
    processButton.disabled = true;
    cancelButton.disabled = false;
    showProgress();

    try {
        updateProgress(0, 100, "Loading Style Transfer descriptor data...");
        await loadDescriptorData();

        const imageFiles = await getImageFiles(inputFolder);
        if (imageFiles.length === 0) {
            showError("No supported images found in the input folder.");
            return;
        }

        for (let i = 0; i < imageFiles.length; i++) {
            if (shouldCancel) {
                results.push({ name: "Batch", ok: false, error: "Cancelled by user" });
                break;
            }

            const file = imageFiles[i];
            const current = i + 1;
            updateProgress(current - 1, imageFiles.length, `Opening ${file.name} (${current}/${imageFiles.length})...`);

            try {
                await processOneFile(file, styleName, current, imageFiles.length);
                results.push({ name: file.name, ok: true });
            } catch (error) {
                console.error(`Failed processing ${file.name}:`, error);
                results.push({ name: file.name, ok: false, error: error.message });
                await closeActiveDocumentNoSave().catch(closeError => console.warn("Close after failure failed:", closeError));
            }
        }

        updateProgress(imageFiles.length, imageFiles.length, "Batch complete.");
        showBatchSummary(results);
    } catch (error) {
        console.error("Batch processing failed:", error);
        showError("Batch failed: " + error.message);
    } finally {
        processButton.disabled = false;
        cancelButton.disabled = true;
    }
}

async function processOneFile(file, styleName, current, total) {
    await openFile(file);
    await sleep(700);

    updateProgress(current - 0.75, total, `Selecting subject in ${file.name}...`);
    await selectSubject();
    await sleep(300);

    updateProgress(current - 0.5, total, `Applying Style Transfer (${styleName}) to ${file.name}...`);
    await applyStyleTransfer(styleName);
    await sleep(1200);

    updateProgress(current - 0.25, total, `Saving ${file.name}...`);
    await saveActiveDocumentAsPng(outputFolder, makeOutputName(file.name));
    await closeActiveDocumentNoSave();
}

async function getImageFiles(folder) {
    const entries = await folder.getEntries();
    return entries
        .filter(entry => entry.isFile && SUPPORTED_IMAGE_EXTENSIONS.has(getExtension(entry.name)))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function openFile(file) {
    const token = await fs.createSessionToken(file);
    await action.batchPlay([
        {
            _obj: "open",
            target: {
                _path: token,
                _kind: "local"
            }
        }
    ], { modalBehavior: "execute" });
}

async function selectSubject() {
    const attempts = [
        [{ _obj: "autoCutout", sampleAllLayers: false }],
        [{ _obj: "autoCutout", sampleAllLayers: true }],
        [{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "subject" } }]
    ];

    let lastError = null;
    for (const descriptor of attempts) {
        try {
            await action.batchPlay(descriptor, { modalBehavior: "execute" });
            return;
        } catch (error) {
            lastError = error;
            console.warn("Select Subject attempt failed:", error.message);
        }
    }

    throw new Error("Select Subject failed. Run Select > Subject once manually and capture the batchPlay command if this Photoshop version uses a different descriptor. Last error: " + (lastError ? lastError.message : "unknown"));
}

async function applyStyleTransfer(styleName) {
    const descriptor = buildStyleTransferDescriptor(styleName);
    validateExecutableStyleTransferDescriptor(descriptor);
    await action.batchPlay([descriptor], { modalBehavior: "execute" });
}

function buildStyleTransferDescriptor(styleName) {
    const executableDescriptor = findExecutableDescriptor(styleName);
    if (executableDescriptor) {
        return tuneDescriptorForStyle(executableDescriptor, styleName);
    }

    const metadata = getStyleMetadata(styleName);
    throw new Error([
        `No executable Style Transfer batchPlay descriptor was found in ${DESCRIPTOR_JSON_PATH}.`,
        `The JSON confirms Style Transfer metadata (${metadata.id || "internal.StyleTransfer"}, style=${metadata.style || styleName}), but Photoshop needs the full neuralGalleryFilters payload.`,
        "Paste/export a captured descriptor object containing _obj, NF_SPL_GRAPH, NF_UI_DATA, NF_SPL_REGISTERED_VARIABLES, NF_SPL_REGISTERED_VAR_NAMES, and NF_SPL_REGISTERED_VAR_CONFIGS into parsed_neural_output.json."
    ].join(" "));
}

async function loadDescriptorData() {
    if (descriptorCache) {
        return descriptorCache;
    }

    const response = await fetch(DESCRIPTOR_JSON_PATH);
    if (!response.ok) {
        throw new Error(`Could not load ${DESCRIPTOR_JSON_PATH}. Make sure it is in the plugin root.`);
    }

    descriptorCache = await response.json();
    console.log("Loaded Style Transfer descriptor data", descriptorCache);
    return descriptorCache;
}

function findExecutableDescriptor(styleName) {
    const candidates = [];
    walkObject(descriptorCache, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }

        const isNeuralFilter = value._obj === "neuralGalleryFilters";
        const hasExecutableKeys = value.NF_SPL_GRAPH && value.NF_UI_DATA;
        if (isNeuralFilter && hasExecutableKeys && descriptorMentionsStyle(value, styleName)) {
            candidates.push(value);
        }
    });

    if (candidates.length > 0) {
        return deepClone(candidates[0]);
    }

    walkObject(descriptorCache, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }
        if (value._obj === "neuralGalleryFilters" && value.NF_SPL_GRAPH && value.NF_UI_DATA) {
            candidates.push(value);
        }
    });

    return candidates.length > 0 ? deepClone(candidates[0]) : null;
}

function validateExecutableStyleTransferDescriptor(descriptor) {
    const requiredKeys = ["_obj", "NF_SPL_GRAPH", "NF_UI_DATA"];
    const missing = requiredKeys.filter(key => !descriptor || !descriptor[key]);
    if (missing.length > 0) {
        throw new Error("Style Transfer descriptor is missing required keys: " + missing.join(", "));
    }
    if (descriptor._obj !== "neuralGalleryFilters") {
        throw new Error("Style Transfer descriptor must have _obj: neuralGalleryFilters.");
    }
}

function tuneDescriptorForStyle(descriptor, styleName) {
    const aliases = STYLE_ALIASES[styleName] || [styleName];
    const preferredModel = aliases[0];

    walkObject(descriptor, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }

        setIfPresent(value, "spl::style", styleName === "wave_2048" || styleName === "wave_1024" ? "wave" : styleName);
        setIfPresent(value, "style", styleName === "wave_2048" || styleName === "wave_1024" ? "wave" : styleName);

        if (value["spl::modelID"] && typeof value["spl::modelID"] === "string") {
            value["spl::modelID"] = preferredModel;
        }
        if (value.modelID && typeof value.modelID === "string") {
            value.modelID = preferredModel;
        }
        if (value["spl::value"] && aliases.some(alias => String(value["spl::value"]).includes(alias))) {
            value["spl::value"] = preferredModel;
        }
    });

    return descriptor;
}

function getStyleMetadata(styleName) {
    const metadata = {
        id: "internal.StyleTransfer",
        operation: "STYLE_TRANSFER",
        styleTransferOption: "style_transfer",
        style: styleName
    };

    walkObject(descriptorCache, value => {
        if (typeof value !== "string") {
            return;
        }
        if (value === "internal.StyleTransfer") {
            metadata.id = value;
        } else if (value === "STYLE_TRANSFER") {
            metadata.operation = value;
        } else if (value === "style_transfer") {
            metadata.styleTransferOption = value;
        } else if ((STYLE_ALIASES[styleName] || [styleName]).includes(value)) {
            metadata.style = value;
        }
    });

    return metadata;
}

function descriptorMentionsStyle(descriptor, styleName) {
    const aliases = STYLE_ALIASES[styleName] || [styleName];
    let foundStyle = false;
    let foundStyleTransfer = false;

    walkObject(descriptor, value => {
        if (typeof value !== "string") {
            return;
        }
        if (aliases.includes(value)) {
            foundStyle = true;
        }
        if (value === "internal.StyleTransfer" || value === "STYLE_TRANSFER" || value === "style_transfer") {
            foundStyleTransfer = true;
        }
    });

    return foundStyle || foundStyleTransfer;
}

async function saveActiveDocumentAsPng(folder, fileName) {
    const outputFile = await folder.createFile(fileName, { overwrite: true });
    const token = await fs.createSessionToken(outputFile);

    await action.batchPlay([
        {
            _obj: "save",
            as: {
                _obj: "PNGFormat",
                PNGInterlaceType: {
                    _enum: "PNGInterlaceType",
                    _value: "PNGInterlaceNone"
                },
                PNGFilter: {
                    _enum: "PNGFilter",
                    _value: "PNGFilterAdaptive"
                },
                compression: 6
            },
            in: {
                _path: token,
                _kind: "local"
            },
            copy: true,
            lowerCase: true
        }
    ], { modalBehavior: "execute" });
}

async function closeActiveDocumentNoSave() {
    if (!app.activeDocument) {
        return;
    }

    await action.batchPlay([
        {
            _obj: "close",
            saving: {
                _enum: "yesNo",
                _value: "no"
            }
        }
    ], { modalBehavior: "execute" });
}

function setIfPresent(object, key, value) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
        object[key] = value;
    }
}

function walkObject(value, visitor, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
        return;
    }

    seen.add(value);
    visitor(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            if (item && typeof item === "object") {
                walkObject(item, visitor, seen);
            } else {
                visitor(item);
            }
        }
        return;
    }

    for (const key of Object.keys(value)) {
        const child = value[key];
        if (child && typeof child === "object") {
            walkObject(child, visitor, seen);
        } else {
            visitor(child);
        }
    }
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getExtension(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

function getBaseName(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot === -1 ? fileName : fileName.slice(0, dot);
}

function makeOutputName(fileName) {
    return sanitizeFilename(getBaseName(fileName)) + ".png";
}

function sanitizeFilename(name) {
    return name.replace(/[/\\?%*:|"<>]/g, "-").substring(0, 120) || "output";
}

function updateProgress(current, total, message) {
    const percentage = total <= 0 ? 0 : Math.max(0, Math.min(100, (current / total) * 100));
    document.getElementById("progress-fill").style.width = percentage + "%";
    updateProgressText(message);
}

function updateProgressText(message) {
    document.getElementById("status-text").textContent = message;
}

function showProgress() {
    document.getElementById("progress-section").classList.remove("hidden");
    document.getElementById("result-section").classList.add("hidden");
    document.getElementById("progress-fill").style.width = "0%";
}

function showResult(message, hideProgress = true) {
    const resultSection = document.getElementById("result-section");
    const resultText = document.getElementById("result-text");
    resultSection.classList.remove("hidden");
    resultText.textContent = message;
    resultText.style.backgroundColor = "#2d7d46";
    if (hideProgress) {
        document.getElementById("progress-section").classList.add("hidden");
    }
}

function showError(message) {
    const resultSection = document.getElementById("result-section");
    const resultText = document.getElementById("result-text");
    resultSection.classList.remove("hidden");
    resultText.textContent = "Error: " + message;
    resultText.style.backgroundColor = "#d13438";
    document.getElementById("progress-section").classList.add("hidden");
}

function showBatchSummary(results) {
    const successes = results.filter(result => result.ok).length;
    const failures = results.filter(result => !result.ok);
    const failureText = failures.length > 0
        ? " Failed: " + failures.map(result => `${result.name} (${result.error})`).join("; ")
        : "";

    showResult(`Batch complete. Saved ${successes} file(s) to ${outputFolder.name}.${failureText}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
