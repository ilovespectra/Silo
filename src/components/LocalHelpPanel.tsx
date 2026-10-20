import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  FiBookOpen,
  FiExternalLink,
  FiHelpCircle,
  FiSearch,
  FiX,
} from "react-icons/fi";
import type { GuidedTourSection } from "./GuidedTour";
import "./LocalHelpPanel.css";
import { GOOGLE_FEATURES_ENABLED } from "../featureFlags";

export interface LocalHelpTopic {
  id: string;
  guidePath: string;
  title: string;
  keywords: string;
  answer: string;
  section: GuidedTourSection;
  target: string;
  fallbackTarget?: string;
}

const ALL_HELP_ARTICLES: LocalHelpTopic[] = [
  {
    id: "app-sections",
    guidePath: "/",
    title: "Silo tabs and sections",
    keywords: "tabs pages navigation memories files people map duplicates mobile stats settings help overview",
    answer:
      "Memories is for reviewing and making story videos from indexed media. Files manages folder and saved-device sources, indexing, search, and file organization. People reviews face clusters and assignments; Map browses geotagged photos and updates their location metadata; Duplicates compares exact copies for careful cleanup; Mobile manages phone/tablet copies and message exports. Stats opens library inventory and indexing. Settings contains membership-license status, trusted-Wi-Fi library sharing, content protection, Memory and cache destinations, appearance, and configuration backup/restore. Help searches its offline answers and can spotlight the relevant control.",
    section: "files",
    target: '[data-tour="app-tabs"]',
  },
  {
    id: "sources-indexing",
    guidePath: "/guide/01-files-and-sources",
    title: "Sources and indexing",
    keywords: "folder source add plus index progress phone google drive backup",
    answer:
      "In Files, use + beside Sources to add a folder. Silo starts indexing it automatically; follow the Library indexing stages below the source list. Phones are added from Mobile. A source must be available and enabled to browse its files.",
    section: "files",
    target: '[data-tour="sources-add"]',
  },
  {
    id: "source-management",
    guidePath: "/guide/01-files-and-sources",
    title: "Include, browse, refresh, and copy sources",
    keywords: "source include exclude enable disable select all none browse refresh clone copy shelter destination source sort",
    answer:
      "In Files → Sources, use Select all/Select none to set the library scope, the check button on an available source to include or exclude it, and the arrow to browse it. Refresh updates availability. Create Fallout Shelter opens the clone flow, which preserves originals and verifies the copied data with SHA-256. Use Sort sources to organize the source list.",
    section: "files",
    target: '[data-tour="source-controls"]',
    fallbackTarget: '[data-tour="sources-add"]',
  },
  {
    id: "semantic-search",
    guidePath: "/guide/02-search-and-indexing",
    title: "Semantic search",
    keywords: "search meaning local offline clip query photo document",
    answer:
      "Use the search field in Files to describe an image or document in ordinary language. Search works against Silo’s local index, so new sources need time to index before they are fully searchable. You can search across enabled sources and refine results with filters.",
    section: "files",
    target: '[data-tour="semantic-search"]',
  },
  {
    id: "digital-folders",
    guidePath: "/guide/04-digital-folders",
    title: "Digital folders",
    keywords: "virtual folder collection organize plus rename reorder move",
    answer:
      "Digital folders are virtual collections of references. Create one with + in the sidebar, then add or remove files using the collection controls. Renaming, reordering, or deleting a digital folder does not rename, move, or delete the original source files.",
    section: "files",
    target: '[data-tour="digital-folders"]',
  },
  {
    id: "file-actions",
    guidePath: "/guide/01-files-and-sources",
    title: "Rename and move files",
    keywords: "file rename move new folder physical virtual name disk",
    answer:
      "Use the file controls to browse, rename labels, organize collections, or move items when available. Local source files stay in place unless you explicitly choose a move, folder creation, or backup action.",
    section: "files",
    target: '[data-tour="file-actions"]',
  },
  {
    id: "people-scan",
    guidePath: "/guide/03-people",
    title: "People and face indexing",
    keywords: "people face detection scan start pause offline photos",
    answer:
      "Face detection is a separate, optional offline indexing task in People. Use Start face indexing when you are ready and pause it if needed. Review detected clusters before confirming matches; files are not moved by face scanning.",
    section: "people",
    target: '[data-tour="face-indexing"]',
  },
  {
    id: "people-manage",
    guidePath: "/guide/03-people",
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
    guidePath: "/guide/03-people",
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
    guidePath: "/guide/05-map",
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
    guidePath: "/guide/11-settings-and-privacy",
    title: "Content protection",
    keywords: "settings nsfw explicit banned people parental password privacy",
    answer:
      "Settings contains Content protection. Explicit images are hidden and excluded from search by default; the settings explain how to show them, how banned people appear, and how to configure a parental password. Password-protected changes ask for confirmation credentials.",
    section: "settings",
    target: '[data-tour="content-protection"]',
  },
  {
    id: "statistics",
    guidePath: "/guide/10-backups",
    title: "Library statistics",
    keywords: "stats statistics inventory sources coverage indexing backup health",
    answer:
      "Open Stats in the main sidebar to access inventory totals, per-source availability, indexed-file counts, running stages, and Fallout Shelter copy status. You can refresh inventory measurements, choose sources for backup, create and verify a primary Fallout Shelter copy, and verify a replica on another volume. Review the destination and verification status before starting a copy.",
    section: "stats",
    target: '[data-tour="library-statistics"]',
  },
  {
    id: "help-pointer",
    guidePath: "/",
    title: "Search help and point to a control",
    keywords: "help search chatbot bot local offline tooltip hover pointer walkthrough circle show in silo",
    answer:
      "Silo Help searches built-in guidance locally; it does not call a live AI service. Ask about a feature, then choose Show this control in Silo to open the relevant page and highlight its control. During the tour, the dimmed overlay prevents accidental clicks; choose Not now or Finish when you want to interact with the app.",
    section: "files",
    target: '[data-tour="help-button"]',
  },
  {
    id: "lifetime-access",
    guidePath: "/guide/14-license-and-demo",
    title: "Membership license and device access",
    keywords: "settings membership license lifetime paid beta USDC Solana QR transaction signature unlock computer export import config",
    answer:
      "Silo offers $25 USDC once for lifetime access on one computer. Each computer needs its own lifetime license. Exporting or importing a Silo config can transfer settings and selected indexes, but it does not transfer a paid or beta license or the computer's installation ID. Unlock another computer with its own $25 payment. The unlicensed panel supports direct Solana Pay to Silo's wallet, manual verification of a transaction signature, and beta-access requests. A paid license activates only after the relay verifies a finalized USDC payment and binds it to this Silo installation. Settings shows whether this computer has an active license; View lifetime license opens its details. Keep the transaction signature private, and never share a wallet seed phrase or private key.",
    section: "settings",
    target: '[data-tour="settings-license"]',
  },
  {
    id: "settings-password",
    guidePath: "/guide/11-settings-and-privacy",
    title: "Parental password",
    keywords: "settings password parental create change protection nsfw",
    answer:
      "Settings → Content protection lets you create or change a parental password. It authorizes protected-setting changes; Silo says the password itself is never stored. The tour does not request or change it.",
    section: "settings",
    target: '[data-tour="settings-password"]',
  },
  {
    id: "mobile",
    guidePath: "/guide/08-mobile",
    title: "Mobile devices and messages",
    keywords: "mobile phone device iphone android messages backup browse rename",
    answer:
      "The Mobile tab shows phone backup status and its save destination above Messages, with device controls below. Scan for a device, then use Browse or Renew backup for a connected phone. Browseable snapshots retain dated copies of files exposed over USB. iPhone and iPad can also create encrypted, timestamped Apple restore archives; Android snapshots cover accessible shared files, not app data or settings.",
    section: "mobile",
    target: '[data-tour="mobile-devices"]',
  },
  {
    id: "mobile-device-actions",
    guidePath: "/guide/08-mobile",
    title: "Connect, browse, and name devices",
    keywords: "mobile devices phone tablet scan connect browse rename disconnect unmount backup renew destination",
    answer:
      "Scan devices refreshes discovery. Renew backup updates a connected phone’s browseable snapshot in Silo without changing its files. Connect or unmount manages the live USB connection; Browse opens accessible files; Rename changes Silo’s device label. Choose the snapshot destination separately. A saved phone snapshot can be browsed as a source while its destination is available.",
    section: "mobile",
    target: '[data-tour="mobile-device-actions"]',
    fallbackTarget: '[data-tour="mobile-devices"]',
  },
  {
    id: "mobile-backups",
    guidePath: "/guide/08-mobile",
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
    guidePath: "/guide/06-duplicates",
    title: "Duplicates",
    keywords: "duplicate files photos review compare remove",
    answer:
      "The Duplicates tab groups likely duplicate items for review. Compare the files and their source paths before using a cleanup action; the help guide does not select or delete anything for you.",
    section: "duplicates",
    target: '[data-tour="duplicates-overview"]',
  },
  {
    id: "memories",
    guidePath: "/guide/07-memories",
    title: "Memories",
    keywords: "memory memories video movie collection create export",
    answer:
      "Memories turns selected library moments into a reviewable story or video. Browse suggestions, adjust the selection and presentation, and verify the configured destination before exporting. Creating or exporting a memory is separate from background photo indexing.",
    section: "memories",
    target: '[data-tour="memories-overview"]',
  },
  {
    id: "memory-topic",
    guidePath: "/guide/07-memories",
    title: "Create a memory from a topic",
    keywords: "memories custom topic phrase place mood theme local search create story photos",
    answer:
      "In Memories, enter a phrase of at least three characters under Suggest a topic, such as “Rainy Sundays.” Silo searches indexed photos on this device and creates a story when matching material is available, with a locally selected soundtrack. This does not change original files or use an online AI service.",
    section: "memories",
    target: '[data-tour="memory-topic"]',
  },
  {
    id: "map-controls",
    guidePath: "/guide/05-map",
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
    guidePath: "/guide/05-map",
    title: "Globe orientation and lighting",
    keywords: "map globe compass north rotation pause resume solar time daylight night here lighting",
    answer:
      "The compass resets the globe north-up, and the rotation button pauses or resumes globe movement. These controls only affect map presentation.",
    section: "map",
    target: '[data-tour="map-globe-controls"]',
  },
  {
    id: "map-solar-controls",
    guidePath: "/guide/05-map",
    title: "Solar time and globe lighting",
    keywords: "map solar time daylight night day here night here lighting sun globe",
    answer:
      "View solar time adjusts the displayed daylight boundary. Day here and Night here align it with the current globe view. These controls affect the map presentation only, not photo metadata.",
    section: "map",
    target: '[data-tour="map-solar-controls"]',
  },
  {
    id: "file-toolbar",
    guidePath: "/guide/01-files-and-sources",
    title: "Files toolbar and view controls",
    keywords: "files toolbar explode flatten folder move virtual name keywords list grid thumbnails sort order filters select all",
    answer:
      "Grid is the default thumbnail view; select List for detailed rows. Sort & Filter opens file-type, year, people, and location filters plus sort order in either view. The rest of Files’ toolbar can flatten nested results (Explode), create a real folder, move a selected file, set a virtual name, and edit search keywords. Select files first to enable actions. Back, Forward, Parent, and Refresh navigate the current source; selection-sensitive actions remain disabled until they apply.",
    section: "files",
    target: '[data-tour="file-actions"]',
  },
  {
    id: "mobile-messages",
    guidePath: "/guide/08-mobile",
    title: "Messages and export controls",
    keywords: "messages export device phone load history update backup destination conversation contacts",
    answer:
      "In Mobile’s Messages area, choose a connected phone or saved history, then load the history. Update backup requires a connected and trusted phone. Review contact/conversation naming and the output folder and format before exporting. Exports are user-triggered; this guide never reads or exports messages.",
    section: "mobile",
    target: '[data-tour="mobile-message-workflow"]',
  },
  {
    id: "memory-controls",
    guidePath: "/guide/07-memories",
    title: "Memory story and export controls",
    keywords: "memories stories mood frame duration soundtrack music export download suggestion clear refresh",
    answer:
      "Memory stories can use music from available, indexed audio sources. Open Edit movie settings on a card and use the Soundtrack selector; Browse mood soundtracks loads matching local library choices. Selecting a library song saves it to that story and refreshes its preview. Preview the prepared movie and confirm the soundtrack is audible before saving. Original clip audio has its own mix control. If no library choices appear, check that the music source is connected and its audio inventory has finished scanning.",
    section: "memories",
    target: '[data-tour="memory-controls"]',
    fallbackTarget: '[data-tour="memories-overview"]',
  },
  {
    id: "settings-library-share",
    guidePath: "/guide/11-settings-and-privacy",
    title: "Share a library over trusted Wi-Fi",
    keywords: "settings library share Wi-Fi local network link phone browse search preview download photos videos stop sharing security unencrypted",
    answer:
      "Settings → Share a library lets you choose indexed local libraries and start a private-network share. Anyone with its link on the same network can browse, search, preview, and download included photos and videos; other Silo tools stay private. The link uses unencrypted local HTTP, so use trusted private Wi-Fi only. Stop sharing or quit Silo to end access. Starting and stopping a share are deliberate actions; the guide does neither.",
    section: "settings",
    target: '[data-tour="library-share"]',
  },
  {
    id: "settings-cache-destination",
    guidePath: "/guide/11-settings-and-privacy",
    title: "Silo cache destination",
    keywords: "settings cache index storage external drive thumbnails previews faces places move destination restart verify old cache",
    answer:
      "Settings → Silo Cache Destination shows where Silo stores indexes, face/place data, thumbnails, previews, and other generated cache files. Choose cache destination opens a folder picker; Silo verifies the copied cache before removing the old copy. You can allow a local fallback that preserves at least 10 GB of free space, or turn it off so indexing pauses until the destination reconnects. Silo automatically verifies and moves a fallback cache back, with status notices. It does not move original source files or settings. The help guide never changes the destination.",
    section: "settings",
    target: '[data-tour="settings-cache-destination"]',
  },
  {
    id: "settings-appearance",
    guidePath: "/guide/11-settings-and-privacy",
    title: "Appearance and behavior settings",
    keywords: "settings theme light dark system appearance globe rotate",
    answer:
      "Settings → Appearance & behavior controls System, Dark, or Light theme, automatic globe rotation, and optional background preloading of Map’s local day and night textures after Silo opens.",
    section: "settings",
    target: '[data-tour="settings-appearance"]',
  },
  {
    id: "settings-memory-storage",
    guidePath: "/guide/11-settings-and-privacy",
    title: "Memory movie destination",
    keywords: "settings memories save destination storage location app folder movie",
    answer:
      "Settings → Memories shows where generated movies are saved. Choose destination to select another folder, or Use app storage to return to Silo’s local app storage. This setting does not move source media.",
    section: "settings",
    target: '[data-tour="settings-memories"]',
  },
  {
    id: "settings-backup-restore",
    guidePath: "/guide/11-settings-and-privacy",
    title: "Silo configuration backup and restore",
    keywords: "settings export import config backup restore tokens passwords restart phone backups",
    answer:
      "Settings → Backup & restore exports Silo’s setup and indexed knowledge to a config file. Review an import before applying it: restoring replaces the current Silo setup and restarts the app, but does not touch photos or other source files. Phone backups are not included. Protect exported config files because they can contain sign-in tokens.",
    section: "settings",
    target: '[data-tour="settings-backup"]',
  },
  {
    id: "duplicate-review",
    guidePath: "/guide/06-duplicates",
    title: "Duplicate scan and review safety",
    keywords: "duplicates scan exact bytes retain protect keep select removed trash restore permanent delete",
    answer:
      "Scan library compares exact file contents. The first retained file in each group is protected; selectable copies can be staged in Review removed, where they remain recoverable. Select items and use Restore to return them. Delete selected permanently or Clear all permanently cannot be undone, so verify the list and selection first.",
    section: "duplicates",
    target: '[data-tour="duplicate-trash-actions"]',
    fallbackTarget: '[data-tour="duplicates-review-tab"]',
  },
  {
    id: "sources-cloud-phones",
    guidePath: "/guide/09-cloud-sources",
    title: GOOGLE_FEATURES_ENABLED ? "Google and phone sources" : "Phone sources",
    keywords: "google drive account reconnect browse photos pick sign out phone tablet source backup",
    answer:
      GOOGLE_FEATURES_ENABLED
        ? "The Files sidebar contains Google Accounts and phone/device sources in addition to folder sources. Their controls add or reconnect accounts, browse available files, or choose photos; removing access and disconnecting a device are separate actions. Check the label and availability before browsing or indexing."
        : "The Files sidebar lists saved phone and tablet copies alongside folder sources. Back up a device from Mobile, then browse its saved copy from Files. Check the label and availability before browsing or indexing.",
    section: "files",
    target: GOOGLE_FEATURES_ENABLED ? '[data-tour="google-sources"]' : '[data-tour="sources-add"]',
  },
];

interface GuideDocSection {
  chapterTitle: string;
  title: string;
  guidePath: string;
  excerpt: string;
  searchText: string;
}

// Bundled offline copy of ilovespectra/silo-user-guide at 13b1dd5856ef297fa5d081aaf0652e0ce302f036.
const ALL_GUIDE_DOC_SECTIONS: GuideDocSection[] = [
  {"chapterTitle":"Silo User Guide","title":"Start here","guidePath":"/","excerpt":"Install and take the first tour Add a folder and learn the Files workspace Understand indexing and semantic search Choose the feature you need","searchText":"Silo Your files, one local-first library. Browse folders, drives, connected phones and selected cloud files; search photos by meaning; organize with people, places and virtual collections; review duplicates; and make memory videos. This guide describes the Silo 2.0.2 source snapshot reviewed on October 9, 2026 . The installed Mac app used for screenshots currently reports bundle version 1.0.0 and minimum macOS 12.0 , so the source and packaged version labels do not agree. See Compatibility and known limits before relying on version-specific details. Silo Files screen at first launch Start here Install and take the first tour Add a folder and learn the Files workspace Understand indexing and semantic search Choose the feature you need"},
  {"chapterTitle":"Silo User Guide","title":"Guide","guidePath":"/","excerpt":"People and face scanning Digital folders and offline references Map and photo locations Duplicates and safe review Memories and story videos Phones, backups and messages Google Drive and Google Photos Shelter copies and Time…","searchText":"Guide People and face scanning Digital folders and offline references Map and photo locations Duplicates and safe review Memories and story videos Phones, backups and messages Google Drive and Google Photos Shelter copies and Time Machine Settings, storage and privacy Troubleshooting Compatibility and known limits License, demo and support access"},
  {"chapterTitle":"Silo User Guide","title":"What Silo does","guidePath":"/","excerpt":"Silo presents selected sources in a unified desktop workspace. It keeps original files where they are unless you choose an action that changes them. Search indexes, face groups, location indexes, thumbnails and other derived data…","searchText":"What Silo does Silo presents selected sources in a unified desktop workspace. It keeps original files where they are unless you choose an action that changes them. Search indexes, face groups, location indexes, thumbnails and other derived data are local Silo data; they are not substitutes for a backup of your originals. Most first-run tasks take time on a large library. Finding files, preparing CLIP search, face scanning, location extraction, duplicate hashing and thumbnail generation are separate jobs. A progress bar reaching 100% for one job does not mean every other job is complete."},
  {"chapterTitle":"Silo User Guide","title":"Official links","guidePath":"/","excerpt":"Try Silo website Silo source code on GitHub","searchText":"Official links Try Silo website Silo source code on GitHub"},
  {"chapterTitle":"Silo User Guide","title":"Privacy at a glance","guidePath":"/","excerpt":"Local folders are processed on the Mac. CLIP search and face detection use local models after the required model files are available. Google Drive and Google Photos require online Google access. Google Photos is limited to items…","searchText":"Privacy at a glance Local folders are processed on the Mac. CLIP search and face detection use local models after the required model files are available. Google Drive and Google Photos require online Google access. Google Photos is limited to items you explicitly choose through Google Photos Picker. Phone browsing needs the phone connected and trusted. Silo fetches a remote phone file when you open or export it. A Silo library share allows people with its link on the same trusted Wi-Fi network to browse, search, preview and download the included media. It uses unencrypted local HTTP. Configuration exports can contain sign-in tokens. Keep them private."},
  {"chapterTitle":"Silo User Guide","title":"Silo look and feel","guidePath":"/","excerpt":"This guide uses Silo's black and orange identity. The website follows your device's light or dark appearance by default; use the theme control in the page header to switch modes at any time. The guide remains readable in both…","searchText":"Silo look and feel This guide uses Silo's black and orange identity. The website follows your device's light or dark appearance by default; use the theme control in the page header to switch modes at any time. The guide remains readable in both themes."},
  {"chapterTitle":"Install and first launch","title":"Before you start","guidePath":"/guide/00-getting-started","excerpt":"Silo is a desktop app for organizing files you already control. Start with one folder or drive, let its inventory settle, and then add optional analysis such as face scanning. On a very large library, the first scan can use…","searchText":"Before you start Silo is a desktop app for organizing files you already control. Start with one folder or drive, let its inventory settle, and then add optional analysis such as face scanning. On a very large library, the first scan can use noticeable CPU and disk bandwidth. Use the Silo download that matches your Mac's processor (Apple silicon or Intel). Verify the published SHA-256 checksum before opening an unsigned preview build. If macOS says the app is damaged or will damage your computer, stop, re-download from the official release source and verify the checksum; do not bypass that warning. Preview builds may be unsigned and not notarized. If Gatekeeper blocks a checksum-verified official build, try opening it once, then use System Settings → Privacy & Security → Open Anyway for Silo. Only do this for a build obtained from the official Silo download page."},
  {"chapterTitle":"Install and first launch","title":"First launch, step by step","guidePath":"/guide/00-getting-started","excerpt":"Open Silo. The Files section is the library workspace. At first it may be empty. Select Open Directory or the + beside Sources and choose a folder you want to browse. Grant macOS access when asked. Add other folders or mounted…","searchText":"First launch, step by step Open Silo. The Files section is the library workspace. At first it may be empty. Select Open Directory or the + beside Sources and choose a folder you want to browse. Grant macOS access when asked. Add other folders or mounted drives one at a time so you can tell which source is being indexed. Watch Library indexing in the sidebar. File discovery, search indexing, face analysis, location reading, duplicate checking, audio inventory and thumbnails have separate progress. Open a source from its row, or select several sources and browse them together. Enter an ordinary-language description in the search field after the search index reports ready. Refine the results with the file type, year, people and location filters. Open Settings to choose the appearance, review storage destinations, and read the privacy controls before connecting cloud services or sharing a library. Silo Files workspace with personal content hidden"},
  {"chapterTitle":"Install and first launch","title":"Where to go next","guidePath":"/guide/00-getting-started","excerpt":"Learn the Files toolbar and source list . See what the indexing stages mean . Add people and face groups when you are ready; that scan is optional and separate. Set up phone or Google sources only when you need them.","searchText":"Where to go next Learn the Files toolbar and source list . See what the indexing stages mean . Add people and face groups when you are ready; that scan is optional and separate. Set up phone or Google sources only when you need them."},
  {"chapterTitle":"Install and first launch","title":"A note about first-run speed","guidePath":"/guide/00-getting-started","excerpt":"The first launch can reopen saved records, warm the local search model and prepare a fast search structure. These are not the same as discovering every file on every connected source. A saved library can appear while new-source…","searchText":"A note about first-run speed The first launch can reopen saved records, warm the local search model and prepare a fast search structure. These are not the same as discovering every file on every connected source. A saved library can appear while new-source discovery continues, and search coverage grows as eligible files are indexed. Silo does not promise a fixed completion time; library size, file formats, storage speed, source availability and Mac hardware all matter. If the Mac becomes uncomfortably warm or sluggish, pause an active People scan from that page or quit Silo to stop its background work. Search/index progress already saved locally is retained; unfinished work may resume on the next launch. Do not keep several heavyweight scans running just to make every progress bar advance at once."},
  {"chapterTitle":"Files and sources","title":"Add and browse sources","guidePath":"/guide/01-files-and-sources","excerpt":"In Files , use + beside Sources to add a folder, or use the source-specific controls for phones and Google accounts. Wait for the source to be checked and shown as available. A disconnected or unreadable source can remain in the…","searchText":"Files is the main browser. Silo treats a local folder, removable drive, phone, Google Drive and a set of Google Photos Picker selections as sources that can be included in the same view. Add and browse sources In Files , use + beside Sources to add a folder, or use the source-specific controls for phones and Google accounts. Wait for the source to be checked and shown as available. A disconnected or unreadable source can remain in the list with a status explaining why it cannot be opened. Use the checkbox to include or exclude an available source from the combined view. This changes the current browsing scope; it does not disconnect the source or delete files. Use the row chevron to open one source by itself. Select all and Select none quickly change the combined scope. Source selection is remembered between launches. Use Refresh after reconnecting a drive or device to update availability."},
  {"chapterTitle":"Files and sources","title":"Browse one folder or many","guidePath":"/guide/01-files-and-sources","excerpt":"Collapsed sources show one folder per selected source. Explode flattens nested files from the selected sources into one combined view. It can be useful for finding a file when you do not remember which subfolder contains it.…","searchText":"Browse one folder or many Collapsed sources show one folder per selected source. Explode flattens nested files from the selected sources into one combined view. It can be useful for finding a file when you do not remember which subfolder contains it. Narrow the selected sources before exploding a large collection. Back , Forward , Parent and Refresh navigate the current browsing context."},
  {"chapterTitle":"Files and sources","title":"Grid, list and filters","guidePath":"/guide/01-files-and-sources","excerpt":"Grid emphasizes thumbnails; List emphasizes file details. Adjust Thumbnail size to fit more or fewer cards on screen. Sort & Filter includes media/file type, year, people and location filters, plus sort order. Available filters…","searchText":"Grid, list and filters Grid emphasizes thumbnails; List emphasizes file details. Adjust Thumbnail size to fit more or fewer cards on screen. Sort & Filter includes media/file type, year, people and location filters, plus sort order. Available filters depend on indexed metadata. The Show control can limit the visible file category. Select filters to focus the current results; they do not move files. File cards can show preview, detected-person and favorite indicators. A missing thumbnail does not necessarily mean the original is missing; indexing or preview generation may still be in progress."},
  {"chapterTitle":"Files and sources","title":"Open and act on a file","guidePath":"/guide/01-files-and-sources","excerpt":"Select a file to enable applicable toolbar actions. Depending on source and file type, Silo can open a larger viewer, zoom images, play audio/video, create a folder, move a file, set a virtual name or edit search keywords. Move…","searchText":"Open and act on a file Select a file to enable applicable toolbar actions. Depending on source and file type, Silo can open a larger viewer, zoom images, play audio/video, create a folder, move a file, set a virtual name or edit search keywords. Move changes the file's actual location. Check the source and destination before confirming. Set virtual name changes the label Silo uses in its interface and search; it does not rename the underlying file. New folder creates a real folder in the current writable source. Favorite changes Silo's organizational marker, not the file. Remote sources may support fewer operations than local folders. Google Drive supports its own rename, trash, folder and upload operations; Google Photos Picker content is read-only."},
  {"chapterTitle":"Files and sources","title":"Tips","guidePath":"/guide/01-files-and-sources","excerpt":"Add a small representative folder first to learn the layout. Use source names and availability labels to distinguish local, phone and cloud items. Selecting a source does not guarantee that its search, people or location indexes…","searchText":"Tips Add a small representative folder first to learn the layout. Use source names and availability labels to distinguish local, phone and cloud items. Selecting a source does not guarantee that its search, people or location indexes are finished. If a source shows disconnected/unreadable, reconnect it and refresh. For Time Machine access, see Full Disk Access ."},
  {"chapterTitle":"Search and indexing","title":"What CLIP does","guidePath":"/guide/02-search-and-indexing","excerpt":"Silo's semantic index uses a local CLIP image-and-text model. For an eligible image, Silo preprocesses the picture and stores a numeric image embedding. When you type a description, the text side of the model turns the words into…","searchText":"Silo combines ordinary file browsing with semantic search. Search quality depends on a local index that is built over time; adding a source and seeing it in Files does not mean every item is already searchable. What CLIP does Silo's semantic index uses a local CLIP image-and-text model. For an eligible image, Silo preprocesses the picture and stores a numeric image embedding. When you type a description, the text side of the model turns the words into an embedding. Silo compares the text and image vectors and ranks likely matches. The confidence control changes how selective the results are. The source identifies the model family as Xenova/clip-vit-base-patch32 ; the app uses quantized ONNX model files and a local inference runtime. Inference is configured to run locally and remote model downloads are disabled by the worker. Packaged builds are configured to include a CLIP model cache. This is image/visual similarity search, not a general-purpose web search or guaranteed OCR of every word inside a document. After model and index files are available locally, query inference can run without sending local image content to a cloud AI service. Google Drive and Google Photos still require network access to sign in and fetch remote items."},
  {"chapterTitle":"Search and indexing","title":"What the progress labels mean","guidePath":"/guide/02-search-and-indexing","excerpt":"Indexing is a set of independent jobs: Startup / opening saved indexes: reading local Silo records. A percentage here is not a percentage of every media analysis task. Discovery: walking connected source trees and finding files.…","searchText":"What the progress labels mean Indexing is a set of independent jobs: Startup / opening saved indexes: reading local Silo records. A percentage here is not a percentage of every media analysis task. Discovery: walking connected source trees and finding files. Search: creating or updating CLIP records for eligible images and documents. Faces: optional face detection and grouping; see People . Locations: reading embedded photo GPS data; see Map . Duplicates: hashing/comparing exact file contents. Audio: inventorying audio files. Quality: scoring photos for memory selection. Thumbnails/previews: preparing visual previews for the browser. A source can be visible while one or more of these jobs is still running. Search only sees records that have been added to the searchable index. Results may arrive progressively as indexing fills in, but no result count or fixed latency is guaranteed for every library or build. Cold-start preparation and index recovery can take time."},
  {"chapterTitle":"Search and indexing","title":"Step-by-step search","guidePath":"/guide/02-search-and-indexing","excerpt":"Open Files and make sure the relevant sources are available and selected. Wait for the app's search readiness indicator to say the local search index is prepared. If it is still opening records or warming the model, results may…","searchText":"Step-by-step search Open Files and make sure the relevant sources are available and selected. Wait for the app's search readiness indicator to say the local search index is prepared. If it is still opening records or warming the model, results may be delayed or incomplete. Describe the visual idea in plain language, such as “red sailboat at sunset.” Adjust the confidence threshold. A more selective threshold returns fewer, closer matches; a looser threshold can return more approximate matches. Refine by type, year, people or location, and open a card to inspect the original. If a newly added file is missing, allow its discovery and search-index stage to reach that file; confirm the source can be read."},
  {"chapterTitle":"Search and indexing","title":"What gets indexed","guidePath":"/guide/02-search-and-indexing","excerpt":"Silo keeps the original path/source association and a local searchable representation. Thumbnails, preview files, face data, map data, duplicate records and search vectors are separate derived data. The exact set of supported…","searchText":"What gets indexed Silo keeps the original path/source association and a local searchable representation. Thumbnails, preview files, face data, map data, duplicate records and search vectors are separate derived data. The exact set of supported formats depends on which local decoders can read a file and whether that build has the required components. Corrupt, encrypted, unusually large or unsupported files may be skipped or reported as errors."},
  {"chapterTitle":"Search and indexing","title":"Performance and control","guidePath":"/guide/02-search-and-indexing","excerpt":"Building a large library index is compute- and disk-intensive. Face scanning is a separate optional task; start it after basic file/search work is stable and pause it from People if it competes with active work. Avoid adding many…","searchText":"Performance and control Building a large library index is compute- and disk-intensive. Face scanning is a separate optional task; start it after basic file/search work is stable and pause it from People if it competes with active work. Avoid adding many huge or slow remote sources at once. Use an external Silo cache destination when local cache space is constrained, and keep the drive connected while work is pending. If Silo makes the Mac too warm or sluggish, quit it; saved index progress remains local and unfinished stages can continue later. The app's exact CPU scheduling and search prioritization can vary by build. This guide does not promise a CPU ceiling or instant results while indexing is active."},
  {"chapterTitle":"Search and indexing","title":"Search troubleshooting","guidePath":"/guide/02-search-and-indexing","excerpt":"No results: confirm the index is ready, the source is selected and accessible, and the query describes visual content rather than assuming every embedded text string is OCR-searchable. No new files: wait for discovery and search…","searchText":"Search troubleshooting No results: confirm the index is ready, the source is selected and accessible, and the query describes visual content rather than assuming every embedded text string is OCR-searchable. No new files: wait for discovery and search indexing; a visible source count is not the searchable count. Slow first query: look for the model warm-up or search-index preparation status, then retry once ready. Wrong result balance: move the confidence slider and combine results with metadata filters. Search unavailable: see cache and recovery checks ."},
  {"chapterTitle":"People and face scanning","title":"Start a face scan","guidePath":"/guide/03-people","excerpt":"Open People . Review the face-indexing status and any existing groups. Choose Start face indexing when you want Silo to analyze available indexed photos. Let the face model load and the scan process photos. New clusters may…","searchText":"People organizes faces detected in indexed photos. Face scanning is a separate, optional local analysis job; it is not required to browse files or use basic semantic search. Start a face scan Open People . Review the face-indexing status and any existing groups. Choose Start face indexing when you want Silo to analyze available indexed photos. Let the face model load and the scan process photos. New clusters may appear as the scan advances. Pause the scan if you want to reduce background work or review the photos first. Resume later from the same page. Face indexing waits for searchable/indexed photos as needed. A zero or incomplete People view can mean there are no indexed faces yet, the source is unavailable, or the face scan has not run; it does not prove the photos contain no faces."},
  {"chapterTitle":"People and face scanning","title":"Review and name a group","guidePath":"/guide/03-people","excerpt":"Open a cluster to inspect its photos before giving it a name. Use New Person to create a named profile. Rename a person when you need to correct the label. Confirm identities only after reviewing the group. Face matching is a…","searchText":"Review and name a group Open a cluster to inspect its photos before giving it a name. Use New Person to create a named profile. Rename a person when you need to correct the label. Confirm identities only after reviewing the group. Face matching is a suggestion and can confuse similar-looking people, partial faces, old photos or occlusions. Right-click or Shift-click a photo to inspect detected faces and correct an assignment. You can add, remove, or reassign a detected face where the controls are available. Merge profiles only after checking both groups. A merge moves the source profile's assignments into the chosen person; the source profile is removed. Silo documents undo with ⌘Z after confirmation, but inspect the resulting group before continuing. Select a cover photo if the profile's default image is not useful."},
  {"chapterTitle":"People and face scanning","title":"Confirmed faces and banned people","guidePath":"/guide/03-people","excerpt":"The Confirmed faces view separates reviewed profiles and includes the Banned people area. Ban hides matching photos from the library view; it does not alter or erase the original files. Settings control whether banned or…","searchText":"Confirmed faces and banned people The Confirmed faces view separates reviewed profiles and includes the Banned people area. Ban hides matching photos from the library view; it does not alter or erase the original files. Settings control whether banned or explicit-content photos can appear elsewhere. Use Show faces in the banned area when you need to review the face-level records there."},
  {"chapterTitle":"People and face scanning","title":"Privacy and limits","guidePath":"/guide/03-people","excerpt":"Face detection, descriptors and clusters are stored in Silo's local cache. The feature does not identify a real-world name on its own; you supply names and confirm matches. Results depend on image quality, face angle, occlusion…","searchText":"Privacy and limits Face detection, descriptors and clusters are stored in Silo's local cache. The feature does not identify a real-world name on its own; you supply names and confirm matches. Results depend on image quality, face angle, occlusion and model behavior. People scanning can be one of the heavier background jobs, so run it separately from other intensive tasks when responsiveness matters. If a scan reports a model or indexing error, see People scan troubleshooting ."},
  {"chapterTitle":"Digital folders and offline references","title":"Create a collection","guidePath":"/guide/04-digital-folders","excerpt":"In the Files sidebar, choose + beside Digital Folders . Give the collection a useful name. Select the files you want from the current Files view and use the collection's add/reference action. Open the collection from the sidebar…","searchText":"A Digital Folder is a Silo collection made from references to originals. It is not a new folder on disk and it does not duplicate the photos. Create a collection In the Files sidebar, choose + beside Digital Folders . Give the collection a useful name. Select the files you want from the current Files view and use the collection's add/reference action. Open the collection from the sidebar to review its contents. Remove a reference when the collection no longer needs it. The original stays in its source. Rename, reorder or remove a Digital Folder as an organizational change. These operations do not rename, move or delete the original media. Selecting a smaller source set before adding files makes it easier to build a collection from the intended device or archive."},
  {"chapterTitle":"Digital folders and offline references","title":"How an offline reference behaves","guidePath":"/guide/04-digital-folders","excerpt":"Silo stores a local reference to the source item and can preserve its indexed metadata. If the original lives on an external drive or a phone that is disconnected, the reference may remain in the collection but Silo cannot…","searchText":"How an offline reference behaves Silo stores a local reference to the source item and can preserve its indexed metadata. If the original lives on an external drive or a phone that is disconnected, the reference may remain in the collection but Silo cannot promise that the original can be opened or exported until the source is available again. A cached thumbnail or search record is not the original file and should not be treated as a backup. Cloud references have a similar dependency: browsing or previewing a remote item may require a valid session and network access. For offline access to the original, keep a verified local copy or a separate backup."},
  {"chapterTitle":"Digital folders and offline references","title":"Digital folder vs physical folder","guidePath":"/guide/04-digital-folders","excerpt":"Action Changes original file? Creates a copy? --- ---: ---: Add/remove a Digital Folder reference No No Set a virtual name No No Create a folder in a writable source Creates a real directory No Move a file Yes, changes its…","searchText":"Digital folder vs physical folder Action Changes original file? Creates a copy? --- ---: ---: Add/remove a Digital Folder reference No No Set a virtual name No No Create a folder in a writable source Creates a real directory No Move a file Yes, changes its location No Export/download/phone save No source change Yes Always use a physical copy or a verified backup when you need independent offline storage."},
  {"chapterTitle":"Map and photo locations","title":"Prepare and browse the map","guidePath":"/guide/05-map","excerpt":"Make sure the relevant photos are accessible and allow the Locations indexing stage to read their metadata. Open Map and wait for its location data and globe assets to load. Refresh/rescan when you have added photos or changed…","searchText":"Map groups photos with usable embedded GPS metadata into location clusters and shows them on a globe. It uses coordinates read from files; it does not infer a location from visual content alone. Prepare and browse the map Make sure the relevant photos are accessible and allow the Locations indexing stage to read their metadata. Open Map and wait for its location data and globe assets to load. Refresh/rescan when you have added photos or changed embedded location metadata. Open a region or location bubble to inspect the associated photos. Use the region tools to select items. Rectangle/circle selection supports additive or subtractive gestures described by the on-screen help. Search or sort within a region and open a photo to confirm the selection."},
  {"chapterTitle":"Map and photo locations","title":"Change a photo's location","guidePath":"/guide/05-map","excerpt":"Select the intended photos. Choose Relocate . Search for a place or choose Use embedded location in the location picker. Check both the selected items and the proposed location. Apply only after confirming the selection is…","searchText":"Change a photo's location Select the intended photos. Choose Relocate . Search for a place or choose Use embedded location in the location picker. Check both the selected items and the proposed location. Apply only after confirming the selection is correct. Relocation changes location metadata or Silo's location assignment according to the selected action; it does not move the file to another folder. Review before applying because coordinates can be sensitive personal information."},
  {"chapterTitle":"Map and photo locations","title":"Globe controls","guidePath":"/guide/05-map","excerpt":"The compass resets the view north-up. Pause/resume controls affect globe rotation only. Solar-time controls change the displayed day/night boundary. They do not edit photo metadata. Appearance settings can pause automatic…","searchText":"Globe controls The compass resets the view north-up. Pause/resume controls affect globe rotation only. Solar-time controls change the displayed day/night boundary. They do not edit photo metadata. Appearance settings can pause automatic rotation or preload local day/night map textures."},
  {"chapterTitle":"Map and photo locations","title":"Limits","guidePath":"/guide/05-map","excerpt":"Photos without GPS metadata do not appear in location groups until metadata is added. A location may be approximate or absent if metadata was stripped by an export or messaging app. Geocoding and map decoration can depend on…","searchText":"Limits Photos without GPS metadata do not appear in location groups until metadata is added. A location may be approximate or absent if metadata was stripped by an export or messaging app. Geocoding and map decoration can depend on local data and build configuration; the map is not a live navigation or directions service."},
  {"chapterTitle":"Duplicates","title":"Scan and review","guidePath":"/guide/06-duplicates","excerpt":"Open Duplicates and choose the scan action. Let the scan finish for the sources you want compared. Unavailable sources cannot contribute files. Open a group and compare the file details and previews. Keep the protected/original…","searchText":"The Duplicates page is designed for careful cleanup. Silo compares exact file contents; it is not a “similar-looking photo” finder. Scan and review Open Duplicates and choose the scan action. Let the scan finish for the sources you want compared. Unavailable sources cannot contribute files. Open a group and compare the file details and previews. Keep the protected/original item in each group. Select only copies you have checked. Stage selected copies in the Review removed area. This is the recoverable review step, not final deletion. Open the review area and verify the list. Restore any item you want to keep. Permanently delete only after checking the exact selection and confirming you have another copy if needed."},
  {"chapterTitle":"Duplicates","title":"Recovery and safety","guidePath":"/guide/06-duplicates","excerpt":"Items staged for removal remain recoverable until permanent deletion. Use Restore to return selected items. Delete selected permanently and Clear all permanently cannot be undone. Never rely on a thumbnail or filename alone…","searchText":"Recovery and safety Items staged for removal remain recoverable until permanent deletion. Use Restore to return selected items. Delete selected permanently and Clear all permanently cannot be undone. Never rely on a thumbnail or filename alone; compare source, path, size and preview, and verify your backup before permanently deleting anything."},
  {"chapterTitle":"Duplicates","title":"What counts as a duplicate","guidePath":"/guide/06-duplicates","excerpt":"The scan looks for files with matching content, not just matching names. It will not mark two resized, edited, recompressed or visually similar images as exact duplicates. Conversely, byte-identical files can be duplicates even…","searchText":"What counts as a duplicate The scan looks for files with matching content, not just matching names. It will not mark two resized, edited, recompressed or visually similar images as exact duplicates. Conversely, byte-identical files can be duplicates even if they live in different folders. If no groups appear, check that the Duplicate index is complete, the sources are mounted and readable, and the scan includes the intended source scope."},
  {"chapterTitle":"Memories and story videos","title":"Find or suggest a story","guidePath":"/guide/07-memories","excerpt":"Choose Refresh to reload the cards already available. Choose Generate memories or Find new memories to search the indexed archive for additional story candidates. To steer the search, enter a topic or phrase and submit it. For…","searchText":"Memories turns indexed local photos and clips into reviewable story suggestions and exported videos. Creating suggestions is user-triggered; opening the page does not automatically export a movie. Find or suggest a story Choose Refresh to reload the cards already available. Choose Generate memories or Find new memories to search the indexed archive for additional story candidates. To steer the search, enter a topic or phrase and submit it. For example, use an event, place, activity or person that is already represented in your indexed library. Suggestions depend on what has been indexed and on available dates, people, locations and quality metadata. No suggestion is a guarantee that every relevant file was found."},
  {"chapterTitle":"Memories and story videos","title":"Review and export","guidePath":"/guide/07-memories","excerpt":"Open a suggestion and review its photos and clip choices. Adjust the photo count, duration, mood/pacing or soundtrack controls that are available in the editor. Preview the result and check the selected music and original audio…","searchText":"Review and export Open a suggestion and review its photos and clip choices. Adjust the photo count, duration, mood/pacing or soundtrack controls that are available in the editor. Preview the result and check the selected music and original audio level. Choose Choose location & export and confirm the destination. Watch the export progress. Cancel if needed; the original media remains unchanged. Reopen or play the generated movie from the Memories screen or the chosen destination. The soundtrack is selected locally from available music. A missing/offline track may cause the story's own audio or another fallback to be used, depending on the story and build. Removing a suggestion card or clearing suggestions removes the card from Silo's list; it does not delete the source photos. The generated movie is a separate output file. Settings lets you choose where movies and story-support files are saved, or return to Silo's app storage."},
  {"chapterTitle":"Memories and story videos","title":"Limits","guidePath":"/guide/07-memories","excerpt":"Memory discovery depends on completed indexes and the content present in the source library. It runs only when requested, but generating a story and rendering a video can use substantial CPU and disk space. Check the destination…","searchText":"Limits Memory discovery depends on completed indexes and the content present in the source library. It runs only when requested, but generating a story and rendering a video can use substantial CPU and disk space. Check the destination has enough free storage. Silo does not upload local media to an online AI service for this workflow."},
  {"chapterTitle":"Phones and messages","title":"Connect an iPhone or iPad","guidePath":"/guide/08-mobile","excerpt":"Install the required libimobiledevice tools if the app reports they are missing. Connect the device by USB, unlock it and choose Trust This Computer on the phone. In Silo, choose Connect and complete pairing. Browse available…","searchText":"The Mobile section manages connected iPhone/iPad and Android sources, saved-device copies and message exports. Phone support is a USB workflow, not a full device backup of every protected operating-system file. Connect an iPhone or iPad Install the required libimobiledevice tools if the app reports they are missing. Connect the device by USB, unlock it and choose Trust This Computer on the phone. In Silo, choose Connect and complete pairing. Browse available media files. Silo does not mount the entire device and does not copy files until you open, save or export them. iOS limit: non-jailbroken iOS exposes a media area over this connection (such as DCIM/Photos and other shared media folders); it does not expose the entire protected device filesystem. This is an Apple platform restriction."},
  {"chapterTitle":"Phones and messages","title":"Connect Android","guidePath":"/guide/08-mobile","excerpt":"Install Android platform tools ( adb ). Enable Developer options and USB debugging on the phone. Connect by USB and allow the debugging prompt. Select file-transfer mode if your device requires it. Choose Connect in Silo and…","searchText":"Connect Android Install Android platform tools ( adb ). Enable Developer options and USB debugging on the phone. Connect by USB and allow the debugging prompt. Select file-transfer mode if your device requires it. Choose Connect in Silo and browse the accessible shared storage, typically /sdcard . If the device is marked unauthorized, unlock it and approve the computer prompt. A charge-only cable, hub or disabled USB debugging can prevent detection."},
  {"chapterTitle":"Phones and messages","title":"Browseable snapshots and restore archives","guidePath":"/guide/08-mobile","excerpt":"Mobile can create dated, browseable copies of device data and manage iOS restore archives where the connected-device workflow supports them. Before starting a backup or restore, check the phone identity, backup age, selected…","searchText":"Browseable snapshots and restore archives Mobile can create dated, browseable copies of device data and manage iOS restore archives where the connected-device workflow supports them. Before starting a backup or restore, check the phone identity, backup age, selected scope and destination. A saved browseable copy is distinct from a live phone connection; an unplugged phone can still have a local saved snapshot. A backup's existence does not prove it is current or restorable. Use the app's verification/status controls, keep independent copies and avoid overwriting a newer backup until you understand which device and date it represents."},
  {"chapterTitle":"Phones and messages","title":"Messages","guidePath":"/guide/08-mobile","excerpt":"Messages export is user initiated: Select a connected phone or an already-saved message history. Load the history. Review contact/conversation names and the selected destination and output format. Export only the conversations…","searchText":"Messages Messages export is user initiated: Select a connected phone or an already-saved message history. Load the history. Review contact/conversation names and the selected destination and output format. Export only the conversations you intend to save. Updating a phone's message backup requires a connected, trusted phone. Message exports may contain private conversations and contact details; store and share them carefully."},
  {"chapterTitle":"Phones and messages","title":"Limits and troubleshooting","guidePath":"/guide/08-mobile","excerpt":"Silo does not bypass phone platform permissions. Android access depends on USB debugging authorization; iOS access is limited to Apple's exposed media area. If a device is missing, see phone troubleshooting .","searchText":"Limits and troubleshooting Silo does not bypass phone platform permissions. Android access depends on USB debugging authorization; iOS access is limited to Apple's exposed media area. If a device is missing, see phone troubleshooting ."},
  {"chapterTitle":"Google Drive and Google Photos","title":"Google Drive","guidePath":"/guide/09-cloud-sources","excerpt":"Where the build has Google OAuth configured, connect the account from Google Accounts . Silo can browse folders, preview/stream items, and—in Drive—create folders, rename, move items to Trash and upload files. Google Docs, Sheets…","searchText":"Cloud sources appear alongside local folders, but their originals remain remote. Browsing a cloud item may require a network connection and a valid Google session. Google Drive Where the build has Google OAuth configured, connect the account from Google Accounts . Silo can browse folders, preview/stream items, and—in Drive—create folders, rename, move items to Trash and upload files. Google Docs, Sheets and Slides are converted to a preview format where supported. Multiple accounts can stay connected. All Drives combines their contents; account-specific entries help keep work and personal sources distinct. If one account expires or is revoked, reconnect that account; other accounts can remain available."},
  {"chapterTitle":"Google Drive and Google Photos","title":"Google Photos","guidePath":"/guide/09-cloud-sources","excerpt":"Silo uses Google's Photos Picker. It does not browse the entire Google Photos library. You explicitly choose items in the Google Photos picker, then Silo loads the selected set as a browsable source. Picker selections can be used…","searchText":"Google Photos Silo uses Google's Photos Picker. It does not browse the entire Google Photos library. You explicitly choose items in the Google Photos picker, then Silo loads the selected set as a browsable source. Picker selections can be used with supported search, People, Digital Folders and export workflows while the session/source remains available. Photos Picker items are read-only in Silo."},
  {"chapterTitle":"Google Drive and Google Photos","title":"Connection setup and scopes","guidePath":"/guide/09-cloud-sources","excerpt":"Some builds may include working OAuth credentials; others may require the application owner to configure a Google Cloud project, enable Drive API and Photos Picker API, set the OAuth desktop client and allowed scopes, and add…","searchText":"Connection setup and scopes Some builds may include working OAuth credentials; others may require the application owner to configure a Google Cloud project, enable Drive API and Photos Picker API, set the OAuth desktop client and allowed scopes, and add test users while the OAuth app is in testing. If Silo reports that GOOGLE CLIENT ID or credentials are missing, that is a build/configuration requirement—not a password to paste into a random web page. Ask the Silo maintainer for the supported setup path before editing app files. OAuth uses a browser sign-in flow with PKCE. Refresh tokens are stored in Silo's user data. Disconnecting/signing out revokes the Google token; removing a source from the visible scope is different from disconnecting the account."},
  {"chapterTitle":"Google Drive and Google Photos","title":"Limits","guidePath":"/guide/09-cloud-sources","excerpt":"Google Drive requires online access for remote content and remote write actions. Photos Picker contains only the items the user selects and is read-only. A cached preview or semantic record is not a local backup of the full…","searchText":"Limits Google Drive requires online access for remote content and remote write actions. Photos Picker contains only the items the user selects and is read-only. A cached preview or semantic record is not a local backup of the full remote original. Google may require OAuth verification for a publicly distributed application using restricted Drive access. Test-mode accounts can have time-limited access."},
  {"chapterTitle":"Backups and Time Machine","title":"Shelter copy: verified file clone","guidePath":"/guide/10-backups","excerpt":"The shelter-copy flow makes a copy of selected source data onto a destination volume and verifies it. Check the selected sources, destination, available space and verification summary before starting. Do not disconnect either…","searchText":"Silo has two separate ideas: its generated cache/index and backup copies of original files . Indexes and thumbnails can help Silo work; they are not a replacement for a verified backup of your photos and documents. Shelter copy: verified file clone The shelter-copy flow makes a copy of selected source data onto a destination volume and verifies it. Check the selected sources, destination, available space and verification summary before starting. Do not disconnect either volume while copying or verifying. A primary copy and a replica on another volume have separate status. A verified copy shows that its contents matched at the verification point; it does not mean that it will stay current after the source changes. Review backup age/freshness and rerun when needed. When the preferred cache/index destination is unavailable, Silo's settled behavior is to offer local fallback while preserving at least 10 GB free space. If fallback is disabled, indexing pauses until the destination returns. Silo verifies and moves the fallback cache back automatically when the destination reconnects, with notices. This concerns generated cache data, not original file backup."},
  {"chapterTitle":"Backups and Time Machine","title":"Time Machine","guidePath":"/guide/10-backups","excerpt":"Silo can browse Time Machine snapshots as sources. macOS protects some snapshot locations. If Silo reports Operation not permitted or shows an apparently empty snapshot, grant Full Disk Access to the actual Silo app in System…","searchText":"Time Machine Silo can browse Time Machine snapshots as sources. macOS protects some snapshot locations. If Silo reports Operation not permitted or shows an apparently empty snapshot, grant Full Disk Access to the actual Silo app in System Settings → Privacy & Security → Full Disk Access , then quit and reopen Silo so macOS applies the permission. Development builds may appear as Electron rather than Silo. Time Machine is managed by macOS; using Silo to browse a snapshot does not by itself create a Silo shelter clone."},
  {"chapterTitle":"Backups and Time Machine","title":"Phone backups","guidePath":"/guide/10-backups","excerpt":"Mobile backups create dated, browseable local copies. Compare device identifiers and dates before restoring or updating. Keep independent copies if the phone is important; a phone backup may not include every protected iOS file.","searchText":"Phone backups Mobile backups create dated, browseable local copies. Compare device identifiers and dates before restoring or updating. Keep independent copies if the phone is important; a phone backup may not include every protected iOS file."},
  {"chapterTitle":"Backups and Time Machine","title":"Library Statistics","guidePath":"/guide/10-backups","excerpt":"Open Stats in the main sidebar to review inventory, source availability, per-stage indexing, and shelter-copy status. Refresh measurements before comparing totals. Use the copy/verification controls only after checking…","searchText":"Library Statistics Open Stats in the main sidebar to review inventory, source availability, per-stage indexing, and shelter-copy status. Refresh measurements before comparing totals. Use the copy/verification controls only after checking the source selection and destination."},
  {"chapterTitle":"Backups and Time Machine","title":"Good backup practice","guidePath":"/guide/10-backups","excerpt":"Keep at least one verified copy on a different physical device or volume. Keep important backup destinations disconnected when not in use to reduce accidental damage. Check age and freshness, not just the “verified” label from a…","searchText":"Good backup practice Keep at least one verified copy on a different physical device or volume. Keep important backup destinations disconnected when not in use to reduce accidental damage. Check age and freshness, not just the “verified” label from a prior run. Never permanently delete duplicate-review items until you confirm a separate backup exists. Keep the Silo cache out of the only copy of your originals; it can be rebuilt, originals may not be."},
  {"chapterTitle":"Settings, storage and privacy","title":"Appearance and behavior","guidePath":"/guide/11-settings-and-privacy","excerpt":"Settings → Appearance & behavior offers System , Dark and Light themes. System follows macOS appearance. Map options control automatic globe rotation and optional preload of local day/night textures.","searchText":"Appearance and behavior Settings → Appearance & behavior offers System , Dark and Light themes. System follows macOS appearance. Map options control automatic globe rotation and optional preload of local day/night textures."},
  {"chapterTitle":"Settings, storage and privacy","title":"Silo cache destination","guidePath":"/guide/11-settings-and-privacy","excerpt":"The cache contains generated data such as search/face/location indexes, thumbnails and previews. Choose cache destination lets you select an external folder. Silo verifies the copied cache before removing the prior copy, then…","searchText":"Silo cache destination The cache contains generated data such as search/face/location indexes, thumbnails and previews. Choose cache destination lets you select an external folder. Silo verifies the copied cache before removing the prior copy, then restarts when needed. Keep the destination mounted while using Silo. The fallback option preserves a 10 GB free-space reserve; turn it off if you prefer indexing to pause when the external cache drive is absent. Changing the cache destination does not move your original folders or change Silo settings. Do not manually delete an index folder while Silo is running."},
  {"chapterTitle":"Settings, storage and privacy","title":"Memories storage","guidePath":"/guide/11-settings-and-privacy","excerpt":"The Memories setting selects where generated movies and their support files are written. It does not move source media. Check available disk space before exporting long videos.","searchText":"Memories storage The Memories setting selects where generated movies and their support files are written. It does not move source media. Check available disk space before exporting long videos."},
  {"chapterTitle":"Settings, storage and privacy","title":"Configuration backup and restore","guidePath":"/guide/11-settings-and-privacy","excerpt":"Backup & restore can export Silo configuration and indexed knowledge. The export can contain sign-in tokens, so treat it like a secret and store it privately. Review an import before applying: restoring replaces the current Silo…","searchText":"Configuration backup and restore Backup & restore can export Silo configuration and indexed knowledge. The export can contain sign-in tokens, so treat it like a secret and store it privately. Review an import before applying: restoring replaces the current Silo setup and restarts the app. It does not modify source media; phone backups are not included."},
  {"chapterTitle":"Settings, storage and privacy","title":"Content protection","guidePath":"/guide/11-settings-and-privacy","excerpt":"Content protection controls visibility of explicit images and banned people, Safe Search behavior and authorization for protected changes. Explicit images are hidden and excluded from search by default. Banned people are hidden…","searchText":"Content protection Content protection controls visibility of explicit images and banned people, Safe Search behavior and authorization for protected changes. Explicit images are hidden and excluded from search by default. Banned people are hidden according to the relevant settings. If a parental password is enabled, Silo asks for it before protected changes; the password itself is not stored, only a verifier. Keep the password somewhere safe."},
  {"chapterTitle":"Settings, storage and privacy","title":"Share a library on trusted Wi-Fi","guidePath":"/guide/11-settings-and-privacy","excerpt":"Settings → Share a library publishes selected indexed local libraries to a link on your private network. People with that link on the network can browse, search, preview and download included photos and videos. It does not share…","searchText":"Share a library on trusted Wi-Fi Settings → Share a library publishes selected indexed local libraries to a link on your private network. People with that link on the network can browse, search, preview and download included photos and videos. It does not share all Silo tools. The link uses unencrypted local HTTP . Only enable it on a trusted private Wi-Fi network; do not forward the link, expose the port to the internet, or use it on public Wi-Fi. Stop sharing or quit Silo to end access."},
  {"chapterTitle":"Settings, storage and privacy","title":"Feedback and screenshots","guidePath":"/guide/11-settings-and-privacy","excerpt":"Silo's report-a-problem workflow may attach a screenshot of the Silo window if you choose that option. Inspect screenshots for faces, filenames, paths, account names and other personal details before sending. Sharing a support…","searchText":"Feedback and screenshots Silo's report-a-problem workflow may attach a screenshot of the Silo window if you choose that option. Inspect screenshots for faces, filenames, paths, account names and other personal details before sending. Sharing a support report is a separate, deliberate action."},
  {"chapterTitle":"Troubleshooting","title":"Search index does not become ready","guidePath":"/guide/12-troubleshooting","excerpt":"In Files, read the exact stage/status text. Opening saved records, warming CLIP and discovering new files are different stages. Check Settings → Silo Cache Destination and confirm the volume is mounted and has free space. Wait…","searchText":"Search index does not become ready In Files, read the exact stage/status text. Opening saved records, warming CLIP and discovering new files are different stages. Check Settings → Silo Cache Destination and confirm the volume is mounted and has free space. Wait for a large index to make progress; avoid starting face scanning or memory export at the same time. If indexing service status says it is reconnecting, leave Silo open briefly for its automatic retry or restart Silo once. Use the stage retry control only for a stage shown as retryable. Do not delete cache folders by hand. If it remains unavailable, capture the visible error and include the Silo version and Mac chip in a private support report. A 0% saved-index opening indicator is not the same as “no files found.” A library item count is not the number of files with finished CLIP embeddings."},
  {"chapterTitle":"Troubleshooting","title":"Search returns nothing or misses recent files","guidePath":"/guide/12-troubleshooting","excerpt":"Make sure the source is selected and still available. Check whether Search indexing has reached the relevant files. Try a visual description, loosen confidence, and remove restrictive filters. Remember that visual CLIP search is…","searchText":"Search returns nothing or misses recent files Make sure the source is selected and still available. Check whether Search indexing has reached the relevant files. Try a visual description, loosen confidence, and remove restrictive filters. Remember that visual CLIP search is not guaranteed OCR of document text. For Google Photos, confirm you selected the item in the Picker and the selection is still available."},
  {"chapterTitle":"Troubleshooting","title":"Thumbnails or previews are blank","guidePath":"/guide/12-troubleshooting","excerpt":"Confirm the original source is connected and readable. Wait for the thumbnail/preview stage; Silo can index a file before its preview is ready. Try opening the original from its source. Unsupported, corrupt, encrypted or very…","searchText":"Thumbnails or previews are blank Confirm the original source is connected and readable. Wait for the thumbnail/preview stage; Silo can index a file before its preview is ready. Try opening the original from its source. Unsupported, corrupt, encrypted or very large files may not decode. If a removable cache drive is missing, reconnect it and let Silo verify recovery before manually changing folders."},
  {"chapterTitle":"Troubleshooting","title":"Mac is warm or Silo is sluggish","guidePath":"/guide/12-troubleshooting","excerpt":"Initial discovery and media indexing can use CPU and disk. Pause a running face scan from People. Avoid simultaneous large memory exports and backup verification. If the Mac remains uncomfortably warm, quit Silo; the local index…","searchText":"Mac is warm or Silo is sluggish Initial discovery and media indexing can use CPU and disk. Pause a running face scan from People. Avoid simultaneous large memory exports and backup verification. If the Mac remains uncomfortably warm, quit Silo; the local index can continue later. Report the build and indexing stage so performance can be diagnosed."},
  {"chapterTitle":"Troubleshooting","title":"People scan is empty or stalled","guidePath":"/guide/12-troubleshooting","excerpt":"Confirm photos are indexed and readable first. Open People and explicitly start the optional face scan. Check the face-index progress and error message; retry only if offered. Pause and resume the scan from People if needed.…","searchText":"People scan is empty or stalled Confirm photos are indexed and readable first. Open People and explicitly start the optional face scan. Check the face-index progress and error message; retry only if offered. Pause and resume the scan from People if needed. Review clusters manually; do not assume a match is certain."},
  {"chapterTitle":"Troubleshooting","title":"Map has no photos","guidePath":"/guide/12-troubleshooting","excerpt":"The photos may not have embedded GPS coordinates, or Location indexing may still be running. Refresh/rescan after new files are indexed. Changing a place requires a deliberate selection and apply step.","searchText":"Map has no photos The photos may not have embedded GPS coordinates, or Location indexing may still be running. Refresh/rescan after new files are indexed. Changing a place requires a deliberate selection and apply step."},
  {"chapterTitle":"Troubleshooting","title":"Duplicate scan finds no groups","guidePath":"/guide/12-troubleshooting","excerpt":"Duplicate review finds exact-content matches, not similar images. Confirm the scan completed and intended sources are available. Resized or recompressed copies are not byte-identical and may not be grouped.","searchText":"Duplicate scan finds no groups Duplicate review finds exact-content matches, not similar images. Confirm the scan completed and intended sources are available. Resized or recompressed copies are not byte-identical and may not be grouped."},
  {"chapterTitle":"Troubleshooting","title":"Phone is not detected","guidePath":"/guide/12-troubleshooting","excerpt":"Use a data-capable cable and connect directly if a hub is suspect. On iPhone/iPad: unlock the device, choose Trust This Computer , and reconnect. On Android: enable USB debugging, select file-transfer mode if required and approve…","searchText":"Phone is not detected Use a data-capable cable and connect directly if a hub is suspect. On iPhone/iPad: unlock the device, choose Trust This Computer , and reconnect. On Android: enable USB debugging, select file-transfer mode if required and approve the debugging computer prompt. Confirm required tools are installed ( libimobiledevice for iOS connection, Android platform tools/ adb for Android). iOS will not expose the entire protected filesystem to Silo."},
  {"chapterTitle":"Troubleshooting","title":"Google sign-in fails","guidePath":"/guide/12-troubleshooting","excerpt":"Check that the build has supported OAuth credentials, the correct Google APIs/scopes are enabled and the signed-in account is an allowed test user if the app remains in testing mode. Reconnect an expired/revoked session. Never…","searchText":"Google sign-in fails Check that the build has supported OAuth credentials, the correct Google APIs/scopes are enabled and the signed-in account is an allowed test user if the app remains in testing mode. Reconnect an expired/revoked session. Never paste a client secret or access token into a public issue or chat."},
  {"chapterTitle":"Troubleshooting","title":"Time Machine appears empty","guidePath":"/guide/12-troubleshooting","excerpt":"Grant Full Disk Access to the actual Silo app in macOS Privacy & Security settings, then quit and reopen Silo. A development build may require granting access to Electron. See Backups and Time Machine .","searchText":"Time Machine appears empty Grant Full Disk Access to the actual Silo app in macOS Privacy & Security settings, then quit and reopen Silo. A development build may require granting access to Electron. See Backups and Time Machine ."},
  {"chapterTitle":"Troubleshooting","title":"macOS blocks the installer","guidePath":"/guide/12-troubleshooting","excerpt":"Verify the download checksum and ensure it came from the official Silo release source. A verified unsigned preview may need the per-app Open Anyway action. If macOS says “damaged” or “will damage your computer,” do not bypass…","searchText":"macOS blocks the installer Verify the download checksum and ensure it came from the official Silo release source. A verified unsigned preview may need the per-app Open Anyway action. If macOS says “damaged” or “will damage your computer,” do not bypass it—download again and ask support."},
  {"chapterTitle":"Troubleshooting","title":"Report a useful bug","guidePath":"/guide/12-troubleshooting","excerpt":"Include: Silo version shown in About or the installer, Mac chip (Intel/Apple silicon), macOS version, the active source type, the exact progress stage, steps to reproduce, and a screenshot with private names/photos/paths removed.…","searchText":"Report a useful bug Include: Silo version shown in About or the installer, Mac chip (Intel/Apple silicon), macOS version, the active source type, the exact progress stage, steps to reproduce, and a screenshot with private names/photos/paths removed. Do not attach config backup exports; they can contain tokens."},
  {"chapterTitle":"Compatibility and known limits","title":"What is verified for this guide","guidePath":"/guide/13-compatibility","excerpt":"The feature descriptions in this guide were checked against the Silo source checkout's package.json version 2.0.2 on October 9, 2026 . The actual installed app used for the screenshots reports CFBundleShortVersionString 1.0.0 and…","searchText":"What is verified for this guide The feature descriptions in this guide were checked against the Silo source checkout's package.json version 2.0.2 on October 9, 2026 . The actual installed app used for the screenshots reports CFBundleShortVersionString 1.0.0 and LSMinimumSystemVersion 12.0 in its bundle metadata. These are conflicting version signals. That means the installed screenshot build's declared macOS floor is 12.0, but it does not prove that every Silo 2.0.2 preview has been tested on every Mac or every macOS release. Treat the 2.0.2 package's exact minimum macOS and hardware compatibility as unconfirmed until its installer metadata and release notes agree. The repository config defines architecture-specific Mac artifacts and an x64 Windows installer target. A configured target is build intent, not a substitute for installing and testing each artifact on real Intel and Apple silicon Macs and on the supported Windows versions."},
  {"chapterTitle":"Compatibility and known limits","title":"Feature limitations to know","guidePath":"/guide/13-compatibility","excerpt":"First-run indexing and cold-start search preparation can take time; search coverage grows with completed indexing. CLIP is visual semantic matching. It can miss relevant items or return approximate matches; it is not a guarantee…","searchText":"Feature limitations to know First-run indexing and cold-start search preparation can take time; search coverage grows with completed indexing. CLIP is visual semantic matching. It can miss relevant items or return approximate matches; it is not a guarantee and is not general OCR. People groups are model suggestions and require human review. Face angle, lighting, occlusion and image quality affect results. Map needs location metadata; it does not infer GPS from a scene. Duplicate scan finds exact file-content matches, not visually similar or edited copies. Digital Folders refer to originals; offline references cannot make an unavailable original readable. iOS connection is limited to Apple's exposed media area; Android requires USB debugging authorization. Google Photos provides only user-picked items and is read-only. Google Drive requires network access and configured OAuth. Local library sharing is unencrypted HTTP and should stay on trusted private Wi-Fi. Configuration backups can contain access tokens; phone backups are a separate data set. Exported movies, previews and caches need additional disk space."},
  {"chapterTitle":"Compatibility and known limits","title":"Build compatibility checklist for a release","guidePath":"/guide/13-compatibility","excerpt":"Before describing a particular installer as compatible, record the exact installer filename/checksum, app bundle version, CPU architecture, macOS/Windows version, Mac model/chip, launch result, core workflows tested and any known…","searchText":"Build compatibility checklist for a release Before describing a particular installer as compatible, record the exact installer filename/checksum, app bundle version, CPU architecture, macOS/Windows version, Mac model/chip, launch result, core workflows tested and any known failures. Test both architecture-specific Mac builds on real hardware; do not infer Intel compatibility from Apple silicon or vice versa."},
  {"chapterTitle":"License, demo and support access","title":"What the source currently advertises","guidePath":"/guide/14-license-and-demo","excerpt":"Silo's built-in Help describes a $25 USDC one-time payment on Solana for lifetime access, rather than a recurring subscription. The listed benefits include unlimited sources/files, Digital Folders, Memories previews and mapped…","searchText":"The in-app Settings/license area can show whether this Mac has lifetime access and may offer a beta-access request, payment options or manual transaction-signature verification. What is visible and what actually works depend on the exact client build and the deployed license relay. What the source currently advertises Silo's built-in Help describes a $25 USDC one-time payment on Solana for lifetime access, rather than a recurring subscription. The listed benefits include unlimited sources/files, Digital Folders, Memories previews and mapped locations. Confirm the current offer and terms in the actual release before paying; this page records source copy, not a verified live checkout."},
  {"chapterTitle":"License, demo and support access","title":"One computer per lifetime license","guidePath":"/guide/14-license-and-demo","excerpt":"Each $25 lifetime purchase unlocks one computer. Silo config exports can transfer settings and selected indexes, but do not include paid or beta licenses or the installation ID; buy a separate license for each computer. Paid access starts after the relay verifies a finalized USDC payment and binds it to that Silo installation. Keep transaction signatures private and never share a wallet seed phrase or private key.","searchText":"One computer per lifetime license Each $25 lifetime purchase unlocks one computer. Silo config exports can transfer settings and selected indexes, but do not include paid or beta licenses or the installation ID; buy a separate license for each computer. Paid access starts after the relay verifies a finalized USDC payment and binds it to that Silo installation. Keep transaction signatures private and never share a wallet seed phrase or private key."},
  {"chapterTitle":"License, demo and support access","title":"Demo or beta access","guidePath":"/guide/14-license-and-demo","excerpt":"A preview may expose beta-access request or activation controls. Those controls require the matching release service and configuration to be live. A test/demo mode may limit browsing or licensing state without deleting indexed…","searchText":"Demo or beta access A preview may expose beta-access request or activation controls. Those controls require the matching release service and configuration to be live. A test/demo mode may limit browsing or licensing state without deleting indexed records, but exact behavior can differ between builds. Read the status displayed by the installed app and the release notes for that build."},
  {"chapterTitle":"License, demo and support access","title":"Support reports","guidePath":"/guide/14-license-and-demo","excerpt":"Settings may include a bug-report flow. Before sending, review any screenshot and text for faces, paths, filenames, account names and other personal details. Do not attach license signatures, private keys, or config exports that…","searchText":"Support reports Settings may include a bug-report flow. Before sending, review any screenshot and text for faces, paths, filenames, account names and other personal details. Do not attach license signatures, private keys, or config exports that may contain access tokens."},
];

const GUIDE_DOC_SECTIONS = ALL_GUIDE_DOC_SECTIONS.filter(
  (section) =>
    GOOGLE_FEATURES_ENABLED ||
    (!section.guidePath.includes("cloud-sources") && !/google/i.test(section.title)),
);
const HELP_ARTICLES = ALL_HELP_ARTICLES;

const HELP_SEARCH_STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "before",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "more",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "up",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function normalizeHelpWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (
    word.length > 5 &&
    /(?:ches|shes|xes|zes|sses)$/.test(word)
  ) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function getHelpWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(normalizeHelpWord);
}

function getHelpQueryTerms(query: string): string[] {
  const expandedQuery = query
    .toLowerCase()
    .replace(/\bcan['’]t\b/g, "can not")
    .replace(/\bwon['’]t\b/g, "will not")
    .replace(/n['’]t\b/g, " not");
  const rawWords = expandedQuery.match(/[a-z0-9]+/g) ?? [];
  return Array.from(
    new Set(
      rawWords
        .filter(
          (word) => word.length > 1 && !HELP_SEARCH_STOP_WORDS.has(word),
        )
        .map(normalizeHelpWord),
    ),
  );
}

function searchGuideSections(query: string): GuideDocSection[] {
  const terms = getHelpQueryTerms(query);
  if (terms.length === 0) return [];

  const ranked: Array<{ section: GuideDocSection; score: number }> = [];
  for (const section of GUIDE_DOC_SECTIONS) {
    const sectionTitleWords = new Set(getHelpWords(section.title));
    const chapterTitleWords = new Set(getHelpWords(section.chapterTitle));
    const wordCounts = new Map<string, number>();
    for (const word of getHelpWords(section.searchText)) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }

    let matchedTerms = 0;
    let score = 0;
    for (const term of terms) {
      const sectionTitleMatch = sectionTitleWords.has(term);
      const chapterTitleMatch = chapterTitleWords.has(term);
      const occurrences = wordCounts.get(term) ?? 0;
      if (!sectionTitleMatch && !chapterTitleMatch && occurrences === 0) continue;
      matchedTerms += 1;
      score +=
        (sectionTitleMatch ? 12 : 0) +
        (chapterTitleMatch ? 3 : 0) +
        Math.min(occurrences, 3);
    }

    const requiredMatches = Math.ceil(terms.length / 2);
    if (matchedTerms < requiredMatches) continue;
    if (matchedTerms === terms.length) score += 6;
    ranked.push({ section, score });
  }

  return ranked
    .sort((first, second) => second.score - first.score)
    .slice(0, 6)
    .map(({ section }) => section);
}

const GUIDE_PAGE_COUNT = new Set(
  GUIDE_DOC_SECTIONS.map((section) => section.guidePath),
).size;

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
    const terms = getHelpQueryTerms(query);
    if (terms.length === 0) return query.trim() ? [] : HELP_ARTICLES;
    return HELP_ARTICLES.filter((article) => {
      const words = new Set(
        getHelpWords(`${article.title} ${article.keywords} ${article.answer}`),
      );
      return terms.some((term) => words.has(term));
    }).sort((first, second) => {
      const score = (article: LocalHelpTopic) => {
        const titleWords = new Set(getHelpWords(article.title));
        const answerWords = new Set(getHelpWords(article.answer));
        return terms.reduce(
          (total, term) =>
            total +
            (titleWords.has(term) ? 4 : 0) +
            (answerWords.has(term) ? 1 : 0),
          0,
        );
      };
      return score(second) - score(first);
    });
  }, [query]);
  const matchingGuideSections = useMemo(
    () => searchGuideSections(submittedQuery),
    [submittedQuery],
  );
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
              <p>
                Search answers and guide sections offline. Read more opens the
                full guide in your browser.
              </p>
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
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSubmittedQuery("");
              setActiveArticleId("");
            }}
            placeholder="Search the guide by keyword…"
            aria-label="Search built-in help and guide sections"
          />
          <button type="submit">Ask</button>
        </form>
        <div className="local-help-conversation" aria-live="polite">
          {submittedQuery && (
            <div className="local-help-user-bubble">{submittedQuery}</div>
          )}
          {activeArticle && (
            <article className="local-help-answer">
              <h3>
                <FiBookOpen aria-hidden="true" /> {activeArticle.title}
              </h3>
              <p>{activeArticle.answer}</p>
              <div className="local-help-answer-actions">
                <button
                  type="button"
                  className="local-help-show-control"
                  onClick={() => onShowInApp(activeArticle)}
                >
                  Show this control in Silo
                </button>
                <a
                  className="local-help-read-more"
                  href={`https://silohelp.kolektivkrog.si${activeArticle.guidePath}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Read more about ${activeArticle.title} in the Silo user guide`}
                >
                  Read more <FiExternalLink aria-hidden="true" />
                </a>
              </div>
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
          )}
          {matchingGuideSections.length > 0 && (
            <section
              className="local-help-guide-results"
              aria-label="Matching sections in the Silo guide"
            >
              <h3>
                <FiBookOpen aria-hidden="true" /> Full guide sections
              </h3>
              {matchingGuideSections.map((section) => (
                <article
                  className="local-help-guide-result"
                  key={`${section.guidePath}:${section.title}`}
                >
                  <h4>{section.title}</h4>
                  <span>{section.chapterTitle}</span>
                  <p>{section.excerpt}</p>
                  <a
                    href={`https://silohelp.kolektivkrog.si${section.guidePath}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Read ${section.title} in ${section.chapterTitle}`}
                  >
                    Read section <FiExternalLink aria-hidden="true" />
                  </a>
                </article>
              ))}
            </section>
          )}
          {!activeArticle && matchingGuideSections.length === 0 && submittedQuery && (
            <div className="local-help-answer" role="status">
              I couldn’t find a matching help topic or guide section. Try a
              feature name such as “indexing,” “faces,” “duplicates,” or “backup.”
            </div>
          )}
          {!activeArticle && !submittedQuery && (
            <div className="local-help-answer local-help-welcome">
              Search the offline answers and all {GUIDE_PAGE_COUNT} pages of the
              full Silo guide by keyword. Opening a guide section needs an
              internet connection.
            </div>
          )}
        </div>
        <footer className="local-help-footer">
          <span>{HELP_ARTICLES.length} answers · {GUIDE_PAGE_COUNT} guide pages indexed</span>
          <button type="button" className="local-help-tour" onClick={onStartTour}>
            Start guided tour
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
