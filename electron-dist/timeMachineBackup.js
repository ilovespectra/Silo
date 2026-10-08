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
exports.startConfiguredTimeMachineBackup = void 0;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const util_1 = require("util");
const indexingPathPolicy_1 = require("./indexingPathPolicy");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
async function startConfiguredTimeMachineBackup(sourcePath, sourceRegistered, options = {}) {
    if ((options.platform ?? process.platform) !== "darwin")
        throw new Error("Time Machine backups are only available for This Mac.");
    if (path.resolve(sourcePath) !== indexingPathPolicy_1.MAC_DATA_VOLUME_ROOT || !sourceRegistered)
        throw new Error("Time Machine backups can only be requested for the registered This Mac source.");
    const runCommand = options.runCommand ?? (async (executable, args) => {
        await execFileAsync(executable, args, { timeout: 15000 });
    });
    await runCommand("/usr/bin/tmutil", ["startbackup", "--auto"]);
}
exports.startConfiguredTimeMachineBackup = startConfiguredTimeMachineBackup;
