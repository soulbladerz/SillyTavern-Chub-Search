// An extension that allows you to import characters from CHub (new API)
import {
    getRequestHeaders,
    processDroppedFiles,
    callPopup
} from "../../../../script.js";
import { delay, debounce } from "../../../utils.js";
import { extension_settings } from "../../../extensions.js";

const extensionName = "SillyTavern-Chub-Search";

const API_ENDPOINT_SEARCH = "https://api.chub.ai/search";
const API_ENDPOINT_TAGS = "https://api.chub.ai/tags";

const defaultSettings = {
    findCount: 10,
    nsfw: false,
};

let chubCharacters = [];
let characterListContainer = null;
let popupState = null;
let savedPopupContent = null;
let availableTags = [];

// Load settings
async function loadSettings() {
    if (!extension_settings.chub) {
        extension_settings.chub = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings.chub.hasOwnProperty(key)) {
            extension_settings.chub[key] = value;
        }
    }
}

// Fetch tags for autocomplete
async function fetchTags() {
    try {
        const response = await fetch(API_ENDPOINT_TAGS, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });
        if (!response.ok) throw new Error("Failed to fetch tags");
        const data = await response.json();
        availableTags = data.tags.map(t => t.tag).sort();
    } catch (err) {
        console.error("Error fetching tags:", err);
        availableTags = [];
    }
}

function enableTagAutocomplete(inputElement) {
    inputElement.addEventListener("input", function () {
        const val = this.value.split(",").pop().trim().toLowerCase();
        const suggestions = availableTags.filter(tag => tag.toLowerCase().startsWith(val)).slice(0, 10);

        let dropdown = document.getElementById(this.id + "-autocomplete");
        if (!dropdown) {
            dropdown = document.createElement("div");
            dropdown.id = this.id + "-autocomplete";
            dropdown.className = "autocomplete-dropdown";
            this.parentNode.appendChild(dropdown);
        }
        dropdown.innerHTML = "";

        suggestions.forEach(tag => {
            const option = document.createElement("div");
            option.className = "autocomplete-option";
            option.textContent = tag;
            option.addEventListener("click", () => {
                const parts = this.value.split(",");
                parts[parts.length - 1] = " " + tag;
                this.value = parts.join(",").trim();
                dropdown.innerHTML = "";
            });
            dropdown.appendChild(option);
        });
    });
}

// Fetch characters via /search
async function fetchCharactersBySearch({ searchTerm, includeTags = [], excludeTags = [], nsfw, sort, page = 1 }) {
    let first = extension_settings.chub.findCount;
    nsfw = nsfw ?? extension_settings.chub.nsfw;

    const url = new URL(API_ENDPOINT_SEARCH);
    if (searchTerm) url.searchParams.append("search", searchTerm);
    if (includeTags.length > 0) url.searchParams.append("tags", includeTags.join(","));
    if (excludeTags.length > 0) url.searchParams.append("exclude_tags", excludeTags.join(","));
    if (sort) url.searchParams.append("sort", sort);
    url.searchParams.append("page", page);
    url.searchParams.append("first", first);
    url.searchParams.append("nsfw", nsfw);

    const response = await fetch(url.toString());
    if (!response.ok) {
        console.error("Search failed:", response.status, response.statusText);
        return [];
    }

    const searchData = await response.json();
    if (!searchData.data || !searchData.data.nodes || searchData.data.nodes.length === 0) {
        return [];
    }

    chubCharacters = searchData.data.nodes.map(node => ({
        id: node.id,
        name: node.name,
        description: node.tagline || node.description || "No description",
        fullPath: node.fullPath,
        tags: node.topics || [],
        author: node.fullPath.split('/')[0] || "Unknown",
        url: node.avatar_url || "",
        cardUrl: node.max_res_url || "",
    }));

    return chubCharacters;
}

// Download character card (PNG)
async function downloadCharacter(fullPath, cardUrl) {
    try {
        const response = await fetch(cardUrl);
        if (!response.ok) throw new Error("Failed to fetch card");
        const blob = await response.blob();
        const file = new File([blob], `${fullPath}.png`, { type: blob.type });
        processDroppedFiles([file]);
    } catch (err) {
        toastr.error("Character download failed", err.message);
        console.error("Download error:", err);
    }
}

function updateCharacterListInView(characters) {
    if (characterListContainer) {
        characterListContainer.innerHTML = characters.map(generateCharacterListItem).join('');
    }
}

async function searchCharacters(options) {
    if (characterListContainer && !document.body.contains(characterListContainer)) {
        characterListContainer = null;
    }
    if (characterListContainer) characterListContainer.classList.add('searching');

    const characters = await fetchCharactersBySearch(options);
    if (characterListContainer) characterListContainer.classList.remove('searching');

    return characters;
}

async function executeCharacterSearch(options) {
    const characters = await searchCharacters(options);
    if (characters.length > 0) updateCharacterListInView(characters);
    else characterListContainer.innerHTML = '<div class="no-characters-found">No characters found</div>';
}

function generateCharacterListItem(character, index) {
    return `
        <div class="character-list-item" data-index="${index}">
            <img class="thumbnail" src="${character.url}">
            <div class="info">
                <a href="https://chub.ai/characters/${character.fullPath}" target="_blank">
                    <div class="name">${character.name}</div>
                </a>
                <span class="author">by ${character.author}</span>
                <div class="description">${character.description}</div>
                <div class="tags">${character.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}</div>
            </div>
            <div class="menu_button download-btn fa-solid fa-cloud-arrow-down faSmallFontSquareFix"
                 data-card-url="${character.cardUrl}" 
                 data-path="${character.fullPath}"></div>
        </div>
    `;
}

async function displayCharactersInListViewPopup() {
    if (savedPopupContent) {
        callPopup('', "text", '', { okButton: "Close", wide: true, large: true })
            .then(() => savedPopupContent = document.querySelector('.list-and-search-wrapper'));
        document.getElementById('dialogue_popup_text').appendChild(savedPopupContent);
        characterListContainer = document.querySelector('.character-list-popup');
        return;
    }

    const readableOptions = {
        "download_count": "Download Count",
        "rating": "Rating",
        "rating_count": "Rating Count",
        "last_activity_at": "Last Activity",
        "created_at": "Creation Date",
        "name": "Name",
        "random": "Random"
    };

    const listLayout = `
    <div class="list-and-search-wrapper" id="list-and-search-wrapper">
        <div class="character-list-popup">
            ${chubCharacters.map((character, index) => generateCharacterListItem(character, index)).join('')}
        </div>
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
            <div class="flex-container">
                <label for="excludeTags"><i class="fas fa-minus-square"></i></label>
                <input type="text" id="excludeTags" class="text_pole flex1" placeholder="Exclude tags (comma separated)">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center">
                <label for="findCountInput">Results per page:</label>
                <input type="number" id="findCountInput" class="text_pole textarea_compact wide10pMinFit" min="1" value="${extension_settings.chub.findCount}">
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
                    ${Object.keys(readableOptions).map(key => `<option value="${key}">${readableOptions[key]}</option>`).join('')}
                    </select>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                    <label for="nsfwCheckbox">NSFW:</label>
                    <input type="checkbox" id="nsfwCheckbox">
                </div>
                <div class="menu_button" id="characterSearchButton">Search</div>
            </div>
        </div>
    </div>`;

    callPopup(listLayout, "text", '', { okButton: "Close", wide: true, large: true })
        .then(() => savedPopupContent = document.querySelector('.list-and-search-wrapper'));

    characterListContainer = document.querySelector('.character-list-popup');

    characterListContainer.addEventListener('click', async function (event) {
        if (event.target.classList.contains('download-btn')) {
            const cardUrl = event.target.getAttribute('data-card-url');
            const fullPath = event.target.getAttribute('data-path');
            downloadCharacter(fullPath, cardUrl);
        }
    });

    const executeCharacterSearchDebounced = debounce((options) => executeCharacterSearch(options), 750);

    const handleSearch = function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.target.id !== 'includeTags' && e.target.id !== 'excludeTags') return;
        const splitAndTrim = str => str.trim() ? str.split(',').map(tag => tag.trim()) : [];

        const searchTerm = document.getElementById('characterSearchInput').value;
        const includeTags = splitAndTrim(document.getElementById('includeTags').value);
        const excludeTags = splitAndTrim(document.getElementById('excludeTags').value);
        const nsfw = document.getElementById('nsfwCheckbox').checked;
        const sort = document.getElementById('sortOrder').value;
        let page = document.getElementById('pageNumber').value;
        const findCount = parseInt(document.getElementById('findCountInput').value) || defaultSettings.findCount;

        extension_settings.chub.findCount = findCount;

        if (!["pageNumber", "pageUpButton", "pageDownButton"].includes(e.target.id)) {
            page = 1;
            document.getElementById('pageNumber').value = 1;
        }

        executeCharacterSearchDebounced({ searchTerm, includeTags, excludeTags, nsfw, sort, page });
    };

    document.getElementById('characterSearchButton').addEventListener('click', handleSearch);
    document.getElementById('includeTags').addEventListener('keyup', handleSearch);
    document.getElementById('excludeTags').addEventListener('keyup', handleSearch);
    document.getElementById('sortOrder').addEventListener('change', handleSearch);
    document.getElementById('nsfwCheckbox').addEventListener('change', handleSearch);
    document.getElementById('pageNumber').addEventListener('change', handleSearch);
    document.getElementById('findCountInput').addEventListener('change', handleSearch);

    document.getElementById('pageUpButton').addEventListener('click', e => {
        let pageNumber = document.getElementById('pageNumber');
        pageNumber.value = Math.max(1, parseInt(pageNumber.value) + 1);
        handleSearch(e);
    });
    document.getElementById('pageDownButton').addEventListener('click', e => {
        let pageNumber = document.getElementById('pageNumber');
        pageNumber.value = Math.max(1, parseInt(pageNumber.value) - 1);
        handleSearch(e);
    });

    await fetchTags();
    enableTagAutocomplete(document.getElementById("includeTags"));
    enableTagAutocomplete(document.getElementById("excludeTags"));
}

function openSearchPopup() { displayCharactersInListViewPopup(); }

// Entry point
jQuery(async () => {
    $("#external_import_button").after('<button id="search-chub" class="menu_button fa-solid fa-cloud-bolt faSmallFontSquareFix" title="Search CHub for characters"></button>');
    $("#search-chub").on("click", openSearchPopup);
    loadSettings();
});

// Add CSS for autocomplete dropdown
document.head.insertAdjacentHTML("beforeend", `
<style>
.autocomplete-dropdown {
    position: absolute;
    background: #222;
    border: 1px solid #444;
    z-index: 10000;
    max-height: 200px;
    overflow-y: auto;
    width: 100%;
}
.autocomplete-option {
    padding: 4px 8px;
    cursor: pointer;
}
.autocomplete-option:hover {
    background: #555;
}
</style>`);
