const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(
    ts.transpileModule(require("node:fs").readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
};

const { MessageManager } = require("../src/messageManager.ts");
const { MessageExportCoordinator } = require("../src/messageExportCoordinator.ts");

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "silo-message-coverage-"));
  try {
    const userData = path.join(root, "user-data");
    const manager = new MessageManager("/fake/adb", userData);
    manager.log = () => {};
    manager.logError = () => {};
    manager.adbShell = async (_deviceId, command) => {
      if (command.includes("content://sms/"))
        return "Row: 0 _id=11, thread_id=7, address=555111, body=Earlier SMS, date=1700000000000, type=1, read=1";
      if (command.includes("content://mms/part"))
        return [
          "Row: 0 _id=301, mid=22, ct=text/plain, name=NULL, cl=NULL, _data=NULL, text=Caption, with a comma",
          "Row: 1 _id=302, mid=22, ct=image/jpeg, name=photo.jpg, cl=photo.jpg, _data=/private/part/302, text=NULL",
        ].join("\n");
      if (command.includes("content://mms/21/addr"))
        return "Row: 0 address=555111, type=137";
      if (command.includes("content://mms/23/addr"))
        return "Row: 0 address=555999, type=151";
      if (command.includes("content://mms/ --projection"))
        return [
          "Row: 0 _id=21, thread_id=7, date=1700000000, msg_box=1, read=1",
          "Row: 1 _id=22, thread_id=7, date=1700000001, msg_box=2, read=0",
          "Row: 2 _id=23, thread_id=9, date=1700000002, msg_box=2, read=1",
        ].join("\n");
      throw new Error(`Unexpected ADB command: ${command}`);
    };
    manager.readMMSAttachmentBytes = async (_deviceId, partId) =>
      Buffer.from(`fixture-${partId}`);

    const threads = await manager.getDeviceMessageThreads(
      "android-fixture",
      "android",
      true,
      "Fixture Android",
    );
    const sharedThread = threads.find((thread) => thread.threadId === "7");
    const outgoingThread = threads.find((thread) => thread.threadId === "9");
    assert(sharedThread);
    assert.equal(sharedThread.address, "555111");
    assert.equal(sharedThread.messageCount, 3);
    assert.deepEqual(
      sharedThread.messages.map((message) => message.id),
      ["11", "21", "22"],
    );

    const mms = sharedThread.messages.find((message) => message.id === "22");
    assert.equal(mms.type, 2);
    assert.equal(mms.date, 1700000001000);
    assert.equal(mms.body, "Caption, with a comma");
    assert.equal(mms.parts[1].fileName, "photo.jpg");
    assert.equal(mms.parts[1].attachmentAvailable, true);
    assert.equal(mms.parts[1].attachmentSize, Buffer.byteLength("fixture-302"));
    assert.equal(outgoingThread.address, "555999");
    assert.equal(outgoingThread.messages[0].type, 2);

    const legacyDeviceId = "legacy-android-fixture";
    const legacyKey = createHash("sha256")
      .update(`android:${legacyDeviceId}`)
      .digest("hex");
    const legacyHistoryPath = path.join(
      userData,
      "message-history",
      `${legacyKey}.json`,
    );
    await fs.mkdir(path.dirname(legacyHistoryPath), { recursive: true });
    await fs.writeFile(
      legacyHistoryPath,
      JSON.stringify({
        deviceId: legacyDeviceId,
        platform: "android",
        deviceName: "Legacy Android",
        threads: [
          {
            threadId: "7",
            address: "555111",
            messageCount: 1,
            lastMessageDate: 1700000000000,
            messages: [
              {
                id: "11",
                address: "555111",
                body: "Earlier SMS",
                date: 1700000000000,
                type: 1,
                read: 1,
                threadId: "7",
              },
            ],
          },
        ],
      }),
    );
    const migratedThreads = await manager.getDeviceMessageThreads(
      legacyDeviceId,
      "android",
      false,
      "Legacy Android",
    );
    assert(
      migratedThreads
        .find((thread) => thread.threadId === "7")
        .messages.some((message) => message.id === "22"),
      "legacy Android history should be refreshed to add MMS coverage",
    );

    const dataUrl = await manager.getMessageAttachmentDataUrl(
      "android-fixture",
      "22",
      "302",
    );
    assert.equal(
      dataUrl,
      `data:image/jpeg;base64,${Buffer.from("fixture-302").toString("base64")}`,
    );
    assert.equal(
      await manager.getMessageAttachmentDataUrl(
        "android-fixture",
        "../22",
        "302",
      ),
      null,
    );

    const coordinator = new MessageExportCoordinator(userData);
    coordinator.log = () => {};
    coordinator.logError = () => {};
    coordinator.messageManager = manager;
    coordinator.pdfGenerator = {
      generateThreadPDF: async () => {},
      generateCombinedPDF: async () => {},
    };
    const result = await coordinator.exportMessages({
      accountId: "fixture",
      deviceId: "android-fixture",
      outputDir: path.join(root, "exports"),
      format: "both",
      includeAttachments: true,
      platform: "android",
    });
    assert.equal(result.success, true);
    assert.equal(result.attachmentCount, 1);
    const attachmentPath = path.join(
      result.backupPath,
      "attachments",
      "7",
      "22-302-photo.jpg",
    );
    assert.equal(await fs.readFile(attachmentPath, "utf8"), "fixture-302");
    const xml = await fs.readFile(result.xmlPath, "utf8");
    const text = await fs.readFile(result.textPath, "utf8");
    assert(xml.includes("attachments/7/22-302-photo.jpg"));
    assert(text.includes("[Attachment: photo.jpg — attachments/7/22-302-photo.jpg]"));

    console.log(
      "Message coverage tests passed: Android MMS thread merge, dates/direction, text parts, cached media, offline retrieval, and attachment exports.",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
