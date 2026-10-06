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
exports.discoverMemoryStories = exports.meaningfulFolderName = exports.isPersonalPhotoPath = exports.MEMORY_PHOTO_PROMPTS = exports.MEMORY_JUNK_PROMPTS = exports.MEMORY_CONCEPTS = exports.MIN_EMERGING_PHOTOS = exports.MIN_STORY_PHOTOS = void 0;
const path = __importStar(require("path"));
exports.MIN_STORY_PHOTOS = 4;
/** Recent photos needed before a topic counts as emerging; one or two files never do. */
exports.MIN_EMERGING_PHOTOS = 6;
const MAX_STORY_PATHS = 160;
const DAY = 24 * 60 * 60 * 1000;
exports.MEMORY_CONCEPTS = [
    { id: "sailing", label: "Sailing", title: "Under Sail", prompt: "sailing on a sailboat with sails at sea", mood: "bright" },
    { id: "rockhounding", label: "Rockhounding", title: "Rockhounding Finds", prompt: "rocks, minerals, crystals and geodes collected by hand", mood: "gentle" },
    { id: "paragliding", label: "Paragliding", title: "Paragliding", prompt: "paragliding with a paraglider wing in the sky", mood: "energetic" },
    { id: "hiking", label: "Hiking", title: "Trail Days", prompt: "hiking on a mountain trail with a backpack", mood: "energetic" },
    { id: "climbing", label: "Climbing", title: "On the Rocks", prompt: "rock climbing on a cliff wall", mood: "energetic" },
    { id: "skiing", label: "Skiing", title: "Ski Days", prompt: "skiing or snowboarding on snowy slopes", mood: "energetic" },
    { id: "surfing", label: "Surfing", title: "Chasing Waves", prompt: "surfing on ocean waves with a surfboard", mood: "energetic" },
    { id: "diving", label: "Diving", title: "Below the Surface", prompt: "underwater scuba diving or snorkeling with fish", mood: "gentle" },
    { id: "kayaking", label: "Paddling", title: "Paddle Days", prompt: "kayaking or canoeing on a river or lake", mood: "bright" },
    { id: "cycling", label: "Cycling", title: "On Two Wheels", prompt: "riding a bicycle on a road or mountain bike trail", mood: "energetic" },
    { id: "running", label: "Running", title: "Race Day", prompt: "running a race or marathon with a race number", mood: "energetic" },
    { id: "camping", label: "Camping", title: "Under Canvas", prompt: "camping with a tent and campfire outdoors", mood: "gentle" },
    { id: "fishing", label: "Fishing", title: "Gone Fishing", prompt: "fishing with a fishing rod holding a fish", mood: "gentle" },
    { id: "horses", label: "Riding", title: "In the Saddle", prompt: "horse riding with horses", mood: "gentle" },
    { id: "seaside", label: "Seaside", title: "By the Sea", prompt: "a sunny seaside coast with turquoise water and beach", mood: "bright", scenery: true },
    { id: "mountains", label: "Mountains", title: "Mountain Air", prompt: "high mountains and alpine peaks landscape", mood: "dramatic", scenery: true },
    { id: "lakes", label: "Lakes", title: "Lakeside", prompt: "a calm lake shore with reflections", mood: "gentle", scenery: true },
    { id: "waterfalls", label: "Waterfalls", title: "Falling Water", prompt: "a waterfall in nature", mood: "dramatic", scenery: true },
    { id: "forest", label: "Woods", title: "Into the Woods", prompt: "walking in a green forest with tall trees", mood: "gentle", scenery: true },
    { id: "desert", label: "Desert", title: "Desert Light", prompt: "desert sand dunes and canyons", mood: "dramatic", scenery: true },
    { id: "snow", label: "Snow", title: "Snow Days", prompt: "snowy winter landscape with snow everywhere", mood: "bright", scenery: true },
    { id: "sunsets", label: "Sunsets", title: "Golden Hour", prompt: "a colorful sunset or sunrise sky", mood: "gentle", scenery: true },
    { id: "stars", label: "Night Skies", title: "Night Skies", prompt: "the night sky with stars, milky way or northern lights", mood: "dramatic", scenery: true },
    { id: "city", label: "City Streets", title: "City Wandering", prompt: "old town city streets and buildings while traveling", mood: "energetic", scenery: true },
    { id: "castles", label: "Castles", title: "Castles and Ruins", prompt: "a medieval castle, fortress or ancient ruins", mood: "dramatic", scenery: true },
    { id: "islands", label: "Islands", title: "Island Hopping", prompt: "a small island with a harbor and boats", mood: "bright", scenery: true },
    { id: "harbor", label: "Harbors", title: "Harbor Life", prompt: "boats moored in a harbor or marina", mood: "gentle", scenery: true },
    { id: "concerts", label: "Concerts", title: "Live Music", prompt: "a concert with a band on stage and crowd", mood: "energetic" },
    { id: "festivals", label: "Festivals", title: "Festival Season", prompt: "a festival or parade with crowds and lights", mood: "energetic" },
    { id: "weddings", label: "Weddings", title: "Wedding Days", prompt: "a wedding ceremony with bride and groom", mood: "gentle" },
    { id: "birthdays", label: "Birthdays", title: "Birthday Wishes", prompt: "a birthday party with cake and candles", mood: "bright" },
    { id: "christmas", label: "Holidays", title: "Holiday Season", prompt: "christmas tree, decorations and presents", mood: "gentle" },
    { id: "food", label: "Food", title: "Good Food", prompt: "a delicious plate of food on a restaurant table", mood: "bright" },
    { id: "cooking", label: "Cooking", title: "In the Kitchen", prompt: "cooking food in a home kitchen", mood: "gentle" },
    { id: "coffee", label: "Café", title: "Café Stops", prompt: "coffee cups at a cafe table", mood: "gentle" },
    { id: "wine", label: "Vineyards", title: "Among the Vines", prompt: "a vineyard with grapes or wine glasses", mood: "gentle" },
    { id: "garden", label: "Gardens", title: "Garden Stories", prompt: "flowers blooming in a garden", mood: "gentle" },
    { id: "dogs", label: "Dogs", title: "Good Dogs", prompt: "a dog playing outdoors", mood: "bright" },
    { id: "cats", label: "Cats", title: "Cat Naps", prompt: "a cat at home", mood: "gentle" },
    { id: "wildlife", label: "Wildlife", title: "Wild Encounters", prompt: "wild animals in nature", mood: "dramatic" },
    { id: "birds", label: "Birds", title: "Birdwatching", prompt: "birds perched or flying", mood: "gentle" },
    { id: "cars", label: "Cars", title: "Cars and Engines", prompt: "classic or sports cars at a car show", mood: "energetic" },
    { id: "motorsport", label: "Motorsport", title: "Rally Weekend", prompt: "rally cars racing on a dirt road", mood: "energetic" },
    { id: "motorcycles", label: "Motorcycles", title: "Two-Wheel Trips", prompt: "riding motorcycles", mood: "energetic" },
    { id: "trains", label: "Trains", title: "By Rail", prompt: "trains and railway stations", mood: "gentle" },
    { id: "aviation", label: "Flying", title: "Up in the Air", prompt: "airplanes or the view from an airplane window", mood: "dramatic" },
    { id: "roadtrip", label: "Road Trips", title: "Road Trip", prompt: "a scenic road trip through the countryside", mood: "energetic", scenery: true },
    { id: "kids", label: "Kids", title: "Growing Up", prompt: "children playing and laughing", mood: "bright" },
    { id: "babies", label: "Little Ones", title: "Little Ones", prompt: "a baby or toddler", mood: "gentle" },
    { id: "friends", label: "Friends", title: "Good Company", prompt: "a group of friends together smiling", mood: "bright" },
    { id: "family", label: "Family", title: "Family Table", prompt: "family gathered around a dinner table", mood: "gentle" },
    { id: "soccer", label: "Game Day", title: "Game Day", prompt: "playing a team sport like soccer or basketball", mood: "energetic" },
    { id: "pool", label: "Pool Days", title: "Pool Days", prompt: "swimming in a swimming pool in summer", mood: "bright" },
    { id: "museums", label: "Museums", title: "Gallery Days", prompt: "art in a museum or gallery", mood: "gentle" },
    { id: "crafts", label: "Workshop", title: "Made by Hand", prompt: "woodworking, crafts or building something in a workshop", mood: "gentle" },
    { id: "fossils", label: "Fossils", title: "Fossil Hunting", prompt: "fossils and shells found on a beach or rock", mood: "gentle" },
];
/** Never story material; images closest to these are dropped. */
exports.MEMORY_JUNK_PROMPTS = [
    "a screenshot of a phone app or website",
    "a scanned document or a page of text",
    "a receipt, invoice or form",
    "a meme with text",
    "a blurry dark accidental photo",
    "a music album cover with the band name",
    "an app icon or company logo",
    "a poster, flyer or book cover",
    "clip art, a cartoon or a digital illustration",
    "a video game screenshot",
    "a product photo on a plain white background",
    "a map, chart or diagram",
];
exports.MEMORY_PHOTO_PROMPTS = [
    "a candid photo of people",
    "a travel photo of a landscape",
    "a photo of a memorable moment",
];
// Formats cameras and phones write; PNG/GIF/WebP/etc. are almost always screenshots or graphics.
const CAMERA_EXTENSIONS = /\.(jpe?g|heic|heif|dng|cr2|cr3|nef|arw|orf|rw2|raf|pef|srw|tiff?)$/i;
const MIN_CAMERA_BYTES = 150 * 1024;
const NON_PERSONAL_SEGMENT = /(^|[\\/])(node_modules|[^\\/]+\.(app|bundle|framework|plugin|asar)|Library[\\/](Caches|Containers|Application Support|Group Containers)|iTunes|Album ?Art(work)?|Artwork|Covers?|Icons?|Logos?|Thumbnails?|thumbs|\.thumbnails|Fonts?|Wallpapers?|Backgrounds?|Stock|Clip ?art|Emojis?|Stickers|Assets|Resources|Templates|Screenshots?|Screen Shots?|Memes?|Avatars?|Previews?)([\\/]|$)/i;
const NON_PERSONAL_NAME = /^(cover|folder|front|back|cd\d?|disc\d?|albumart[^.]*|artwork|thumb[^.]*|icon[^.]*|logo[^.]*|avatar[^.]*|screenshot[^.]*|screen shot[^.]*|poster[^.]*|banner[^.]*)\.[a-z0-9]+$/i;
/**
 * Cheap path/size test for "a photo from the user's life": camera formats, real file
 * sizes, outside app bundles, artwork/icon folders, and folders that hold music (album art).
 */
function isPersonalPhotoPath(filePath, size, musicDirectories) {
    if (!CAMERA_EXTENSIONS.test(filePath))
        return false;
    if (Number.isFinite(size) && size < MIN_CAMERA_BYTES)
        return false;
    if (NON_PERSONAL_SEGMENT.test(path.dirname(filePath)) || NON_PERSONAL_NAME.test(path.basename(filePath)))
        return false;
    if (musicDirectories?.has(path.dirname(filePath)))
        return false;
    return true;
}
exports.isPersonalPhotoPath = isPersonalPhotoPath;
const DEMONYMS = {
    croatia: "Croatian", italy: "Italian", france: "French", spain: "Spanish", portugal: "Portuguese",
    greece: "Greek", germany: "German", austria: "Austrian", switzerland: "Swiss", slovenia: "Slovenian",
    montenegro: "Montenegrin", "bosnia and herzegovina": "Bosnian", serbia: "Serbian", hungary: "Hungarian",
    czechia: "Czech", "czech republic": "Czech", poland: "Polish", netherlands: "Dutch", belgium: "Belgian",
    "united kingdom": "British", ireland: "Irish", iceland: "Icelandic", norway: "Norwegian", sweden: "Swedish",
    denmark: "Danish", finland: "Finnish", turkey: "Turkish", türkiye: "Turkish", georgia: "Georgian",
    mexico: "Mexican", canada: "Canadian", japan: "Japanese", thailand: "Thai", vietnam: "Vietnamese",
    indonesia: "Indonesian", australia: "Australian", "new zealand": "Kiwi", morocco: "Moroccan",
    egypt: "Egyptian", peru: "Peruvian", chile: "Chilean", argentina: "Argentine", brazil: "Brazilian",
    "united states": "American", "united states of america": "American", usa: "American", india: "Indian",
    china: "Chinese", "south korea": "Korean", malta: "Maltese", cyprus: "Cypriot", albania: "Albanian",
};
const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December"];
const GENERIC_FOLDER = /^(dcim|camera|camera roll|photos?|pictures?|images?|img|imports?|downloads?|desktop|documents?|backups?|phone backups?|media|mobile|screenshots?|whatsapp|whatsapp images|telegram|signal|icloud|icloud photos|google photos|takeout|originals?|edited|exports?|untitled( folder)?|new folder|misc|other|temp|tmp|cache|thumbnails?|private|var|mobile documents|photodata|cpl ?assets|sent|received|unsorted|all|archive|old|stuff|files?|ios|android|users?|volumes?|look|dox|data)$/i;
function clean(text) {
    return text.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}
function titleCase(text) {
    return text === text.toLowerCase()
        ? text.replace(/(^|[\s-])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase())
        : text;
}
/** Folder names people chose themselves ("Croatia 2019", "Sailing with Dad"). */
function meaningfulFolderName(folder) {
    const name = clean(folder);
    if (name.length < 4 || name.length > 60 || GENERIC_FOLDER.test(name))
        return null;
    // Document packages and bundles ("Newsletter.template", "Project.pages") are not albums.
    if (/\.[a-z][a-z0-9]{1,14}$/i.test(name))
        return null;
    if (/^\d{3}[a-z]{5}$/i.test(name) || /^\d{3}_?\d{4}$/.test(name))
        return null; // 100APPLE, 100_0001
    if (/^[\d\s._:-]+$/.test(name))
        return null; // dates and counters only
    if (/^[a-f0-9-]{16,}$/i.test(name) || /^[A-Z0-9]{8}-/.test(name))
        return null; // uuids/hashes
    if (/^(img|dsc|dscn|pxl|mvimg|vid|mov)[\s_-]?\d/i.test(name))
        return null;
    if (!/\p{L}{3,}/u.test(name))
        return null;
    return titleCase(name);
}
exports.meaningfulFolderName = meaningfulFolderName;
function numberWord(value) {
    return value < NUMBER_WORDS.length ? NUMBER_WORDS[value] : String(value);
}
/** Days apart within a year, ignoring the year. */
function calendarDistance(first, second) {
    const a = Date.UTC(2001, first.getMonth(), first.getDate());
    const b = Date.UTC(2001, second.getMonth(), second.getDate());
    const distance = Math.abs(a - b) / DAY;
    return Math.min(distance, 365 - distance);
}
function season(date) {
    const month = date.getMonth();
    const year = date.getFullYear();
    if (month === 11 || month <= 1) {
        const winterYear = month === 11 ? year + 1 : year;
        return { name: "Winter", year: winterYear, label: `Winter ${winterYear - 1}–${String(winterYear).slice(2)}` };
    }
    const name = month <= 4 ? "Spring" : month <= 7 ? "Summer" : "Autumn";
    return { name, year, label: `${name} ${year}` };
}
/** Evenly samples up to limit paths across the story's time range, best-first order otherwise kept. */
function spread(paths, modified, limit = MAX_STORY_PATHS) {
    if (paths.length <= limit)
        return paths;
    const sorted = paths.slice().sort((a, b) => (modified.get(a) ?? 0) - (modified.get(b) ?? 0));
    const result = [];
    for (let index = 0; index < limit; index++)
        result.push(sorted[Math.floor((index * sorted.length) / limit)]);
    return result;
}
function yearsOf(paths, modified) {
    const years = new Set();
    for (const filePath of paths) {
        const time = modified.get(filePath);
        if (time)
            years.add(new Date(time).getFullYear());
    }
    return years;
}
/**
 * Copy operations stamp thousands of files with the same minute. Those mtimes say
 * nothing about when a photo was taken, so time-based stories ignore them.
 */
function trustworthyTimes(images) {
    const perMinute = new Map();
    for (const image of images) {
        const minute = Math.floor(image.modified / 60000);
        perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    return images.filter((image) => (perMinute.get(Math.floor(image.modified / 60000)) ?? 0) <= 40);
}
function shuffle(items, random) {
    for (let index = items.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [items[index], items[swap]] = [items[swap], items[index]];
    }
    return items;
}
function dominant(values) {
    const counts = new Map();
    let total = 0;
    for (const value of values) {
        if (value === null || value === undefined)
            continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
        total += 1;
    }
    let best = null;
    let bestCount = 0;
    for (const [value, count] of counts)
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    return best === null ? null : { value: best, share: bestCount / Math.max(1, total) };
}
function discoverMemoryStories(input) {
    const random = input.random ?? Math.random;
    const now = new Date(input.now ?? Date.now());
    const modified = new Map();
    const normalized = [];
    for (const image of input.images) {
        if (!Number.isFinite(image.modified))
            continue;
        const exact = Number.isFinite(image.captured) && image.captured > 0;
        const time = exact ? image.captured : image.modified;
        modified.set(image.path, time);
        normalized.push({ path: image.path, modified: time, exact });
    }
    const known = (paths) => paths.filter((filePath) => modified.has(filePath));
    const ideas = [];
    // Relative appeal per kind; multiplied by sqrt(support) so prevalent subjects lead.
    const KIND_WEIGHT = {
        person: 3, pet: 2, concept: 2, recent: 2.5, "on-this-day": 2, place: 1.6, event: 1.3, season: 1, year: 0.8, folder: 1,
    };
    const add = (idea) => {
        const { support, boost, ...rest } = idea;
        const paths = Array.from(new Set(known(rest.paths)));
        if (paths.length < exports.MIN_STORY_PHOTOS)
            return;
        ideas.push({ ...rest, paths: spread(paths, modified),
            weight: KIND_WEIGHT[rest.kind] * Math.sqrt(Math.max(paths.length, support ?? 0)) * (boost ?? 1) });
    };
    // Capture times are trusted; file times only after removing copy-burst artifacts.
    const timed = [...normalized.filter((image) => image.exact),
        ...trustworthyTimes(normalized.filter((image) => !image.exact))];
    const signalById = new Map((input.topics ?? []).map((signal) => [signal.id, signal]));
    const conceptById = new Map(exports.MEMORY_CONCEPTS.map((concept) => [concept.id, concept]));
    const placeByPath = new Map((input.places ?? []).map((place) => [place.path, place]));
    // On this day, N years ago.
    const thisWeek = new Map();
    for (const image of timed) {
        const date = new Date(image.modified);
        if (date.getFullYear() >= now.getFullYear() || calendarDistance(date, now) > 3)
            continue;
        const list = thisWeek.get(date.getFullYear()) ?? [];
        list.push(image.path);
        thisWeek.set(date.getFullYear(), list);
    }
    for (const [year, paths] of thisWeek) {
        const ago = now.getFullYear() - year;
        add({ key: `on-this-day:${year}`, kind: "on-this-day",
            title: `This Week, ${numberWord(ago)} Year${ago === 1 ? "" : "s"} Ago`,
            description: `What you were up to around ${MONTHS[now.getMonth()]} ${now.getDate()}, ${year}.`,
            query: `memories from this week in ${year}`, mood: "gentle", paths });
    }
    if (thisWeek.size >= 2)
        add({ key: "on-this-day:all", kind: "on-this-day", title: "This Week Over the Years",
            description: `The same week of ${MONTHS[now.getMonth()]}, year after year.`,
            query: "this week over the years", mood: "gentle",
            paths: Array.from(thisWeek.values()).flat() });
    // Seasons and years.
    const seasons = new Map();
    const years = new Map();
    for (const image of timed) {
        const date = new Date(image.modified);
        const info = season(date);
        const entry = seasons.get(info.label) ?? { ...info, paths: [] };
        entry.paths.push(image.path);
        seasons.set(info.label, entry);
        const yearList = years.get(date.getFullYear()) ?? [];
        yearList.push(image.path);
        years.set(date.getFullYear(), yearList);
    }
    const lastSummerYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    for (const entry of seasons.values()) {
        if (entry.paths.length < 12 && !(entry.name === "Summer" && entry.year === lastSummerYear))
            continue;
        const isLastSummer = entry.name === "Summer" && entry.year === lastSummerYear;
        add({ key: `season:${entry.label}`, kind: "season",
            title: isLastSummer ? "Last Summer" : entry.label,
            description: isLastSummer ? `Long days from the summer of ${entry.year}.` : `Moments from ${entry.label.toLowerCase()}.`,
            query: `${entry.name.toLowerCase()} ${entry.year}`, mood: entry.name === "Winter" ? "gentle" : "bright",
            paths: entry.paths });
    }
    const yearKeys = Array.from(years.keys()).sort();
    for (const year of yearKeys) {
        if (year === now.getFullYear() || (years.get(year)?.length ?? 0) < 20)
            continue;
        add({ key: `year:${year}`, kind: "year", title: `A Look Back at ${year}`,
            description: `Highlights from across ${year}.`, query: `the year ${year}`, mood: "gentle",
            paths: years.get(year) });
    }
    if (yearKeys.length >= 3)
        add({ key: "years:all", kind: "year", title: "Over the Years",
            description: `${yearKeys[0]} to ${yearKeys[yearKeys.length - 1]}, a few frames from every year.`,
            query: "over the years", mood: "gentle",
            paths: yearKeys.flatMap((year) => (years.get(year) ?? []).slice(0, 12)) });
    // Events and trips: dense runs of photos separated by quiet gaps.
    const chronological = timed.slice().sort((a, b) => a.modified - b.modified);
    const events = [];
    let current = [];
    for (const image of chronological) {
        if (current.length && image.modified - current[current.length - 1].modified > 36 * 60 * 60 * 1000) {
            events.push(current);
            current = [];
        }
        current.push(image);
    }
    if (current.length)
        events.push(current);
    const bigEvents = events.filter((event) => event.length >= 10)
        .sort((a, b) => b.length - a.length).slice(0, 24);
    for (const event of bigEvents) {
        const start = new Date(event[0].modified);
        const end = new Date(event[event.length - 1].modified);
        const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY) + 1);
        const paths = event.map((image) => image.path);
        const placeLabels = paths.map((filePath) => {
            const place = placeByPath.get(filePath);
            return place ? place.city ?? place.region ?? place.country : null;
        });
        const place = dominant(placeLabels);
        const folder = dominant(paths.map((filePath) => meaningfulFolderName(path.basename(path.dirname(filePath)))));
        const when = `${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
        const title = place && place.share >= 0.5
            ? `${place.value}, ${when}`
            : folder && folder.share >= 0.6
                ? folder.value
                : days === 1 ? `A Day in ${when}` : `${numberWord(days)} Days in ${when}`;
        add({ key: `event:${start.toISOString().slice(0, 10)}`, kind: "event", title,
            description: days === 1 ? `One full day from ${when}.` : `${days} days of photos from ${when}.`,
            query: title, mood: days > 2 ? "energetic" : "bright", paths });
    }
    // Places, with scenery when one concept dominates the place.
    const conceptSets = (input.concepts ?? []).map((concept) => ({ concept, set: new Set(concept.paths) }));
    const placeGroups = new Map();
    for (const place of input.places ?? []) {
        for (const level of ["city", "region", "country"]) {
            const name = place[level];
            if (!name)
                continue;
            const key = `${level}:${name.toLowerCase()}`;
            const group = placeGroups.get(key) ?? { level, name, country: place.country, paths: [] };
            group.paths.push(place.path);
            placeGroups.set(key, group);
        }
    }
    for (const [key, group] of placeGroups) {
        if (group.paths.length < 6)
            continue;
        const demonym = group.level === "country" ? DEMONYMS[group.name.toLowerCase()] : undefined;
        const adjective = demonym ?? group.name;
        const scenery = conceptSets
            .filter(({ concept }) => conceptById.get(concept.id)?.scenery)
            .map(({ concept, set }) => ({ concept, overlap: group.paths.filter((filePath) => set.has(filePath)) }))
            .sort((a, b) => b.overlap.length - a.overlap.length)[0];
        if (scenery && scenery.overlap.length >= Math.max(exports.MIN_STORY_PHOTOS, group.paths.length * 0.3)) {
            const label = conceptById.get(scenery.concept.id).label;
            add({ key: `place-scenery:${key}:${scenery.concept.id}`, kind: "place", title: `${adjective} ${label}`,
                description: `${label.toLowerCase()} in ${group.name}.`, query: `${label} ${group.name}`,
                mood: conceptById.get(scenery.concept.id).mood, paths: scenery.overlap });
        }
        const variants = group.level === "region"
            ? [`Back in ${group.name}`, `${group.name} Days`]
            : group.level === "city"
                ? [`Days in ${group.name}`, `Back in ${group.name}`, `${group.name} Memories`]
                : [demonym ? `${demonym} Days` : `Memories of ${group.name}`, `Back in ${group.name}`];
        add({ key: `place:${key}`, kind: "place", title: variants[Math.floor(random() * variants.length)],
            description: `Every visit to ${group.name}${group.level !== "country" && group.country && group.country !== group.name ? `, ${group.country}` : ""}.`,
            query: `travel ${group.name}`, mood: "bright", paths: group.paths });
    }
    // People and pets.
    const named = (input.people ?? []).filter((person) => person.name && !/^(person|unknown|animal group)\s*\d*$/i.test(person.name.trim()) && person.paths.length >= 6);
    for (const person of named.slice(0, 16)) {
        const span = yearsOf(person.paths, modified);
        add({ key: `person:${person.name.toLowerCase()}`, kind: "person",
            title: span.size >= 3 ? `${person.name} Over the Years` : `Moments with ${person.name}`,
            description: span.size >= 3 ? `${span.size} years of ${person.name}.` : `Favourite frames of ${person.name}.`,
            query: `portrait of ${person.name}`, mood: "gentle", paths: person.paths });
        const placeOf = dominant(person.paths.map((filePath) => placeByPath.get(filePath)?.country ?? null));
        if (placeOf && placeOf.share < 0.9) {
            const inPlace = person.paths.filter((filePath) => placeByPath.get(filePath)?.country === placeOf.value);
            add({ key: `person-place:${person.name.toLowerCase()}:${placeOf.value.toLowerCase()}`, kind: "person",
                title: `${person.name} in ${placeOf.value}`, description: `${person.name}'s days in ${placeOf.value}.`,
                query: `${person.name} ${placeOf.value}`, mood: "bright", paths: inPlace });
        }
    }
    for (let first = 0; first < Math.min(named.length, 6); first++) {
        const firstSet = new Set(named[first].paths);
        for (let second = first + 1; second < Math.min(named.length, 6); second++) {
            const together = named[second].paths.filter((filePath) => firstSet.has(filePath));
            add({ key: `people:${named[first].name.toLowerCase()}+${named[second].name.toLowerCase()}`, kind: "person",
                title: `${named[first].name} & ${named[second].name}`,
                description: `${named[first].name} and ${named[second].name}, together.`,
                query: `${named[first].name} and ${named[second].name}`, mood: "bright", paths: together });
        }
    }
    const pets = (input.pets ?? []).filter((pet) => pet.paths.length >= exports.MIN_STORY_PHOTOS);
    for (const pet of pets) {
        if (/^animal group\s*\d*$/i.test(pet.name.trim()))
            continue;
        add({ key: `pet:${pet.name.toLowerCase()}`, kind: "pet", title: `${pet.name}'s Greatest Hits`,
            description: `The best of ${pet.name}.`, query: `pet ${pet.name}`, mood: "bright", paths: pet.paths });
    }
    if (pets.length)
        add({ key: "pets:all", kind: "pet", title: "Furry Friends", description: "All the animals in your life.",
            query: "pets dogs cats animals", mood: "bright", paths: pets.flatMap((pet) => pet.paths.slice(0, 40)) });
    // Prevalent subjects, alone, by year, and over the years.
    for (const { concept: found } of conceptSets) {
        const concept = conceptById.get(found.id);
        if (!concept || found.paths.length < exports.MIN_STORY_PHOTOS)
            continue;
        const signal = signalById.get(concept.id);
        // Long-term interest lifts a subject; a real recent surge (enough photos) lifts it further.
        const interestBoost = signal ? 0.6 + signal.interest : 1;
        const emerging = signal && signal.recentCount >= exports.MIN_EMERGING_PHOTOS && signal.lift >= 1.5;
        add({ key: `concept:${concept.id}`, kind: "concept", title: concept.title, support: found.count,
            description: `${concept.label} from across your library.`, query: concept.prompt, mood: concept.mood,
            paths: found.paths, boost: interestBoost });
        if (emerging) {
            const isNew = signal.lift >= 4;
            add({ key: `concept-recent:${concept.id}`, kind: "recent",
                title: isNew ? `New: ${concept.label}` : `Lately: ${concept.label}`,
                description: isNew ? `${concept.label} is new in your recent photos.` : `Lots of ${concept.label.toLowerCase()} in your recent photos.`,
                query: concept.prompt, mood: concept.mood, paths: signal.recentPaths,
                support: signal.recentCount, boost: Math.min(6, signal.lift) });
        }
        const byYear = new Map();
        for (const filePath of found.paths) {
            const time = modified.get(filePath);
            if (!time)
                continue;
            const year = new Date(time).getFullYear();
            byYear.set(year, [...(byYear.get(year) ?? []), filePath]);
        }
        if (byYear.size >= 3)
            add({ key: `concept-years:${concept.id}`, kind: "concept", title: `${concept.label} Over the Years`,
                description: `${concept.label}, ${Math.min(...byYear.keys())} to ${Math.max(...byYear.keys())}.`,
                query: concept.prompt, mood: concept.mood, paths: found.paths });
        for (const [year, paths] of byYear) {
            if (paths.length < 6)
                continue;
            add({ key: `concept-year:${concept.id}:${year}`, kind: "concept",
                title: year === lastSummerYear && concept.scenery ? `${concept.label}, Last Year` : `${concept.label} in ${year}`,
                description: `${concept.label} from ${year}.`, query: concept.prompt, mood: concept.mood, paths });
        }
    }
    // Folders the user named.
    const folders = new Map();
    for (const image of input.images) {
        const directory = path.dirname(image.path);
        const list = folders.get(directory) ?? [];
        list.push(image.path);
        folders.set(directory, list);
    }
    const namedFolders = Array.from(folders).filter(([, paths]) => paths.length >= 6)
        .sort((a, b) => b[1].length - a[1].length).slice(0, 40);
    for (const [directory, paths] of namedFolders) {
        const name = meaningfulFolderName(path.basename(directory));
        if (!name)
            continue;
        add({ key: `folder:${directory}`, kind: "folder", title: name, description: `From your “${name}” folder.`,
            query: name, mood: "gentle", paths });
    }
    // Weighted random order (larger subjects surface more often) with a penalty for repeating a kind.
    const pending = ideas.map((idea) => ({ idea, key: Math.pow(Math.max(random(), 1e-9), 1 / Math.max(idea.weight, 0.1)) }));
    const kindCounts = new Map();
    const result = [];
    while (pending.length) {
        let best = 0;
        let bestScore = -Infinity;
        for (let index = 0; index < pending.length; index++) {
            const score = pending[index].key * 0.6 ** (kindCounts.get(pending[index].idea.kind) ?? 0);
            if (score > bestScore) {
                bestScore = score;
                best = index;
            }
        }
        const [{ idea }] = pending.splice(best, 1);
        kindCounts.set(idea.kind, (kindCounts.get(idea.kind) ?? 0) + 1);
        result.push(idea);
    }
    return result;
}
exports.discoverMemoryStories = discoverMemoryStories;
