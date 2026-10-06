import { parentPort, workerData } from "worker_threads";

interface WorkerRequest {
  id: number;
  type: "preload" | "text" | "image";
  text?: string;
  filePath?: string;
}

interface Runtime {
  tokenizer: any;
  processor: any;
  textModel: any;
  visionModel: any;
  RawImage: any;
}

let runtimePromise: Promise<Runtime> | null = null;
let taskChain = Promise.resolve();
const MAX_INPUT_PIXELS = 40_000_000;
class RuntimeInitializationError extends Error {}

// Set before loading either native runtime, including in worker-thread mode.
process.env.OMP_NUM_THREADS = "2";
process.env.OPENBLAS_NUM_THREADS = "2";
process.env.MKL_NUM_THREADS = "2";

async function loadRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const transformers = require("@huggingface/transformers") as any;
      transformers.env.cacheDir =
        workerData?.modelCachePath ?? process.env.SEMANTIC_MODEL_CACHE_PATH;
      transformers.env.allowRemoteModels = false;
      const session_options = {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionMode: "sequential",
      };
      const modelId = "Xenova/clip-vit-base-patch32";
      const tokenizer =
        await transformers.AutoTokenizer.from_pretrained(modelId);
      const processor =
        await transformers.AutoProcessor.from_pretrained(modelId);
      const textModel =
        await transformers.CLIPTextModelWithProjection.from_pretrained(
          modelId,
          {
            dtype: "q8",
            session_options,
          },
        );
      const visionModel =
        await transformers.CLIPVisionModelWithProjection.from_pretrained(
          modelId,
          {
            dtype: "q8",
            session_options,
          },
        );
      return {
        tokenizer,
        processor,
        textModel,
        visionModel,
        RawImage: transformers.RawImage,
      };
    })().catch((error) => {
      runtimePromise = null;
      throw new RuntimeInitializationError(
        error instanceof Error
          ? error.message
          : "CLIP runtime initialization failed.",
      );
    });
  }
  return runtimePromise;
}

async function handleRequest(request: WorkerRequest) {
  const runtime = await loadRuntime();
  if (request.type === "preload") return [];
  if (request.type === "text") {
    const inputs = runtime.tokenizer([request.text!.slice(0, 8000)], {
      padding: true,
      truncation: true,
    });
    const output = await runtime.textModel(inputs);
    return Array.from(output.text_embeds.data as Iterable<number>);
  }
  // Never hand an unbounded encoded file to RawImage.read. All metadata and
  // decoding remain in this disposable process: libvips can still crash.
  const sharp = require("sharp") as typeof import("sharp");
  sharp.concurrency(2);
  const decoder = sharp(request.filePath!, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "warning",
  });
  const metadata = await decoder.metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS
  )
    throw new Error(
      "Image exceeds the 40 million pixel decoder limit or has invalid dimensions.",
    );
  const { data, info } = await decoder
    .rotate()
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = new runtime.RawImage(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    info.channels,
  );
  const inputs = await runtime.processor(image);
  const output = await runtime.visionModel(inputs);
  return Array.from(output.image_embeds.data as Iterable<number>);
}

function sendResponse(response: {
  id: number;
  values?: number[];
  error?: string;
  infrastructure?: boolean;
}) {
  if (parentPort) parentPort.postMessage(response);
  else if (process.connected && process.send)
    process.send(response, (error) => {
      if (error) process.exit(1);
    });
}

function receiveRequest(request: WorkerRequest) {
  if (
    !request ||
    !Number.isInteger(request.id) ||
    !["preload", "text", "image"].includes(request.type)
  )
    return;
  taskChain = taskChain.then(async () => {
    try {
      const values = await handleRequest(request);
      sendResponse({ id: request.id, values });
    } catch (error) {
      sendResponse({
        id: request.id,
        error: error instanceof Error ? error.message : "Embedding failed.",
        infrastructure: error instanceof RuntimeInitializationError,
      });
    }
  });
}

if (parentPort) parentPort.on("message", receiveRequest);
else {
  process.on("message", receiveRequest);
  // Do not leave an orphaned native model process after the parent exits.
  process.on("disconnect", () => process.exit(0));
}
