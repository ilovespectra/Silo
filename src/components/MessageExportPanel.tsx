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
  FiEdit2,
  FiBook,
  FiSave,
  FiStar,
  FiEye,
  FiEyeOff,
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

function messagePreferenceKey(
  platform: PhonePlatform,
  deviceId: string,
  threadId: string,
  messageId: string,
) {
  return JSON.stringify([platform, deviceId, threadId, messageId]);
}

export const MessageExportPanel: React.FC<{
  devicePanel?: React.ReactNode;
  phoneDevices: PhoneDevice[];
  connectedPhone: PhoneDevice | null;
  onScanPhones: () => void;
  scanningPhones: boolean;
  showHiddenMessages: boolean;
}> = ({
  devicePanel,
  phoneDevices,
  connectedPhone,
  onScanPhones,
  scanningPhones,
  showHiddenMessages,
}) => {
  const electronAPI = window.electron;
  const devices = phoneDevices;
  const [historyEntries, setHistoryEntries] = useState<MessageHistoryEntry[]>(
    [],
  );
  const [phoneMessageBackup, setPhoneMessageBackup] =
    useState<PhoneMessageBackupMetadata | null>(null);
  const [selectedDeviceKey, setSelectedDeviceKey] = useState("");
  const [mobileWorkflow, setMobileWorkflow] = useState<"devices" | "messages">("devices");
  const [threads, setThreads] = useState<DeviceMessageThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [query, setQuery] = useState("");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [format, setFormat] = useState<"xml" | "pdf" | "both">("both");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [showAddressBook, setShowAddressBook] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingThreadName, setEditingThreadName] = useState("");
  const [messageFlags, setMessageFlags] = useState<
    Record<string, MessageDisplayFlags>
  >({});
  const [messageSort, setMessageSort] = useState<
    PersistedUiState["messageSort"]
  >("newest");

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
  const preferenceKeyFor = (threadId: string, messageId: string) =>
    selectedIdentity
      ? messagePreferenceKey(
          selectedIdentity.platform,
          selectedIdentity.deviceId,
          threadId,
          messageId,
        )
      : "";
  const isMessageHidden = (threadId: string, messageId: string) =>
    Boolean(messageFlags[preferenceKeyFor(threadId, messageId)]?.hidden);
  const filteredThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized && showHiddenMessages) return threads;
    return threads.filter(
      (thread) =>
        !normalized ||
        conversationName(thread).toLowerCase().includes(normalized) ||
        thread.messages.some(
          (message) =>
            (showHiddenMessages ||
              !messageFlags[
                selectedIdentity
                  ? messagePreferenceKey(
                      selectedIdentity.platform,
                      selectedIdentity.deviceId,
                      thread.threadId,
                      message.id,
                    )
                  : ""
              ]?.hidden) &&
            messageText(message).toLowerCase().includes(normalized),
        ),
    );
  }, [
    query,
    threads,
    messageFlags,
    selectedIdentity?.deviceId,
    selectedIdentity?.platform,
    showHiddenMessages,
  ]);

  const visibleMessages = useMemo(() => {
    if (!selectedThread || !selectedIdentity) return [];
    return selectedThread.messages
      .filter(
        (message) =>
          showHiddenMessages ||
          !messageFlags[
            messagePreferenceKey(
              selectedIdentity.platform,
              selectedIdentity.deviceId,
              selectedThread.threadId,
              message.id,
            )
          ]?.hidden,
      )
      .sort((first, second) => {
        if (messageSort === "favorites") {
          const firstFavorite = messageFlags[
            messagePreferenceKey(
              selectedIdentity.platform,
              selectedIdentity.deviceId,
              selectedThread.threadId,
              first.id,
            )
          ]?.favorite;
          const secondFavorite = messageFlags[
            messagePreferenceKey(
              selectedIdentity.platform,
              selectedIdentity.deviceId,
              selectedThread.threadId,
              second.id,
            )
          ]?.favorite;
          if (firstFavorite !== secondFavorite)
            return firstFavorite ? -1 : 1;
          return second.date - first.date;
        }
        return messageSort === "oldest"
          ? first.date - second.date
          : second.date - first.date;
      });
  }, [
    selectedThread,
    selectedIdentity?.deviceId,
    selectedIdentity?.platform,
    messageFlags,
    messageSort,
    showHiddenMessages,
  ]);

  React.useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    void electronAPI
      .getAppState()
      .then((state) => {
        if (!active) return;
        setMessageFlags(state.messageFlags ?? {});
        if (
          state.ui.messageSort === "oldest" ||
          state.ui.messageSort === "favorites"
        )
          setMessageSort(state.ui.messageSort);
        else setMessageSort("newest");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [electronAPI]);

  React.useEffect(() => {
    if (!electronAPI || selectedIdentity?.platform !== "ios") {
      setPhoneMessageBackup(null);
      return;
    }
    let active = true;
    setPhoneMessageBackup(null);
    void electronAPI
      .getPhoneMessageBackupMetadata(
        selectedIdentity.deviceId,
        selectedIdentity.platform,
      )
      .then((metadata) => {
        if (active) setPhoneMessageBackup(metadata);
      })
      .catch(() => {
        if (active) setPhoneMessageBackup(null);
      });
    return () => {
      active = false;
    };
  }, [
    electronAPI,
    selectedIdentity?.deviceId,
    selectedIdentity?.platform,
  ]);

  React.useEffect(() => {
    // Scan through the parent so the Messages pane and phone controls share one device state.
    if (!electronAPI) return;
    onScanPhones();
    void electronAPI.getPhoneBackupDestination().then((dest) => {
      console.log(`[MessageExportPanel] Loaded backup destination: ${dest}`);
      if (dest) setOutputDir(dest);
    });
  }, [electronAPI, onScanPhones]);

  React.useEffect(() => {
    if (!electronAPI) return;
    let active = true;
    void electronAPI
      .listMessageHistory()
      .then((entries) => {
        if (active) setHistoryEntries(entries);
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

  const loadMessagesRef = React.useRef<(refresh?: boolean, identity?: typeof selectedIdentity) => Promise<void>>();
  const selectedKeyRef = React.useRef(selectedDeviceKey);
  const manuallySelectedDeviceRef = React.useRef(false);
  selectedKeyRef.current = selectedDeviceKey;

  React.useEffect(() => {
    if (!electronAPI?.onPhoneMessagesUpdated) return;
    return electronAPI.onPhoneMessagesUpdated(async (update) => {
      const key = `${update.platform}:${update.deviceId}`;
      if (update.platform === "ios") {
        const metadata = await electronAPI
          .getPhoneMessageBackupMetadata(update.deviceId, update.platform)
          .catch(() => null);
        if (selectedKeyRef.current === key)
          setPhoneMessageBackup(metadata);
      }
      const entries = await electronAPI.listMessageHistory().catch(() => null);
      if (entries) setHistoryEntries(entries);
      const entry = entries?.find((item) => `${item.platform}:${item.deviceId}` === key);
      if (!entry || (selectedKeyRef.current && selectedKeyRef.current !== key)) return;
      setSelectedDeviceKey(key);
      void loadMessagesRef.current?.(false, entry);
    });
  }, [electronAPI]);

  React.useEffect(() => {
    if (manuallySelectedDeviceRef.current) return;
    const device =
      (connectedPhone?.status === "ready" ? connectedPhone : null) ??
      devices.find((candidate) => candidate.platform === "ios" && candidate.status === "ready") ??
      devices.find((candidate) => candidate.status === "ready");
    const history = historyEntries[0];
    const identity = device
      ? { deviceId: device.id, platform: device.platform, deviceName: device.name }
      : selectedDeviceKey
        ? null
        : history;
    if (!identity) return;
    const key = `${identity.platform}:${identity.deviceId}`;
    if (selectedDeviceKey === key) return;
    setSelectedDeviceKey(key);
    void loadMessagesRef.current?.(false, identity);
  }, [connectedPhone, devices, historyEntries, selectedDeviceKey]);

  const loadMessages = async (refresh = false, identity = selectedIdentity) => {
    if (!electronAPI || !identity) return;
    const connected =
      (connectedPhone?.platform === identity.platform &&
      connectedPhone.id === identity.deviceId
        ? connectedPhone
        : null) ??
      devices.find(
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
      if (identity.platform === "ios") {
        const metadata = await electronAPI
          .getPhoneMessageBackupMetadata(identity.deviceId, identity.platform)
          .catch(() => null);
        setPhoneMessageBackup(metadata);
      }
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

  loadMessagesRef.current = loadMessages;

  const toggleMessageFlag = async (
    threadId: string,
    messageId: string,
    field: "favorite" | "hidden",
  ) => {
    if (!electronAPI) return;
    const key = preferenceKeyFor(threadId, messageId);
    if (!key) return;
    const current = messageFlags[key] ?? { favorite: false, hidden: false };
    const nextValue = !current[field];
    const next = { ...current, [field]: nextValue };
    setMessageFlags((stored) => ({ ...stored, [key]: next }));
    setError("");
    try {
      const state = await electronAPI.updateMessageFlags(key, {
        [field]: nextValue,
      });
      setMessageFlags(state.messageFlags ?? {});
    } catch (cause) {
      setMessageFlags((stored) => ({ ...stored, [key]: current }));
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save this message preference.",
      );
    }
  };

  const changeMessageSort = (sort: PersistedUiState["messageSort"]) => {
    setMessageSort(sort);
    void electronAPI
      ?.updateUiState({ messageSort: sort })
      .catch(() => setError("Could not save the message sort order."));
  };

  const chooseDestination = async () => {
    const selected = await electronAPI?.selectBackupDestination(outputDir);
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
      <div className="mobile-workflow-bar">
        <nav className="mobile-workflow-tabs" role="tablist" aria-label="Mobile workflows" data-tour="mobile-workflow-tabs">
          <button
            type="button"
            role="tab"
            id="mobile-devices-tab"
            aria-selected={mobileWorkflow === "devices"}
            aria-controls="mobile-devices-panel"
            className={mobileWorkflow === "devices" ? "active" : ""}
            onClick={() => setMobileWorkflow("devices")}
          >
            <FiWifi aria-hidden="true" /> Devices &amp; backups
          </button>
          <button
            type="button"
            role="tab"
            id="mobile-messages-tab"
            aria-selected={mobileWorkflow === "messages"}
            aria-controls="mobile-messages-panel"
            className={mobileWorkflow === "messages" ? "active" : ""}
            onClick={() => setMobileWorkflow("messages")}
          >
            <FiMessageSquare aria-hidden="true" /> Messages
          </button>
        </nav>
        <button
          type="button"
          className="mobile-scan-button"
          disabled={scanningPhones}
          onClick={onScanPhones}
          title="Find phones connected to this Mac. Scanning does not start a backup."
          data-help="Discover connected phones and tablets. Scanning only finds devices; choose Back up now to save a snapshot."
        >
          <FiRefreshCw className={scanningPhones ? "spinning" : ""} aria-hidden="true" />
          {scanningPhones ? "Scanning…" : "Scan for phones"}
        </button>
      </div>

      <section
        className="mobile-workflow-panel mobile-devices-workflow"
        id="mobile-devices-panel"
        role="tabpanel"
        aria-labelledby="mobile-devices-tab"
        data-tour="mobile-device-workflow"
        hidden={mobileWorkflow !== "devices"}
      >
        {devicePanel ?? (
          <div className="mobile-device-workflow-empty">
            <FiWifi aria-hidden="true" />
            <h2>Connect a phone to get started</h2>
            <p>Scan for a connected phone, then choose when to make a separate browseable snapshot.</p>
          </div>
        )}
      </section>

      <section
        className="mobile-workflow-panel mobile-messages-workflow"
        id="mobile-messages-panel"
        role="tabpanel"
        aria-labelledby="mobile-messages-tab"
        data-tour="mobile-message-workflow"
        hidden={mobileWorkflow !== "messages"}
      >
      <header className="messages-toolbar">
        <h2>Message history</h2>
        <div className="messages-device-select-tools">
          <select
            aria-label="Phone message history"
            value={selectedDeviceKey}
            onChange={(event) => {
              manuallySelectedDeviceRef.current = true;
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
              ...historyEntries
                .filter(
                  (entry) =>
                    !devices.some(
                      (device) =>
                        device.platform === entry.platform &&
                        device.id === entry.deviceId,
                    ),
                )
                .map(
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
            ]).values(),
          ).map((option) => (
            <option key={option.key} value={option.key}>
              {option.name} · {option.platform === "ios" ? "iPhone" : "Android"}{" "}
              · {option.suffix}
            </option>
          ))}
          </select>
        </div>
        <button
          className="messages-icon-button"
          disabled={
            !selectedDevice ||
            selectedDevice.status !== "ready" ||
            loadingMessages
          }
          onClick={() => void loadMessages(true)}
          title="Messages update automatically when the phone connects. Click to update now."
          aria-label="Update messages from phone now"
        >
          <FiRefreshCw className={loadingMessages ? "spinning" : ""} />
        </button>
      </header>

      {selectedIdentity?.platform === "ios" && (
        <div
          className={`phone-message-backup-status ${phoneMessageBackup?.included ? "included" : "pending"}`}
          role="status"
          title={phoneMessageBackup?.virtualPath ?? undefined}
        >
          {phoneMessageBackup?.included
            ? `Messages database included in phone snapshot · ${(phoneMessageBackup.size! / (1024 * 1024)).toFixed(1)} MB · Files: Messages/sms.db`
            : "Messages are not in this phone snapshot yet. Choose Update Messages from phone to create the backup."}
        </div>
      )}

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
              const lastMessage = [...thread.messages]
                .reverse()
                .find(
                  (message) =>
                    showHiddenMessages ||
                    !isMessageHidden(thread.threadId, message.id),
                );
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
                        title="Save this conversation name in Silo"
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
                              {lastMessage
                                ? formatThreadDate(lastMessage.date, platform)
                                : ""}
                            </time>
                          </span>
                          <span className="conversation-preview">
                            {lastMessage
                              ? messageText(lastMessage)
                              : thread.messages.length
                                ? "All messages are hidden"
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
                        title="Rename conversation in Silo"
                        aria-label="Rename conversation in Silo"
                      >
                        <FiEdit2 />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            {filteredThreads.length === 0 && (
              <div className="messages-empty">
                <FiMessageSquare />
                <span>
                  {loadingMessages
                    ? "Loading conversations…"
                    : selectedIdentity
                      ? "No conversations loaded. Update Messages from phone to create or refresh the backup."
                      : historyEntries.length
                        ? "Choose a saved message history."
                        : devices.length
                          ? "Select a phone to load message history."
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
                    {visibleMessages.length.toLocaleString()} of {selectedThread.messageCount.toLocaleString()} messages
                  </span>
                </div>
                <label className="message-sort-control">
                  <span>Sort</span>
                  <select
                    aria-label="Sort messages"
                    value={messageSort}
                    onChange={(event) =>
                      changeMessageSort(
                        event.target.value as PersistedUiState["messageSort"],
                      )
                    }
                  >
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                    <option value="favorites">Favorites first</option>
                  </select>
                </label>
              </header>
              <div className="message-bubbles">
                {visibleMessages.length === 0 ? (
                  <div className="messages-empty history">
                    <FiMessageSquare />
                    <span>
                      {selectedThread.messages.length > 0
                        ? "All messages are hidden. Turn on Display hidden messages in Settings to reveal them."
                        : "No messages are stored in this conversation."}
                    </span>
                  </div>
                ) : (
                  visibleMessages.map((message, index) => {
                    const preferenceKey = preferenceKeyFor(
                      selectedThread.threadId,
                      message.id,
                    );
                    const flags = messageFlags[preferenceKey] ?? {
                      favorite: false,
                      hidden: false,
                    };
                    const previous = visibleMessages[index - 1];
                    const showDivider =
                      !previous ||
                      new Date(previous.date).toDateString() !==
                        new Date(message.date).toDateString() ||
                      Math.abs(message.date - previous.date) > DIVIDER_GAP_MS;
                    const isSent = message.type === 2;
                    const nextMessage = visibleMessages[index + 1];
                    const nextStartsSection =
                      nextMessage &&
                      (new Date(nextMessage.date).toDateString() !==
                        new Date(message.date).toDateString() ||
                        Math.abs(nextMessage.date - message.date) > DIVIDER_GAP_MS);
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
                          className={`message-row ${isSent ? "sent" : "received"} ${firstInGroup ? "first-in-group" : ""} ${lastInGroup ? "last-in-group" : ""} ${flags.hidden ? "hidden-message" : ""}`}
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
                            <div className="message-bubble-actions">
                              {flags.hidden && (
                                <span className="hidden-message-label">Hidden</span>
                              )}
                              <button
                                type="button"
                                className={`message-flag-button favorite ${flags.favorite ? "active" : ""}`}
                                aria-label={flags.favorite ? "Remove message from favorites" : "Favorite message"}
                                aria-pressed={flags.favorite}
                                title={flags.favorite ? "Remove favorite" : "Favorite message"}
                                onClick={() =>
                                  void toggleMessageFlag(
                                    selectedThread.threadId,
                                    message.id,
                                    "favorite",
                                  )
                                }
                              >
                                <FiStar />
                              </button>
                              <button
                                type="button"
                                className={`message-flag-button hide ${flags.hidden ? "active" : ""}`}
                                aria-label={flags.hidden ? "Show message" : "Hide message"}
                                aria-pressed={flags.hidden}
                                title={flags.hidden ? "Show message" : "Hide message"}
                                onClick={() =>
                                  void toggleMessageFlag(
                                    selectedThread.threadId,
                                    message.id,
                                    "hidden",
                                  )
                                }
                              >
                                {flags.hidden ? <FiEye /> : <FiEyeOff />}
                              </button>
                            </div>
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
              <footer className="phone-compose">
                {platform === "ios" && (
                  <span className="phone-compose-plus" aria-hidden="true">
                    <FiPlus />
                  </span>
                )}
                <span className="phone-compose-field" aria-hidden="true">
                  {platform === "ios" ? "iMessage" : "Text message"}
                </span>
                <button
                  type="button"
                  className="save-thread-button"
                  disabled={!selectedThread || !outputDir || exporting}
                  onClick={() => void exportMessages()}
                  title="Save the selected conversation to the chosen folder"
                >
                  <FiDownload /> {exporting ? "Saving..." : "Save conversation"}
                </button>
                {platform === "android" && (
                  <span className="phone-compose-send" aria-hidden="true">
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
            title="Set the export destination in Silo"
            data-help="Choose and save the export destination in Silo. No conversation file is written until you export."
          >
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
          {selectedIdentity?.platform === "ios" && (
            <p className="ios-backup-note">
              iPhone viewing uses a local, unencrypted device backup stored
              inside Silo.
            </p>
          )}
        </aside>
      </section>
      </section>
    </main>
  );
};

export default MessageExportPanel;
