// SillyTavern – CHub Search & Import (new API) with Hover Descriptions
// Single-file extension: ready to drop into scripts/extensions/
// Features: /search + /tags, popup UI, paging, sort, NSFW, results-per-page,
// tag autocomplete (mouse + ↑ ↓ Enter Tab Esc), safe fallbacks for downloads.
// NEW: Hover over a character card to see full description in floating box.

import {
    processDroppedFiles,
    callPopup,
} from "../../../../script.js";
import { debounce } from "../../../utils.js";
import { extension_settings } from "../../../extensions.js";

const extensionName = "SillyTavern-Chub-Search";

// API endpoints (new schema)
const API_ENDPOINT_SEARCH = "https://api.chub.ai/search";
const API_ENDPOINT_TAGS = "https://api.chub.ai/tags";

const defaultSettings = {
    findCount: 10,
    nsfw: false,
};

let chubCharacters = [];
let characterListContainer = null;
let savedPopupContent = null;
let availableTags = [];

// ----------------------------- Settings -----------------------------
async function loadSettings() {
    if (!extension_settings.chub) extension_settings.chub = {};
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (!Object.prototype.hasOwnProperty.call(extension_settings.chub, k)) {
            extension_settings.chub[k] = v;
        }
    }
}

// ----------------------------- Tags / Autocomplete -----------------------------
async function fetchTags() {
    try {
        // Prefer POST per spec; fallback to GET if blocked
        let response = await fetch(API_ENDPOINT_TAGS, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });
        if (!response.ok) {
            response = await fetch(`${API_ENDPOINT_TAGS}?limit=5000`, { method: "GET" });
        }
        if (!response.ok) throw new Error(`Tag fetch failed: ${response.status}`);
        const data = await response.json();
        const raw = Array.isArray(data?.tags) ? data.tags : data; // accept either shape
        availableTags = (raw || [])
            .map(t => (typeof t === "string" ? t : t?.tag))
            .filter(t => typeof t === "string" && t.trim().length > 0)
            .sort((a, b) => a.localeCompare(b));
    } catch (err) {
        console.error("CHub tags error:", err);
        availableTags = [];
    }
}

function enableTagAutocomplete(inputEl) {
    let dropdownEl = null;
    let currentIndex = -1;

    const destroyDropdown = () => {
        if (dropdownEl && dropdownEl.parentNode) dropdownEl.parentNode.removeChild(dropdownEl);
        dropdownEl = null;
        currentIndex = -1;
    };

    const buildDropdown = (suggestions) => {
        destroyDropdown();
        if (!suggestions || suggestions.length === 0) return;
        dropdownEl = document.createElement("div");
        dropdownEl.id = `${inputEl.id}-autocomplete`;
        dropdownEl.className = "autocomplete-dropdown";
        inputEl.parentNode.appendChild(dropdownEl);

        suggestions.forEach((tag, i) => {
            const opt = document.createElement("div");
            opt.className = "autocomplete-option";
            opt.textContent = tag;
            opt.addEventListener("mousedown", (e) => {
                e.preventDefault();
                applySelection(tag);
            });
            dropdownEl.appendChild(opt);
        });
        currentIndex = -1;
    };

    const highlight = (idx) => {
        if (!dropdownEl) return;
        const opts = dropdownEl.querySelectorAll(".autocomplete-option");
        opts.forEach(o => o.classList.remove("selected"));
        if (idx >= 0 && opts[idx]) {
            opts[idx].classList.add("selected");
            opts[idx].scrollIntoView({ block: "nearest" });
        }
    };

    const applySelection = (tag) => {
        const parts = inputEl.value.split(",");
        parts[parts.length - 1] = ` ${tag}`;
        inputEl.value = parts.join(",").trim();
        destroyDropdown();
        const ev = new Event("change", { bubbles: true });
        inputEl.dispatchEvent(ev);
    };

    const recompute = () => {
        const raw = inputEl.value.split(",").pop();
        const val = (raw || "").trim().toLowerCase();
        if (!val || availableTags.length === 0) return destroyDropdown();
        const suggestions = availableTags
            .filter(t => typeof t === "string" && t.toLowerCase().startsWith(val))
            .slice(0, 10);
        if (suggestions.length === 0) return destroyDropdown();
        buildDropdown(suggestions);
    };

    inputEl.addEventListener("input", recompute);

    inputEl.addEventListener("keydown", (e) => {
        if (!dropdownEl) return;
        const opts = dropdownEl.querySelectorAll(".autocomplete-option");
        if (opts.length === 0) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            currentIndex = (currentIndex + 1) % opts.length;
            highlight(currentIndex);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            currentIndex = (currentIndex - 1 + opts.length) % opts.length;
            highlight(currentIndex);
        } else if (e.key === "Enter" || e.key === "Tab") {
            if (currentIndex >= 0 && opts[currentIndex]) {
                e.preventDefault();
                applySelection(opts[currentIndex].textContent);
            } else {
                destroyDropdown();
            }
        } else if (e.key === "Escape") {
            e.preventDefault();
            destroyDropdown();
        }
    });

    inputEl.addEventListener("blur", () => {
        setTimeout(() => destroyDropdown(), 100);
    });
}

// ----------------------------- Search / Results -----------------------------
async function fetchCharactersBySearch({ searchTerm, includeTags = [], excludeTags = [], nsfw, sort, page = 1 }) {
    const first = Number(extension_settings?.chub?.findCount ?? defaultSettings.findCount) || defaultSettings.findCount;
    nsfw = nsfw ?? Boolean(extension_settings?.chub?.nsfw);

    const url = new URL(API_ENDPOINT_SEARCH);
    if (searchTerm) url.searchParams.append("search", searchTerm);
    if (includeTags.length) url.searchParams.append("tags", includeTags.join(","));
    if (excludeTags.length) url.searchParams.append("exclude_tags", excludeTags.join(","));
    if (sort) url.searchParams.append("sort", sort);
    url.searchParams.append("page", String(page));
    url.searchParams.append("first", String(first));
    url.searchParams.append("nsfw", String(nsfw));

    try {
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        const nodes = data?.data?.nodes || [];
        chubCharacters = nodes.map(n => ({
            id: n.id,
            name: n.name,
            description: n.tagline || n.description || "No description",
            fullPath: n.fullPath,
            tags: n.topics || [],
            author: (n.fullPath || "").split("/")[0] || "Unknown",
            url: n.avatar_url || "",
            cardUrl: n.max_res_url || "",
        }));
        return chubCharacters;
    } catch (err) {
        console.error("CHub search error:", err);
        return [];
    }
}

async function downloadCharacter(fullPath, cardUrl) {
    try {
        let target = cardUrl && cardUrl.length ? cardUrl : `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`;
        let res = await fetch(target);
        if (!res.ok) {
            const alt = `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`;
            res = await fetch(alt);
        }
        if (!res.ok) throw new Error("Failed to fetch character image");
        const blob = await res.blob();
        const ext = /png/i.test(blob.type) ? "png" : "webp";
        const file = new File([blob], `${fullPath}.${ext}`.replace(/\/+/, "_"), { type: blob.type });
        processDroppedFiles([file]);
    } catch (err) {
        console.error("Download error:", err);
        if (typeof toastr !== "undefined") toastr.error("Character download failed", String(err?.message || err));
    }
}

// ----------------------------- Rendering -----------------------------
function generateCharacterListItem(character, index) {
    const safeTags = Array.isArray(character.tags) ? character.tags : [];
    const fullDesc = character.description || "";
    const shortDesc = fullDesc.length > 180 ? fullDesc.slice(0, 180) + "…" : fullDesc;

    return `
        <div class="character-list-item" data-index="${index}" data-full="${encodeURIComponent(fullDesc)}">
            <img class="thumbnail" src="${character.url || ""}" alt="${character.name || "Character"}">
            <div class="info">
                <a href="https://chub.ai/characters/${character.fullPath}" target="_blank">
                    <div class="name">${character.name || "Unnamed"}</div>
                </a>
                <span class="author">by ${character.author || "Unknown"}</span>
                <div class="description">${shortDesc}</div>
                <div class="tags">${safeTags.map(t => `<span class="tag">${t}</span>`).join("")}</div>
            </div>
            <div class="menu_button download-btn fa-solid fa-cloud-arrow-down faSmallFontSquareFix"
                 data-card-url="${character.cardUrl || ""}"
                 data-path="${character.fullPath}"></div>
        </div>
    `;
}

function attachDescriptionHover() {
    const container = document.querySelector(".character-list-popup");
    if (!container) return;

    let hoverBox = document.querySelector(".char-hover-box");
    if (!hoverBox) {
        hoverBox = document.createElement("div");
        hoverBox.className = "char-hover-box";
        document.body.appendChild(hoverBox);
    }

    container.addEventListener("mouseover", (e) => {
        const card = e.target.closest(".character-list-item");
        if (!card) return;
        const full = decodeURIComponent(card.dataset.full || "");
        if (!full) return;

        hoverBox.textContent = full;
        hoverBox.style.display = "block";
        hoverBox.style.top = `${e.pageY + 12}px`;
        hoverBox.style.left = `${e.pageX + 12}px`;
    });

    container.addEventListener("mousemove", (e) => {
        if (hoverBox.style.display === "block") {
            hoverBox.style.top = `${e.pageY + 12}px`;
            hoverBox.style.left = `${e.pageX + 12}px`;
        }
    });

    container.addEventListener("mouseout", (e) => {
        const card = e.target.closest(".character-list-item");
        if (card) hoverBox.style.display = "none";
    });
}

function updateCharacterListInView(characters) {
    if (characterListContainer) {
        characterListContainer.innerHTML = characters.map(generateCharacterListItem).join("");
        attachDescriptionHover();
    }
}

// ----------------------------- Search Execution -----------------------------
async function searchCharacters(options) {
    if (characterListContainer && !document.body.contains(characterListContainer)) {
        characterListContainer = null;
    }
    if (characterListContainer) characterListContainer.classList.add("searching");
    const characters = await fetchCharactersBySearch(options);
    if (characterListContainer) characterListContainer.classList.remove("searching");
    return characters;
}

async function executeCharacterSearch(options) {
    const characters = await searchCharacters(options);
    if (characterListContainer) {
        if (characters.length > 0) updateCharacterListInView(characters);
        else characterListContainer.innerHTML = '<div class="no-characters-found">No characters found</div>';
    }
}

// ----------------------------- Popup UI -----------------------------
async function displayCharactersInListViewPopup() {
    if (savedPopupContent) {
        callPopup("", "text", "", { okButton: "Close", wide: true, large: true })
            .then(() => { savedPopupContent = document.querySelector('.list-and-search-wrapper'); });
        document.getElementById('dialogue_popup_text').appendChild(savedPopupContent);
        characterListContainer = document.querySelector('.character-list-popup');
        return;
    }

    const readableOptions = {
        download_count: "Download Count",
        rating: "Rating",
        rating_count: "Rating Count",
        last_activity_at: "Last Activity",
        created_at: "Creation Date",
        name: "Name",
        random: "Random",
    };

    const listLayout = `
    <div class="list-and-search-wrapper" id="list-and-search-wrapper">
        <div class="character-list-popup"></div>
        <hr>
        <div class="search-container">
            <div class="flex-container flex-no-wrap flex-align-center">
                <label for="characterSearchInput"><i class="fas fa-search"></i></label>
                <input type="text" id="characterSearchInput" class="text_pole flex1" placeholder="Search CHUB for characters...">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center">
                <label for="includeTags"><i class="fas fa-plus-square"></i></label>
                <input type="text" id="includeTags" class="text_pole flex1" placeholder="Include tags (comma separated)">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center">
                <label for="excludeTags"><i class="fas fa-minus-square"></i></label>
                <input type="text" id="excludeTags" class="text_pole flex1" placeholder="Exclude tags (comma separated)">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center">
                <label for="findCountInput">Results per page:</label>
                <input type="number" id="findCountInput" class="text_pole textarea_compact wide10pMinFit" min="1" value="${(extension_settings?.chub?.findCount ?? defaultSettings.findCount)}">
            </div>
            <div class="page-buttons flex-container flex-no-wrap flex-align-center">
                <div class="flex-container flex-no-wrap flex-align-center">
                    <button class="menu_button" id="pageDownButton"><i class="fas fa-chevron-left"></i></button>
                    <label for="pageNumber">Page:</label>
                    <input type="number" id="pageNumber" class="text_pole textarea_compact wide10pMinFit" min="1" value="1">
                    <button class="menu_button" id="pageUpButton"><i class="fas fa-chevron-right"></i></button>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                    <label for="sortOrder">Sort By:</label>
                    <select class="margin0" id="sortOrder">
                        ${Object.keys(readableOptions).map(k => `<option value="${k}">${readableOptions[k]}</option>`).join("")}
                    </select>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                    <label for="nsfwCheckbox">NSFW:</label>
                    <input type="checkbox" id="nsfwCheckbox" ${extension_settings?.chub?.nsfw ? "checked" : ""}>
                </div>
                <div class="menu_button" id="characterSearchButton">Search</div>
            </div>
        </div>
    </div>`;

    callPopup(listLayout, "text", "", { okButton: "Close", wide: true, large: true })
        .then(() => { savedPopupContent = document.querySelector('.list-and-search-wrapper'); });

    characterListContainer = document.querySelector('.character-list-popup');

    updateCharacterListInView(chubCharacters);

    characterListContainer.addEventListener('click', (event) => {
        if (event.target.classList.contains('download-btn')) {
            const cardUrl = event.target.getAttribute('data-card-url');
            const fullPath = event.target.getAttribute('data-path');
            downloadCharacter(fullPath, cardUrl);
        }
    });

    const executeCharacterSearchDebounced = debounce((options) => executeCharacterSearch(options), 500);

    const handleSearch = (e) => {
        if (!["pageNumber", "pageUpButton", "pageDownButton"].includes(e?.target?.id)) {
            document.getElementById('pageNumber').value = 1;
        }

        const splitAndTrim = (str) => {
            const s = (str || "").trim();
            if (!s) return [];
            return s.split(',').map(t => t.trim()).filter(Boolean);
        };

        const searchTerm = document.getElementById('characterSearchInput').value;
        const includeTags = splitAndTrim(document.getElementById('includeTags').value);
        const excludeTags = splitAndTrim(document.getElementById('excludeTags').value);
        const nsfw = document.getElementById('nsfwCheckbox').checked;
        const sort = document.getElementById('sortOrder').value;
        const page = Number(document.getElementById('pageNumber').value) || 1;
        const findCount = parseInt(document.getElementById('findCountInput').value) || defaultSettings.findCount;
        extension_settings.chub.findCount = findCount;
        extension_settings.chub.nsfw = nsfw;

        executeCharacterSearchDebounced({ searchTerm, includeTags, excludeTags, nsfw, sort, page });
    };

    document.getElementById('characterSearchButton').addEventListener('click', handleSearch);
    document.getElementById('includeTags').addEventListener('keyup', handleSearch);
    document.getElementById('excludeTags').addEventListener('keyup', handleSearch);
    document.getElementById('sortOrder').addEventListener('change', handleSearch);
    document.getElementById('nsfwCheckbox').addEventListener('change', handleSearch);
    document.getElementById('pageNumber').addEventListener('change', handleSearch);
    document.getElementById('findCountInput').addEventListener('change', handleSearch);

    document.getElementById('pageUpButton').addEventListener('click', (e) => {
        const pageNumber = document.getElementById('pageNumber');
        pageNumber.value = Math.max(1, (parseInt(pageNumber.value) || 1) + 1);
        handleSearch(e);
    });
    document.getElementById('pageDownButton').addEventListener('click', (e) => {
        const pageNumber = document.getElementById('pageNumber');
        pageNumber.value = Math.max(1, (parseInt(pageNumber.value) || 1) - 1);
        handleSearch(e);
    });

    await fetchTags();
    enableTagAutocomplete(document.getElementById('includeTags'));
    enableTagAutocomplete(document.getElementById('excludeTags'));
}

function openSearchPopup() { displayCharactersInListViewPopup(); }

// ----------------------------- Entry Point -----------------------------
jQuery(async () => {
    const btnHtml = '<button id="search-chub" class="menu_button fa-solid fa-cloud-bolt faSmallFontSquareFix" title="Search CHub for characters"></button>';
    if (document.getElementById('external_import_button')) {
        jQuery('#external_import_button').after(btnHtml);
    } else {
        jQuery('body').append(btnHtml);
    }
    jQuery('#search-chub').on('click', openSearchPopup);
    await loadSettings();
});

// ----------------------------- Styles -----------------------------
document.head.insertAdjacentHTML("beforeend", `
<style>
.list-and-search-wrapper { max-height: 80vh; display: flex; flex-direction: column; }
.character-list-popup.searching { opacity: 0.5; pointer-events: none; }
.character-list-popup { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.character-list-item { display: grid; grid-template-columns: 84px 1fr 36px; gap: 10px; align-items: start; padding: 8px; border: 1px solid #333; border-radius: 8px; }
.character-list-item .thumbnail { width: 84px; height: 84px; object-fit: cover; border-radius: 6px; }
.character-list-item .info { overflow: hidden; }
.character-list-item .name { font-weight: 700; margin-bottom: 4px; }
.character-list-item .author { opacity: 0.8; font-size: 0.9em; }
.character-list-item .description { margin-top: 6px; font-size: 0.95em; max-height: 3.8em; overflow: hidden; text-overflow: ellipsis; }
.character-list-item .tags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.character-list-item .tag { background: #2b2b2b; border: 1px solid #3a3a3a; border-radius: 12px; padding: 2px 8px; font-size: 0.85em; }
.character-list-item .download-btn { align-self: start; justify-self: end; }

.autocomplete-dropdown { position: absolute; background: #222; border: 1px solid #444; z-index: 10000; max-height: 220px; overflow-y: auto; width: 100%; border-radius: 6px; }
.autocomplete-option { padding: 6px 8px; cursor: pointer; }
.autocomplete-option:hover, .autocomplete-option.selected { background: #555; }

.char-hover-box {
    position: absolute;
    display: none;
    background: #222;
    color: #eee;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 8px;
    font-size: 0.9em;
    line-height: 1.4;
    z-index: 10000;
    max-width: 400px;
    white-space: normal;
    box-shadow: 0 2px 6px rgba(0,0,0,0.5);
}

.search-container .flex-container { gap: 8px; margin-top: 6px; }
.page-buttons { margin-top: 10px; justify-content: space-between; }
</style>
`);
