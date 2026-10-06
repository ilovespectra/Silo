import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FiBookOpen, FiHelpCircle, FiSearch, FiX } from "react-icons/fi";
import type { GuidedTourSection } from "./GuidedTour";
import "./LocalHelpPanel.css";

export interface LocalHelpTopic {
  id: string;
  title: string;
  keywords: string;
  answer: string;
  section: GuidedTourSection;
  target: string;
  fallbackTarget?: string;
}

const HELP_ARTICLES: LocalHelpTopic[] = [
  {
    id: "app-sections",
    title: "Silo tabs and sections",
    keywords: "tabs pages navigation memories files people map duplicates mobile settings help overview",
    answer:
      "Memories is for reviewing and making story videos from indexed media. Files manages folder, Google, and saved-device sources, indexing, search, and file organization. People reviews face clusters and assignments; Map browses geotagged photos and updates their location metadata; Duplicates compares exact copies for careful cleanup; Mobile manages phone/tablet copies and message exports. Settings contains membership-license status, trusted-Wi-Fi library sharing, content protection, Memory and cache destinations, appearance, configuration backup/restore, and a button that opens the full Library Statistics dashboard. Help searches this offline guide and can spotlight the relevant control.",
    section: "files",
    target: '[data-tour="app-tabs"]',
  },
  {
    id: "sources-indexing",
    title: "Sources and indexing",
    keywords: "folder source add plus index progress phone google drive backup",
    answer:
      "In Files, use + beside Sources to add a folder. Silo starts indexing it automatically; follow the Library indexing stages below the source list. Google accounts and phones are added from their own sections. A source must be available and enabled to browse its files.",
    section: "files",
    target: '[data-tour="sources-add"]',
  },
  {
    id: "source-management",
    title: "Include, browse, refresh, and copy sources",
    keywords: "source include exclude enable disable select all none browse refresh clone copy shelter destination source sort",
    answer:
      "In Files → Sources, use Select all/Select none to set the library scope, the check button on an available source to include or exclude it, and the arrow to browse it. Refresh updates availability. Clone opens the shelter-copy flow, which preserves originals and verifies the copied data. Use Sort sources to organize the source list.",
    section: "files",
    target: '[data-tour="source-controls"]',
    fallbackTarget: '[data-tour="sources-add"]',
  },
  {
    id: "semantic-search",
    title: "Semantic search",
    keywords: "search meaning local offline clip query photo document",
    answer:
      "Use the search field in Files to describe an image or document in ordinary language. Search works against Silo’s local index, so new sources need time to index before they are fully searchable. You can search across enabled sources and refine results with filters.",
    section: "files",
    target: '[data-tour="semantic-search"]',
  },
  {
    id: "digital-folders",
    title: "Digital folders",
    keywords: "virtual folder collection organize plus rename reorder move",
    answer:
      "Digital folders are virtual collections of references. Create one with + in the sidebar, then add or remove files using the collection controls. Renaming, reordering, or deleting a digital folder does not rename, move, or delete the original source files.",
    section: "files",
    target: '[data-tour="digital-folders"]',
  },
  {
    id: "file-actions",
    title: "Rename and move files",
    keywords: "file rename move new folder physical virtual name disk",
    answer:
      "Select a file in Files to enable its toolbar actions. Move opens a destination chooser and changes the file’s real location. The pencil action is Set virtual name: it changes Silo’s display and search label, not the filename on disk. New folder creates a real folder in the current source. Review each destination before confirming.",
    section: "files",
    target: '[data-tour="file-actions"]',
  },
  {
    id: "people-scan",
    title: "People and face indexing",
    keywords: "people face detection scan start pause offline photos",
    answer:
      "Face detection is a separate, optional offline indexing task in People. Use Start face indexing when you are ready and pause it if needed. Review detected clusters before confirming matches; files are not moved by face scanning.",
    section: "people",
    target: '[data-tour="face-indexing"]',
  },
  {
    id: "people-manage",
    title: "Add, edit, move, and merge people",
    keywords: "person add edit rename move face assignment cluster merge undo",
    answer:
      "Use New Person to create a named profile. Open a person to review photos and use Rename. Right-click or Shift-click a photo to manage its detected faces and change an assignment. Merge into… moves all photos into the chosen person, keeps confirmed states, removes the source profile, and can be undone with ⌘Z after confirmation.",
    section: "people",
    target: '[data-tour="person-actions"]',
    fallbackTarget: '[data-tour="people-index"]',
  },
  {
    id: "people-confirmed-banned",
    title: "Confirmed faces and banned people",
    keywords: "people confirmed faces banned show hide ban unban profile status safety settings",
    answer:
      "In People, switch to Confirmed faces to review confirmed profiles and the Banned people area. Show faces reveals or hides banned identities in that area; Settings → Show banned people controls whether their photos can appear elsewhere in Silo. Ban hides matching photos throughout the app but does not change files on disk.",
    section: "people",
    target: '[data-tour="people-status-tabs"]',
    fallbackTarget: '[data-tour="people-page"]',
  },
  {
    id: "map-locations",
    title: "Map and photo locations",
    keywords: "map globe location relocate geotag metadata place search",
    answer:
      "Map groups geotagged photos by location. Open a region and select photos to reveal Relocate. Search for a place or choose Use embedded location in the location picker. Choosing a place assigns it to the selected photos; inspect the selection and place before applying.",
    section: "map",
    target: '[data-tour="map-relocate"]',
    fallbackTarget: '[data-tour="map-overview"]',
  },
  {
    id: "protection",
    title: "Content protection",
    keywords: "settings nsfw explicit banned people parental password privacy",
    answer:
      "Settings contains Content protection. Explicit images are hidden and excluded from search by default; the settings explain how to show them, how banned people appear, and how to configure a parental password. Password-protected changes ask for confirmation credentials.",
    section: "settings",
    target: '[data-tour="content-protection"]',
  },
  {
    id: "statistics",
    title: "Library statistics",
    keywords: "stats statistics inventory sources coverage indexing backup health",
    answer:
      "Open Settings and select Open statistics dashboard to view inventory totals, per-source availability, indexed-file counts, running stages, and shelter-copy status. You can refresh inventory measurements, choose sources for backup, create and verify a primary shelter copy, and verify a replica on another volume. Review the destination and verification status before starting a copy.",
    section: "settings",
    target: '[data-tour="library-statistics"]',
  },
  {
    id: "help-pointer",
    title: "Search help and point to a control",
    keywords: "help search chatbot bot local offline tooltip hover pointer walkthrough circle show in silo",
    answer:
      "Silo Help searches built-in guidance locally; it does not call a live AI service. Ask about a feature, then choose Show this control in Silo to open the relevant page and highlight its control. During the tour, the dimmed overlay prevents accidental clicks; choose Not now or Finish when you want to interact with the app.",
    section: "files",
    target: '[data-tour="help-button"]',
  },
  {
    id: "lifetime-access",
    title: "Membership license and device access",
    keywords: "settings membership license lifetime paid beta USDC Solana QR transaction signature unlock add device two devices authorize approve rename remove Mac computer",
    answer:
      "Silo offers $25 USDC once on Solana for lifetime access, not a recurring subscription. The listed benefits include unlimited sources and files, digital folders and Memory previews, and mapped locations. If active, Settings shows the license state on this Mac; View lifetime license opens the license information panel. The unlicensed panel offers Solana Pay, manual transaction-signature verification, and beta-access request options. In a build with the secured two-device flow, activate the first Mac through its own Solana Pay request and wait for finalized confirmation. If verifying manually, use the signature for that request; the relay binds its unique reference to the installation, so a transaction signature alone cannot claim an empty license. To add a second Mac, enter the original payment signature there to create a pending request; an already-authorized Mac must approve or decline it. The device manager supports naming, renaming, and removing devices, allows at most two, and requires at least one to remain. A removed Mac loses saved paid access at its next successful online authorization check; offline use or a temporary relay failure alone does not revoke access. These steps require the updated client and a deployed, reachable licensing relay. This checkout's manual signature verification is not reference-bound and does not enforce a shared device registry; its Settings/license UI also lacks the device manager. Do not treat this checkout as enforcing the secured two-device flow.",
    section: "settings",
    target: '[data-tour="settings-license"]',
  },
  {
    id: "settings-password",
    title: "Parental password",
    keywords: "settings password parental create change protection nsfw",
    answer:
      "Settings → Content protection lets you create or change a parental password. It authorizes protected-setting changes; Silo says the password itself is never stored. The tour does not request or change it.",
    section: "settings",
    target: '[data-tour="settings-password"]',
  },
  {
    id: "mobile",
    title: "Mobile devices and messages",
    keywords: "mobile phone device iphone android messages backup browse rename",
    answer:
      "The Mobile tab puts the phone manager above message browsing/export. Scan for a device, review its status, then choose Browse or a backup action. Browseable snapshots retain dated copies of files exposed over USB. iPhone and iPad can also create encrypted, timestamped Apple restore archives; Android snapshots cover accessible shared files, not app data or settings. Review the device, password, destination, and restore scope before starting.",
    section: "mobile",
    target: '[data-tour="mobile-devices"]',
  },
  {
    id: "mobile-device-actions",
    title: "Connect, browse, and name devices",
    keywords: "mobile devices phone tablet scan connect browse rename disconnect unmount backup destination",
    answer:
      "Scan devices refreshes discovery. Connect or unmount manages a live USB connection; Browse opens files accessible from a ready device; Rename changes Silo’s device label. Choose the browseable-copy destination separately. A saved phone snapshot can be browsed as a source while its destination is available.",
    section: "mobile",
    target: '[data-tour="mobile-device-actions"]',
    fallbackTarget: '[data-tour="mobile-devices"]',
  },
  {
    id: "mobile-backups",
    title: "Browseable snapshots and restore archives",
    keywords: "phone mobile backup snapshot restore archive encrypted timestamp iOS iPhone iPad Android shared files password scope",
    answer:
      "Browseable snapshots keep dated copies of files exposed over USB. iPhone and iPad can also create encrypted, timestamped Apple restore archives that follow Apple’s exclusions; they are not raw disk images. Android snapshots cover accessible shared files, not app data or settings. Set a destination and verify the displayed scope before starting.",
    section: "mobile",
    target: '[data-tour="mobile-backup-settings"]',
    fallbackTarget: '[data-tour="mobile-devices"]',
  },
  {
    id: "duplicates",
    title: "Duplicates",
    keywords: "duplicate files photos review compare remove",
    answer:
      "The Duplicates tab groups likely duplicate items for review. Compare the files and their source paths before using a cleanup action; the help guide does not select or delete anything for you.",
    section: "duplicates",
    target: '[data-tour="duplicates-overview"]',
  },
  {
    id: "memories",
    title: "Memories",
    keywords: "memory memories video movie collection create export",
    answer:
      "Memories turns selected library moments into a reviewable story or video. Browse suggestions, adjust the selection and presentation, and verify the configured destination before exporting. Creating or exporting a memory is separate from background photo indexing.",
    section: "memories",
    target: '[data-tour="memories-overview"]',
  },
  {
    id: "memory-topic",
    title: "Create a memory from a topic",
    keywords: "memories custom topic phrase place mood theme local search create story photos",
    answer:
      "In Memories, enter a phrase of at least three characters under Suggest a topic, such as “Rainy Sundays.” Silo searches indexed photos on this device and creates a story when matching material is available, with a locally selected soundtrack. This does not change original files or use an online AI service.",
    section: "memories",
    target: '[data-tour="memory-topic"]',
  },
  {
    id: "map-controls",
    title: "Map controls and location tools",
    keywords: "globe rotate compass solar time select circle rectangle countries sort region album location",
    answer:
      "Map’s top controls refresh locations, choose rectangle or circle selection, and switch between location bubbles and whole regions. The globe controls orient north, pause rotation, or change the viewed solar time. Open a region for sorting, album/person actions, search, and selected-photo relocation.",
    section: "map",
    target: '[data-tour="map-selection-tools"]',
    fallbackTarget: '[data-tour="map-overview"]',
  },
  {
    id: "map-globe-controls",
    title: "Globe orientation and lighting",
    keywords: "map globe compass north rotation pause resume solar time daylight night here lighting",
    answer:
      "The compass resets the globe north-up, and the rotation button pauses or resumes globe movement. These controls only affect map presentation.",
    section: "map",
    target: '[data-tour="map-globe-controls"]',
  },
  {
    id: "map-solar-controls",
    title: "Solar time and globe lighting",
    keywords: "map solar time daylight night day here night here lighting sun globe",
    answer:
      "View solar time adjusts the displayed daylight boundary. Day here and Night here align it with the current globe view. These controls affect the map presentation only, not photo metadata.",
    section: "map",
    target: '[data-tour="map-solar-controls"]',
  },
  {
    id: "file-toolbar",
    title: "Files toolbar and view controls",
    keywords: "files toolbar explode flatten folder move virtual name keywords list grid thumbnails sort order filters select all",
    answer:
      "Grid is the default thumbnail view; select List for detailed rows. Sort & Filter opens file-type, year, people, and location filters plus sort order in either view. The rest of Files’ toolbar can flatten nested results (Explode), create a real folder, move a selected file, set a virtual name, and edit search keywords. Select files first to enable actions. Back, Forward, Parent, and Refresh navigate the current source; selection-sensitive actions remain disabled until they apply.",
    section: "files",
    target: '[data-tour="file-actions"]',
  },
  {
    id: "mobile-messages",
    title: "Messages and export controls",
    keywords: "messages export device phone load history update backup destination conversation contacts",
    answer:
      "In Mobile’s Messages area, choose a connected phone or saved history, then load the history. Update backup requires a connected and trusted phone. Review contact/conversation naming and the output folder and format before exporting. Exports are user-triggered; this guide never reads or exports messages.",
    section: "mobile",
    target: '[data-tour="mobile-messages"]',
  },
  {
    id: "memory-controls",
    title: "Memory story and export controls",
    keywords: "memories stories mood frame duration soundtrack music export download suggestion clear refresh",
    answer:
      "Refresh updates the current cards; Generate or Find new memories searches the indexed archive when you choose. On a story, review its photos, mood, duration, and soundtrack before exporting. Choose location & export opens the destination flow. Remove suggestion and Clear suggestions remove cards only; original media is kept.",
    section: "memories",
    target: '[data-tour="memory-controls"]',
    fallbackTarget: '[data-tour="memories-overview"]',
  },
  {
    id: "settings-library-share",
    title: "Share a library over trusted Wi-Fi",
    keywords: "settings library share Wi-Fi local network link phone browse search preview download photos videos stop sharing security unencrypted",
    answer:
      "Settings → Share a library lets you choose indexed local libraries and start a private-network share. Anyone with its link on the same network can browse, search, preview, and download included photos and videos; other Silo tools stay private. The link uses unencrypted local HTTP, so use trusted private Wi-Fi only. Stop sharing or quit Silo to end access. Starting and stopping a share are deliberate actions; the guide does neither.",
    section: "settings",
    target: '[data-tour="library-share"]',
  },
  {
    id: "settings-cache-destination",
    title: "Silo cache destination",
    keywords: "settings cache index storage external drive thumbnails previews faces places move destination restart verify old cache",
    answer:
      "Settings → Silo Cache Destination shows where Silo stores indexes, face/place data, thumbnails, previews, and other generated cache files. Choose cache destination opens a folder picker; Silo restarts, verifies the copied cache, and then removes the old cache. It does not move original source files or settings. Keep the destination drive connected. The help guide never changes the destination.",
    section: "settings",
    target: '[data-tour="settings-cache-destination"]',
  },
  {
    id: "settings-appearance",
    title: "Appearance and behavior settings",
    keywords: "settings theme light dark system appearance globe rotate",
    answer:
      "Settings → Appearance & behavior controls System, Dark, or Light theme and automatic globe rotation when Map opens.",
    section: "settings",
    target: '[data-tour="settings-appearance"]',
  },
  {
    id: "settings-memory-storage",
    title: "Memory movie destination",
    keywords: "settings memories save destination storage location app folder movie",
    answer:
      "Settings → Memories shows where generated movies are saved. Choose destination to select another folder, or Use app storage to return to Silo’s local app storage. This setting does not move source media.",
    section: "settings",
    target: '[data-tour="settings-memories"]',
  },
  {
    id: "settings-backup-restore",
    title: "Silo configuration backup and restore",
    keywords: "settings export import config backup restore tokens passwords restart phone backups",
    answer:
      "Settings → Backup & restore exports Silo’s setup and indexed knowledge to a config file. Review an import before applying it: restoring replaces the current Silo setup and restarts the app, but does not touch photos or other source files. Phone backups are not included. Protect exported config files because they can contain sign-in tokens.",
    section: "settings",
    target: '[data-tour="settings-backup"]',
  },
  {
    id: "duplicate-review",
    title: "Duplicate scan and review safety",
    keywords: "duplicates scan exact bytes retain protect keep select removed trash restore permanent delete",
    answer:
      "Scan library compares exact file contents. The first retained file in each group is protected; selectable copies can be moved to Review removed, where they remain recoverable. Select items and use Restore to return them. Delete selected permanently or Clear all permanently cannot be undone, so verify the list and selection first.",
    section: "duplicates",
    target: '[data-tour="duplicate-trash-actions"]',
    fallbackTarget: '[data-tour="duplicates-review-tab"]',
  },
  {
    id: "sources-cloud-phones",
    title: "Google and phone sources",
    keywords: "google drive account reconnect browse photos pick sign out phone tablet source backup",
    answer:
      "The Files sidebar contains Google Accounts and phone/device sources in addition to folder sources. Their controls add or reconnect accounts, browse available files, or choose photos; removing access and disconnecting a device are separate actions. Check the label and availability before browsing or indexing.",
    section: "files",
    target: '[data-tour="google-sources"]',
  },
];

interface LocalHelpPanelProps {
  onClose: () => void;
  onStartTour: () => void;
  onShowInApp: (topic: LocalHelpTopic) => void;
}

export default function LocalHelpPanel({
  onClose,
  onStartTour,
  onShowInApp,
}: LocalHelpPanelProps) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [activeArticleId, setActiveArticleId] = useState("");
  const matchingArticles = useMemo(() => {
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return HELP_ARTICLES;
    return HELP_ARTICLES.filter((article) => {
      const haystack = `${article.title} ${article.keywords} ${article.answer}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    }).sort((first, second) => {
      const score = (article: LocalHelpTopic) =>
        terms.reduce((total, term) => {
          const title = article.title.toLowerCase();
          const answer = article.answer.toLowerCase();
          return total + (title.includes(term) ? 4 : 0) + (answer.includes(term) ? 1 : 0);
        }, 0);
      return score(second) - score(first);
    });
  }, [query]);
  const activeArticle =
    HELP_ARTICLES.find((article) => article.id === activeArticleId) ?? null;

  const submitQuestion = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = query.trim();
    setSubmittedQuery(question);
    setActiveArticleId(matchingArticles[0]?.id ?? "");
  };

  return createPortal(
    <div
      className="local-help-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="local-help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-help-title"
      >
        <header className="local-help-header">
          <div>
            <FiHelpCircle aria-hidden="true" />
            <div>
              <h2 id="local-help-title">Silo Help</h2>
              <p>Answers from this built-in guide; no live AI or network calls.</p>
            </div>
          </div>
                <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            title="Close help"
          >
            <FiX />
          </button>
        </header>
        <form className="local-help-question" onSubmit={submitQuestion}>
          <FiSearch aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Ask about sources, people, maps…"
            aria-label="Search built-in help"
          />
          <button type="submit">Ask</button>
        </form>
        <div className="local-help-conversation" aria-live="polite">
          {submittedQuery && (
            <div className="local-help-user-bubble">{submittedQuery}</div>
          )}
          {activeArticle ? (
            <article className="local-help-answer">
              <h3>
                <FiBookOpen aria-hidden="true" /> {activeArticle.title}
              </h3>
              <p>{activeArticle.answer}</p>
              <button
                type="button"
                className="local-help-show-control"
                onClick={() => onShowInApp(activeArticle)}
                >
                  Show this control in Silo
                </button>
              {matchingArticles.length > 1 && (
                <div className="local-help-related">
                  <span>Related topics</span>
                  {matchingArticles
                    .filter((article) => article.id !== activeArticle.id)
                    .slice(0, 4)
                    .map((article) => (
                      <button
                        type="button"
                        key={article.id}
                        onClick={() => setActiveArticleId(article.id)}
                      >
                        {article.title}
                      </button>
                    ))}
                </div>
              )}
            </article>
          ) : submittedQuery ? (
            <div className="local-help-answer" role="status">
              I couldn’t find that in the built-in guide. Try “indexing,” “move
              a person,” “relocate photos,” or “backup health.”
            </div>
          ) : (
            <div className="local-help-answer local-help-welcome">
              Ask a question or choose a topic. Answers come only from this
              searchable local catalogue.
            </div>
          )}
        </div>
        <footer className="local-help-footer">
          <span>{matchingArticles.length} topics</span>
          <button type="button" className="local-help-tour" onClick={onStartTour}>
            Start guided tour
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
