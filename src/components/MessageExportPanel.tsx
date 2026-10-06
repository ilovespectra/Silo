import React, { useMemo, useState } from "react";
import {
  FiBattery,
  FiChevronLeft,
  FiDownload,
  FiMessageSquare,
  FiPlus,
  FiRefreshCw,
  FiSearch,
  FiSend,
  FiSmartphone,
  FiEdit2,
  FiBook,
  FiSave,
  FiUser,
  FiWifi,
  FiX,
} from "react-icons/fi";
import "../styles/MessageExportPanel.css";
import { AddressBook } from "./AddressBook";

function conversationName(thread: DeviceMessageThread) {
  return thread.displayName || thread.address || "Unknown conversation";
}

function messageText(message: DeviceMessage) {
  return message.body || "Media message";
}

function initialsFor(name: string) {
  const words = name.match(/\p{L}[\p{L}'-]*/gu);
  if (!words) return null;
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

// Google Messages assigns each contact a stable tonal avatar color.
const ANDROID_AVATAR_COLORS = [
  "#a8c7fa",
  "#7fcfff",
  "#9de1b5",
  "#ffd97a",
  "#ffb4a9",
  "#e5b8ff",
  "#ffb0cb",
  "#c4c7c5",
];

function avatarColor(name: string) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1)
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  return ANDROID_AVATAR_COLORS[Math.abs(hash) % ANDROID_AVATAR_COLORS.length];
}

function Avatar({
  name,
  platform,
  size,
}: {
  name: string;
  platform: "ios" | "android";
  size: number;
}) {
  const initials = initialsFor(name);
  return (
    <span
      className="conversation-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        ...(platform === "android" ? { background: avatarColor(name) } : {}),
      }}
    >
      {initials ?? <FiUser />}
    </span>
  );
}

function MessageAttachment({
  deviceId,
  messageId,
  part,
}: {
  deviceId: string;
  messageId: string;
  part: DeviceMessagePart;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!window.electron || loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await window.electron.getMessageAttachmentDataUrl(
        deviceId,
        messageId,
        part.id,
      );
      if (!result) throw new Error("Cached attachment is unavailable.");
      setDataUrl(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load media.");
    } finally {
      setLoading(false);
    }
  };

  if (!part.attachmentAvailable)
    return <span className="message-attachment-status">Media wasn’t copied</span>;

  return (
    <div className="message-attachment">
      {!dataUrl ? (
        <button
          type="button"
          className="message-attachment-load"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "Loading media…" : `Load ${part.fileName || "attachment"}`}
        </button>
      ) : part.contentType.startsWith("image/") ? (
        <img src={dataUrl} alt={part.fileName || "Message attachment"} />
      ) : part.contentType.startsWith("video/") ? (
        <video controls preload="metadata" src={dataUrl} />
      ) : part.contentType.startsWith("audio/") ? (
        <audio controls preload="metadata" src={dataUrl} />
      ) : null}
      {dataUrl && (
        <a href={dataUrl} download={part.fileName || "message-attachment"}>
          Save {part.fileName || "attachment"}
        </a>
      )}
      {error && <span className="message-attachment-status">{error}</span>}
    </div>
  );
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Thread list date the way phones show it: time today, "Yesterday", weekday this week, then a short date. */
function formatThreadDate(time: number, platform: "ios" | "android") {
  if (!time) return "";
  const days = Math.round(
    (startOfDay(Date.now()) - startOfDay(time)) / 86400000,
  );
  if (days <= 0)
    return new Date(time).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  if (days === 1) return "Yesterday";
  if (days < 7)
    return new Date(time).toLocaleDateString([], {
      weekday: platform === "ios" ? "long" : "short",
    });
  if (
    platform === "android" &&
    new Date(time).getFullYear() === new Date().getFullYear()
  )
    return new Date(time).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });
  return new Date(time).toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

function formatDivider(time: number, platform: "ios" | "android") {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = date.toLocaleDateString(
    [],
    platform === "ios"
      ? {
          weekday: "short",
          month: "short",
          day: "numeric",
          year:
            date.getFullYear() === new Date().getFullYear()
              ? undefined
              : "numeric",
        }
      : {
          weekday: "long",
          month: "short",
          day: "numeric",
          year:
            date.getFullYear() === new Date().getFullYear()
              ? undefined
              : "numeric",
        },
  );
  return platform === "ios"
    ? { day, clock: ` at ${clock}` }
    : { day, clock: ` · ${clock}` };
}

const DIVIDER_GAP_MS = 60 * 60 * 1000;

export const MessageExportPanel: React.FC = () => {
  const electronAPI = window.electron;
  const [devices, setDevices] = useState<PhoneDevice[]>([]);
  const [historyEntries, setHistoryEntries] = useState<MessageHistoryEntry[]>(
    [],
  );
  const [selectedDeviceKey, setSelectedDeviceKey] = useState("");
  const [threads, setThreads] = useState<DeviceMessageThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [query, setQuery] = useState("");
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [format, setFormat] = useState<"xml" | "pdf" | "both">("both");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [showAddressBook, setShowAddressBook] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingThreadName, setEditingThreadName] = useState("");

  const selectedHistory = historyEntries.find(
    (entry) => `${entry.platform}:${entry.deviceId}` === selectedDeviceKey,
  );
  const selectedDevice = devices.find(
    (device) => `${device.platform}:${device.id}` === selectedDeviceKey,
  );
  const selectedIdentity = selectedDevice
    ? {
        deviceId: selectedDevice.id,
        platform: selectedDevice.platform,
        deviceName: selectedDevice.name,
      }
    : selectedHistory;
  const platform: "ios" | "android" =
    selectedIdentity?.platform === "android" ? "android" : "ios";
  const selectedThread =
    threads.find((thread) => thread.threadId === selectedThreadId) ?? null;
  const filteredThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return threads;
    return threads.filter(
      (thread) =>
        conversationName(thread).toLowerCase().includes(normalized) ||
        thread.messages.some((message) =>
          messageText(message).toLowerCase().includes(normalized),
        ),
    );
  }, [query, threads]);

  const scanDevices = async () => {
    if (!electronAPI) return;
    setLoadingDevices(true);
    setError("");
    try {
      const found = await electronAPI.listPhones();
      setDevices(found);
      const keys = new Set([
        ...found.map((device) => `${device.platform}:${device.id}`),
        ...historyEntries.map((entry) => `${entry.platform}:${entry.deviceId}`),
      ]);
      if (!keys.has(selectedDeviceKey))
        setSelectedDeviceKey(
          found[0]
            ? `${found[0].platform}:${found[0].id}`
            : historyEntries[0]
              ? `${historyEntries[0].platform}:${historyEntries[0].deviceId}`
              : "",
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not scan connected devices.",
      );
    } finally {
      setLoadingDevices(false);
    }
  };

  React.useEffect(() => {
    // Load the persistent phone backup destination when component mounts
    if (!electronAPI) return;
    void electronAPI
      .listPhones()
      .then(setDevices)
      .catch(() => undefined);
    void electronAPI.getPhoneBackupDestination().then((dest) => {
      console.log(`[MessageExportPanel] Loaded backup destination: ${dest}`);
      if (dest) setOutputDir(dest);
    });
    return electronAPI.onPhoneDevicesChanged(setDevices);
  }, [electronAPI]);

  React.useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    void electronAPI
      .listMessageHistory()
      .then(async (entries) => {
        if (!active) return;
        setHistoryEntries(entries);
        if (entries.length === 0) return;
        const entry = entries[0];
        const key = `${entry.platform}:${entry.deviceId}`;
        setSelectedDeviceKey(key);
        setLoadingMessages(true);
        try {
          const result = await electronAPI.getMessageThreads(
            entry.deviceId,
            entry.platform,
            false,
          );
          if (!active) return;
          if (result.ok) {
            setThreads(result.threads);
            setSelectedThreadId(result.threads[0]?.threadId ?? "");
            setNotice(
              `${result.threads.length.toLocaleString()} saved conversations · ${entry.deviceName}`,
            );
          } else
            setError(result.error || "Could not load saved message history.");
        } finally {
          if (active) setLoadingMessages(false);
        }
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load saved message history.",
          );
      });
    return () => {
      active = false;
    };
  }, [electronAPI]);

  const loadMessages = async (refresh = false, identity = selectedIdentity) => {
    if (!electronAPI || !identity) return;
    const connected = devices.find(
      (device) =>
        device.platform === identity.platform &&
        device.id === identity.deviceId,
    );
    if (refresh && (!connected || connected.status !== "ready")) {
      setError("Connect and trust this phone to update its message backup.");
      return;
    }
    setLoadingMessages(true);
    setError("");
    setNotice("");
    try {
      const result = await electronAPI.getMessageThreads(
        identity.deviceId,
        identity.platform,
        refresh,
      );
      if (!result.ok)
        throw new Error(result.error || "Could not load messages.");
      const sorted = [...result.threads].sort(
        (first, second) => second.lastMessageDate - first.lastMessageDate,
      );
      setThreads(sorted);
      setSelectedThreadId((current) =>
        sorted.some((thread) => thread.threadId === current)
          ? current
          : (sorted[0]?.threadId ?? ""),
      );
      setNotice(
        `${sorted.length.toLocaleString()} saved conversations · ${identity.deviceName}${connected ? " · connected" : " · offline history"}`,
      );
    } catch (cause) {
      setThreads([]);
      setSelectedThreadId("");
      setError(
        cause instanceof Error ? cause.message : "Could not load messages.",
      );
    } finally {
      setLoadingMessages(false);
    }
  };

  const chooseDestination = async () => {
    const selected = await electronAPI?.selectBackupDestination();
    if (selected) setOutputDir(selected);
  };

  const saveThreadName = async (thread: DeviceMessageThread) => {
    if (!electronAPI || editingThreadName.trim() === "") return;
    try {
      const result = await electronAPI.setContactName(
        thread.address,
        editingThreadName.trim(),
      );
      if (result.ok) {
        setThreads((current) =>
          current.map((t) =>
            t.threadId === thread.threadId
              ? { ...t, displayName: editingThreadName.trim() }
              : t,
          ),
        );
        setNotice(`Saved "${editingThreadName.trim()}" for ${thread.address}`);
      }
      setEditingThreadId(null);
      setEditingThreadName("");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save contact name.",
      );
    }
  };

  const exportMessages = async () => {
    if (!electronAPI || !selectedIdentity || !outputDir || threads.length === 0)
      return;
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const result = await electronAPI.exportMessages(
        "",
        selectedIdentity.deviceId,
        outputDir,
        format,
        selectedIdentity.platform,
        selectedThread ? [selectedThread.threadId] : undefined,
      );
      if (!result.success) throw new Error(result.error || "Export failed.");
      setNotice(
        `${result.messageCount.toLocaleString()} messages saved to ${result.backupPath || outputDir}.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className={`messages-browser platform-${platform}`} data-tour="mobile-messages" data-help="Select a connected phone or saved message history, load and review a conversation, then choose an export folder and format. Refresh and update actions can read device history, so use them only when you intend to.">
      <header className="messages-toolbar">
        <div>
          <span className="sidebar-kicker">Connected devices</span>
          <h2>Messages</h2>
        </div>
        <button onClick={() => void scanDevices()} disabled={loadingDevices}
          data-help="Refresh connected-device and saved-message-backup choices.">
          <FiSmartphone /> {loadingDevices ? "Scanning..." : "Scan devices"}
        </button>
        <select
          value={selectedDeviceKey}
          onChange={(event) => {
            setSelectedDeviceKey(event.target.value);
            setThreads([]);
            setSelectedThreadId("");
            setError("");
            const key = event.target.value;
            const phone = devices.find(
              (device) => `${device.platform}:${device.id}` === key,
            );
            const history = historyEntries.find(
              (entry) => `${entry.platform}:${entry.deviceId}` === key,
            );
            const identity = phone
              ? {
                  deviceId: phone.id,
                  platform: phone.platform,
                  deviceName: phone.name,
                }
              : history;
            if (identity) void loadMessages(false, identity);
          }}
        >
          <option value="">Choose a phone history</option>
          {Array.from(
            new Map([
              ...historyEntries.map(
                (entry) =>
                  [
                    `${entry.platform}:${entry.deviceId}`,
                    {
                      key: `${entry.platform}:${entry.deviceId}`,
                      name: entry.deviceName,
                      platform: entry.platform,
                      suffix: "saved history",
                    },
                  ] as const,
              ),
              ...devices.map(
                (device) =>
                  [
                    `${device.platform}:${device.id}`,
                    {
                      key: `${device.platform}:${device.id}`,
                      name: device.name,
                      platform: device.platform,
                      suffix: "connected",
                    },
                  ] as const,
              ),
            ]).values(),
          ).map((option) => (
            <option key={option.key} value={option.key}>
              {option.name} · {option.platform === "ios" ? "iPhone" : "Android"}{" "}
              · {option.suffix}
            </option>
          ))}
        </select>
        <button
          disabled={!selectedIdentity || loadingMessages}
          onClick={() => void loadMessages(false)}
        >
          <FiMessageSquare />{" "}
          {loadingMessages ? "Loading history..." : "Load saved history"}
        </button>
        <button
          className="primary"
          disabled={
            !selectedDevice ||
            selectedDevice.status !== "ready" ||
            loadingMessages
          }
          onClick={() => void loadMessages(true)}
          title="Requires the phone to be connected and trusted"
        >
          <FiRefreshCw /> {loadingMessages ? "Updating..." : "Update backup"}
        </button>
      </header>

      {(error || notice) && (
        <div className={`messages-notice ${error ? "error" : ""}`}>
          {error || notice}
        </div>
      )}

      <section className="messages-layout">
        <aside className="conversation-directory">
          <div className="conversation-header">
            <label className="conversation-search">
              <FiSearch />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search conversations & messages"
              />
            </label>
            <button
              onClick={() => setShowAddressBook(true)}
              className="address-book-button"
              title="View saved contacts"
            >
              <FiBook /> Address Book
            </button>
          </div>
          <div className="conversation-list">
            {filteredThreads.map((thread) => {
              const lastMessage = thread.messages[thread.messages.length - 1];
              const isEditing = editingThreadId === thread.threadId;
              return (
                <div
                  key={thread.threadId}
                  className={`conversation-item ${thread.threadId === selectedThreadId ? "active" : ""}`}
                >
                  {isEditing ? (
                    <div className="thread-edit-container">
                      <input
                        type="text"
                        value={editingThreadName}
                        onChange={(e) => setEditingThreadName(e.target.value)}
                        placeholder={thread.address}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveThreadName(thread);
                          if (e.key === "Escape") {
                            setEditingThreadId(null);
                            setEditingThreadName("");
                          }
                        }}
                      />
                      <button
                        onClick={() => void saveThreadName(thread)}
                        className="thread-action-save"
                        title="Save"
                      >
                        <FiSave />
                      </button>
                      <button
                        onClick={() => {
                          setEditingThreadId(null);
                          setEditingThreadName("");
                        }}
                        className="thread-action-cancel"
                        title="Cancel"
                      >
                        <FiX />
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        className="conversation-button"
                        onClick={() => setSelectedThreadId(thread.threadId)}
                      >
                        <Avatar
                          name={conversationName(thread)}
                          platform={platform}
                          size={platform === "ios" ? 44 : 40}
                        />
                        <span className="conversation-text">
                          <span className="conversation-title-row">
                            <strong>{conversationName(thread)}</strong>
                            <time>
                              {formatThreadDate(
                                thread.lastMessageDate,
                                platform,
                              )}
                            </time>
                          </span>
                          <span className="conversation-preview">
                            {lastMessage
                              ? messageText(lastMessage)
                              : "No messages"}
                          </span>
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          setEditingThreadId(thread.threadId);
                          setEditingThreadName(thread.displayName || "");
                        }}
                        className="thread-action-edit"
                        title="Rename conversation"
                        aria-label="Rename conversation"
                      >
                        <FiEdit2 />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            {!loadingMessages && filteredThreads.length === 0 && (
              <div className="messages-empty">
                <FiMessageSquare />
                <span>
                  {historyEntries.length
                    ? "Load saved message history."
                    : devices.length
                      ? "Load a phone to view conversations."
                      : "Connect a phone to create message history."}
                </span>
              </div>
            )}
          </div>
        </aside>

        <article className="message-history">
          {selectedThread ? (
            <div className="phone-frame">
              <div className="phone-status-bar">
                <span>
                  {new Date()
                    .toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })
                    .replace(/\s?[AP]M$/i, "")}
                </span>
                <span className="phone-camera" aria-hidden="true" />
                <span className="phone-status-icons">
                  <FiWifi />
                  <FiBattery />
                </span>
              </div>
              <header className="phone-thread-header">
                <span className="phone-back" aria-hidden="true">
                  <FiChevronLeft />
                </span>
                <Avatar
                  name={conversationName(selectedThread)}
                  platform={platform}
                  size={platform === "ios" ? 40 : 34}
                />
                <div className="phone-thread-title">
                  <strong>{conversationName(selectedThread)}</strong>
                  <span>
                    {selectedThread.messageCount.toLocaleString()} messages
                  </span>
                </div>
              </header>
              <div className="message-bubbles">
                {selectedThread.messages.length === 0 ? (
                  <div className="messages-empty history">
                    <FiMessageSquare />
                    <span>No messages are stored in this conversation.</span>
                  </div>
                ) : (
                  selectedThread.messages.map((message, index) => {
                    const previous = selectedThread.messages[index - 1];
                    const showDivider =
                      !previous ||
                      new Date(previous.date).toDateString() !==
                        new Date(message.date).toDateString() ||
                      message.date - previous.date > DIVIDER_GAP_MS;
                    const isSent = message.type === 2;
                    const nextMessage = selectedThread.messages[index + 1];
                    const nextStartsSection =
                      nextMessage &&
                      (new Date(nextMessage.date).toDateString() !==
                        new Date(message.date).toDateString() ||
                        nextMessage.date - message.date > DIVIDER_GAP_MS);
                    const firstInGroup =
                      showDivider || (previous.type === 2) !== isSent;
                    const lastInGroup =
                      !nextMessage ||
                      nextStartsSection ||
                      (nextMessage.type === 2) !== isSent;
                    const divider = showDivider
                      ? formatDivider(message.date, platform)
                      : null;
                    return (
                      <React.Fragment key={message.id}>
                        {divider && (
                          <div className="message-date">
                            <strong>{divider.day}</strong>
                            {divider.clock}
                          </div>
                        )}
                        <div
                          className={`message-row ${isSent ? "sent" : "received"} ${firstInGroup ? "first-in-group" : ""} ${lastInGroup ? "last-in-group" : ""}`}
                        >
                          <div
                            className="message-bubble"
                            title={new Date(message.date).toLocaleString()}
                          >
                            <p>{messageText(message)}</p>
                            {(message.parts ?? [])
                              .filter(
                                (part) =>
                                  !part.text &&
                                  part.contentType !== "application/smil",
                              )
                              .map((part) => (
                                <MessageAttachment
                                  key={part.id}
                                  deviceId={selectedIdentity.deviceId}
                                  messageId={message.id}
                                  part={part}
                                />
                              ))}
                          </div>
                          {platform === "android" && lastInGroup && (
                            <time>
                              {new Date(message.date).toLocaleTimeString([], {
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </time>
                          )}
                        </div>
                      </React.Fragment>
                    );
                  })
                )}
              </div>
              <footer className="phone-compose" aria-hidden="true">
                {platform === "ios" && (
                  <span className="phone-compose-plus">
                    <FiPlus />
                  </span>
                )}
                <span className="phone-compose-field">
                  {platform === "ios" ? "iMessage" : "Text message"}
                </span>
                {platform === "android" && (
                  <span className="phone-compose-send">
                    <FiSend />
                  </span>
                )}
              </footer>
            </div>
          ) : (
            <div className="messages-empty history">
              <FiMessageSquare />
              <span>Select a conversation.</span>
            </div>
          )}
        </article>

        <aside className="message-export-sidebar">
          <h3>Save messages</h3>
          <p>
            {selectedThread
              ? "Save the selected conversation."
              : "Select a conversation to export it."}
          </p>
          <button onClick={() => void chooseDestination()}
            data-help="Choose the folder where the selected conversation export will be saved.">
            <FiDownload /> Choose destination
          </button>
          <span className="export-path" title={outputDir}>
            {outputDir || "No destination selected"}
          </span>
          <select
            value={format}
            data-help="Choose whether the conversation is exported as PDF, XML/text, or both."
            onChange={(event) => setFormat(event.target.value as typeof format)}
          >
            <option value="both">PDF + XML</option>
            <option value="pdf">PDF</option>
            <option value="xml">XML + text</option>
          </select>
          <button
            className="primary"
            disabled={!selectedThread || !outputDir || exporting}
            onClick={() => void exportMessages()}
            data-help="Save the selected conversation to the chosen folder in the selected format."
          >
            <FiDownload /> {exporting ? "Saving..." : "Save conversation"}
          </button>
          {selectedIdentity?.platform === "ios" && (
            <p className="ios-backup-note">
              iPhone viewing uses a local, unencrypted device backup stored
              inside Silo.
            </p>
          )}
        </aside>
      </section>
    </main>
  );
};

export default MessageExportPanel;
