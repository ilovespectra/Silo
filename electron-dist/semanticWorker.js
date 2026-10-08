"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const worker_threads_1 = require("worker_threads");
const url_1 = require("url");
let runtimePromise = null;
let taskChain = Promise.resolve();
const MAX_INPUT_PIXELS = 40000000;
class RuntimeInitializationError extends Error {
}
function loadPortableWasmRuntime() {
    const onnxruntime = require("onnxruntime-web/wasm");
    const moduleLoader = require("module");
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (request, parent, isMain) {
        if (request === "onnxruntime-node")
            return {};
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        globalThis[Symbol.for("onnxruntime")] = onnxruntime;
        let runtimeDirectory = path.dirname(require.resolve("onnxruntime-web/wasm"));
        const asarSegment = `${path.sep}app.asar${path.sep}`;
        if (runtimeDirectory.includes(asarSegment)) {
            const unpackedDirectory = runtimeDirectory.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
            if (fs.existsSync(unpackedDirectory))
                runtimeDirectory = unpackedDirectory;
        }
        const wasmPath = path.join(runtimeDirectory, "ort-wasm-simd-threaded.asyncify.wasm");
        const wasmModulePath = path.join(runtimeDirectory, "ort-wasm-simd-threaded.asyncify.mjs");
        if (!fs.existsSync(wasmPath) || !fs.existsSync(wasmModulePath))
            throw new Error("The local portable semantic runtime files are missing.");
        onnxruntime.env.wasm.numThreads = 1;
        onnxruntime.env.wasm.proxy = false;
        onnxruntime.env.wasm.wasmPaths = {
            mjs: (0, url_1.pathToFileURL)(wasmModulePath).href,
            wasm: (0, url_1.pathToFileURL)(wasmPath).href,
        };
        return {
            onnxruntime,
            transformers: require("@huggingface/transformers"),
        };
    }
    finally {
        moduleLoader._load = originalLoad;
    }
}
async function createWasmSession(onnxruntime, modelPath) {
    const modelBuffer = fs.readFileSync(modelPath);
    const modelData = new Uint8Array(modelBuffer.buffer, modelBuffer.byteOffset, modelBuffer.byteLength);
    return onnxruntime.InferenceSession.create(modelData, {
        executionProviders: ["wasm"],
    });
}
async function runWasmSession(onnxruntime, session, inputs) {
    const feeds = {};
    for (const name of session.inputNames) {
        const input = inputs[name];
        if (!input)
            throw new Error(`Missing CLIP model input: ${name}`);
        feeds[name] =
            input instanceof onnxruntime.Tensor
                ? input
                : new onnxruntime.Tensor(input.type, input.data, input.dims);
    }
    return session.run(feeds);
}
// Set before loading either native runtime, including in worker-thread mode.
process.env.OMP_NUM_THREADS = "2";
process.env.OPENBLAS_NUM_THREADS = "2";
process.env.MKL_NUM_THREADS = "2";
async function loadRuntime() {
    if (!runtimePromise) {
        runtimePromise = (async () => {
            const usePortableWasmRuntime = process.arch === "x64" &&
                (process.platform === "win32" || process.platform === "darwin");
            const portableRuntime = usePortableWasmRuntime
                ? loadPortableWasmRuntime()
                : null;
            const transformers = portableRuntime?.transformers ??
                require("@huggingface/transformers");
            transformers.env.cacheDir =
                worker_threads_1.workerData?.modelCachePath ?? process.env.SEMANTIC_MODEL_CACHE_PATH;
            transformers.env.allowRemoteModels = false;
            if (portableRuntime)
                transformers.env.useWasmCache = false;
            const session_options = {
                intraOpNumThreads: 1,
                interOpNumThreads: 1,
                executionMode: "sequential",
            };
            const modelId = "Xenova/clip-vit-base-patch32";
            const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelId);
            const processor = await transformers.AutoProcessor.from_pretrained(modelId);
            if (portableRuntime) {
                const modelDirectory = path.join(transformers.env.cacheDir, modelId, "onnx");
                const textSession = await createWasmSession(portableRuntime.onnxruntime, path.join(modelDirectory, "text_model_quantized.onnx"));
                const visionSession = await createWasmSession(portableRuntime.onnxruntime, path.join(modelDirectory, "vision_model_quantized.onnx"));
                return {
                    tokenizer,
                    processor,
                    textSession,
                    visionSession,
                    onnxruntime: portableRuntime.onnxruntime,
                    RawImage: transformers.RawImage,
                };
            }
            const textModel = await transformers.CLIPTextModelWithProjection.from_pretrained(modelId, { dtype: "q8", session_options });
            const visionModel = await transformers.CLIPVisionModelWithProjection.from_pretrained(modelId, { dtype: "q8", session_options });
            return {
                tokenizer,
                processor,
                textModel,
                visionModel,
                RawImage: transformers.RawImage,
            };
        })().catch((error) => {
            runtimePromise = null;
            throw new RuntimeInitializationError(error instanceof Error
                ? error.message
                : "CLIP runtime initialization failed.");
        });
    }
    return runtimePromise;
}
async function handleRequest(request) {
    const runtime = await loadRuntime();
    if (request.type === "preload")
        return [];
    if (request.type === "text") {
        const inputs = runtime.tokenizer([request.text.slice(0, 8000)], {
            padding: true,
            truncation: true,
        });
        const output = runtime.textSession
            ? await runWasmSession(runtime.onnxruntime, runtime.textSession, inputs)
            : await runtime.textModel(inputs);
        return Array.from(output.text_embeds.data);
    }
    // Never hand an unbounded encoded file to RawImage.read. All metadata and
    // decoding remain in this disposable process: libvips can still crash.
    const sharp = require("sharp");
    sharp.concurrency(2);
    const decoder = sharp(request.filePath, {
        limitInputPixels: MAX_INPUT_PIXELS,
        failOn: "warning",
    });
    const metadata = await decoder.metadata();
    if (!metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > MAX_INPUT_PIXELS)
        throw new Error("Image exceeds the 40 million pixel decoder limit or has invalid dimensions.");
    const { data, info } = await decoder
        .rotate()
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const image = new runtime.RawImage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, info.channels);
    const inputs = await runtime.processor(image);
    const output = runtime.visionSession
        ? await runWasmSession(runtime.onnxruntime, runtime.visionSession, inputs)
        : await runtime.visionModel(inputs);
    return Array.from(output.image_embeds.data);
}
function sendResponse(response) {
    if (worker_threads_1.parentPort)
        worker_threads_1.parentPort.postMessage(response);
    else if (process.connected && process.send)
        process.send(response, (error) => {
            if (error)
                process.exit(1);
        });
}
function receiveRequest(request) {
    if (!request ||
        !Number.isInteger(request.id) ||
        !["preload", "text", "image"].includes(request.type))
        return;
    taskChain = taskChain.then(async () => {
        try {
            const values = await handleRequest(request);
            sendResponse({ id: request.id, values });
        }
        catch (error) {
            sendResponse({
                id: request.id,
                error: error instanceof Error ? error.message : "Embedding failed.",
                infrastructure: error instanceof RuntimeInitializationError,
            });
        }
    });
}
if (worker_threads_1.parentPort)
    worker_threads_1.parentPort.on("message", receiveRequest);
else {
    process.on("message", receiveRequest);
    // Do not leave an orphaned native model process after the parent exits.
    process.on("disconnect", () => process.exit(0));
}
