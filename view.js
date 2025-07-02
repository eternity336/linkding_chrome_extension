document.addEventListener('DOMContentLoaded', () => {
    const bookmarksList = document.getElementById('bookmarks-list');
    const loadingMessage = document.getElementById('loading-message');
    const errorMessage = document.getElementById('error-message');
    const searchBox = document.getElementById('search-box');
    const addTabBtn = document.getElementById('add-tab-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const addStatus = document.getElementById('add-status');
    const openManagerBtn = document.getElementById('open-manager-btn');

    let allBookmarksFlat = [];
    let allBookmarksByTag = {};
    let allTags = [];
    let config = {};

    function showError(message, showOptionsLink = false) {
        loadingMessage.classList.add('hidden');
        if (showOptionsLink) {
            const optionsUrl = chrome.runtime.getURL('options.html');
            errorMessage.innerHTML = `${message} Please <a href="${optionsUrl}" target="_blank">configure the extension</a>.`;
            // Add event listener to open options page
            errorMessage.querySelector('a').addEventListener('click', (e) => {
                e.preventDefault();
                chrome.runtime.openOptionsPage();
            });
        } else {
            errorMessage.textContent = message;
        }
        errorMessage.classList.remove('hidden');
    }

    // --- API Functions ---
    async function apiRequest(endpoint, options = {}) {
        const response = await fetch(`${config.cleanedUrl}${endpoint}`, {
            ...options,
            headers: {
                'Authorization': `Token ${config.apiToken}`,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
        }
        if (response.status === 204) return null; // No Content for DELETE
        return response.json();
    }

    async function updateBookmark(bookmarkId, data) {
        return apiRequest(`/api/bookmarks/${bookmarkId}/`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }

    async function deleteBookmark(bookmarkId) {
        return apiRequest(`/api/bookmarks/${bookmarkId}/`, { method: 'DELETE' });
    }

    async function createBookmark(data) {
        return apiRequest(`/api/bookmarks/`, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    // --- Update & Sync Logic ---
    async function invalidatePopupCache() {
        await chrome.storage.local.remove(['cachedBookmarks', 'cacheTimestamp']);
    }

    // --- DOM & Rendering ---
    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        const p = document.createElement('p');
        p.textContent = str;
        return p.innerHTML;
    }

    function createTagAutocomplete(input, container) {
        const suggestionsDiv = document.createElement('div');
        suggestionsDiv.className = 'tag-suggestions hidden';
        container.appendChild(suggestionsDiv);

        input.addEventListener('input', () => {
            const terms = input.value.split(',').map(t => t.trim());
            const currentTerm = terms[terms.length - 1].toLowerCase();

            if (!currentTerm) {
                suggestionsDiv.classList.add('hidden');
                return;
            }

            const filteredTags = allTags.filter(tag => tag.toLowerCase().startsWith(currentTerm) && !terms.includes(tag));
            suggestionsDiv.innerHTML = '';

            if (filteredTags.length > 0) {
                suggestionsDiv.classList.remove('hidden');
                filteredTags.forEach(tag => {
                    const item = document.createElement('div');
                    item.className = 'tag-suggestion-item';
                    item.textContent = tag;
                    item.addEventListener('click', () => {
                        terms[terms.length - 1] = tag;
                        input.value = terms.join(', ') + ', ';
                        suggestionsDiv.classList.add('hidden');
                        input.focus();
                    });
                    suggestionsDiv.appendChild(item);
                });
            } else {
                suggestionsDiv.classList.add('hidden');
            }
        });
    }

    function createEditForm(bookmark, li, sourceTag) {
        const form = document.createElement('form');
        form.className = 'edit-form';
        form.innerHTML = `
            <div><label>Title</label><input name="title" value="${escapeHTML(bookmark.title || bookmark.website_title || '')}"></div>
            <div><label>URL</label><input name="url" value="${escapeHTML(bookmark.url)}"></div>
            <div><label>Description</label><textarea name="description" rows="3">${escapeHTML(bookmark.description || '')}</textarea></div>
            <div class="tag-input-container"><label>Tags (comma-separated)</label><input name="tags" value="${escapeHTML(bookmark.tag_names.join(', '))}, " autocomplete="off"></div>
            <div class="edit-form-actions">
                <button type="submit" class="save-btn">Save</button>
                <button type="button" class="cancel-btn">Cancel</button>
            </div>
        `;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(form);
            const updatedData = {
                ...bookmark,
                url: formData.get('url'),
                title: formData.get('title'),
                description: formData.get('description'),
                tag_names: formData.get('tags').split(',').map(t => t.trim()).filter(Boolean),
            };
            try {
                const updatedBookmark = await updateBookmark(bookmark.id, updatedData);
                const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                reRenderUI();
                await invalidatePopupCache();
            } catch (error) {
                alert(`An error occurred: ${error.message}`);
            }
        });

        form.querySelector('.cancel-btn').addEventListener('click', () => {
            const newLi = createBookmarkElement(bookmark, sourceTag);
            li.parentNode.replaceChild(newLi, li);
        });

        li.innerHTML = '';
        li.appendChild(form);
        createTagAutocomplete(form.querySelector('input[name="tags"]'), form.querySelector('.tag-input-container'));
    }

    function createBookmarkElement(bookmark, sourceTag) {
        const li = document.createElement('li');
        li.dataset.bookmarkId = bookmark.id;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'bookmark-content';

        const infoDiv = document.createElement('div');
        infoDiv.className = 'bookmark-info';

        const a = document.createElement('a');
        a.href = bookmark.url;
        a.target = '_blank';

        const title = bookmark.title || bookmark.website_title || 'No Title';
        a.textContent = title;

        let tooltip = `${title}\n${bookmark.url}`;
        if (bookmark.description) {
            tooltip += `\n\n---\n${bookmark.description}`;
        }
        a.title = tooltip;
        infoDiv.appendChild(a);

        contentDiv.appendChild(infoDiv);

        if (config.showTags) {
            const tagsDiv = document.createElement('div');
            tagsDiv.className = 'bookmark-tags';
            if (bookmark.tag_names.length > 0) {
                bookmark.tag_names.forEach(tagName => {
                    const tagItem = document.createElement('span');
                    tagItem.className = 'tag-item';
                    tagItem.textContent = tagName;

                    if (config.showActions) {
                        const removeBtn = document.createElement('button');
                        removeBtn.className = 'remove-tag-btn';
                        removeBtn.innerHTML = '&times;';
                        removeBtn.title = `Remove tag: ${tagName}`;
                        removeBtn.addEventListener('click', async () => {
                            const updatedTags = bookmark.tag_names.filter(t => t !== tagName);
                            try {
                                const updatedBookmark = await updateBookmark(bookmark.id, { ...bookmark, tag_names: updatedTags });
                                const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                                if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                                reRenderUI();
                                await invalidatePopupCache();
                            } catch (error) {
                                alert(`An error occurred: ${error.message}`);
                            }
                        });
                        tagItem.appendChild(removeBtn);
                    }
                    tagsDiv.appendChild(tagItem);
                });
            }
            contentDiv.appendChild(tagsDiv);
        }

        li.appendChild(contentDiv);

        if (config.showActions) {
            li.draggable = true;

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'bookmark-actions';

            const editBtn = document.createElement('button');
            editBtn.title = 'Edit';
            editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
            editBtn.addEventListener('click', () => {
                createEditForm(bookmark, li, sourceTag);
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.title = 'Delete';
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
            deleteBtn.addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete "${title}"?`)) {
                    try {
                        await deleteBookmark(bookmark.id);
                        allBookmarksFlat = allBookmarksFlat.filter(b => b.id !== bookmark.id);
                        reRenderUI();
                        await invalidatePopupCache();
                    } catch (error) {
                        alert(`An error occurred: ${error.message}`);
                    }
                }
            });

            actionsDiv.appendChild(editBtn);
            actionsDiv.appendChild(deleteBtn);
            li.appendChild(actionsDiv);

            li.addEventListener('dragstart', (e) => {
                const payload = { id: bookmark.id, sourceTag: sourceTag };
                e.dataTransfer.setData('application/json', JSON.stringify(payload));
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => li.classList.add('dragging'), 0);
            });

            li.addEventListener('dragend', () => {
                li.classList.remove('dragging');
            });
        }
        return li;
    }

    function renderFoldersAndBookmarks(bookmarksByTag) {
        bookmarksList.innerHTML = ''; // Clear previous content
        if (Object.keys(bookmarksByTag).length === 0) {
            bookmarksList.innerHTML = '<p class="empty-state">No bookmarks found.</p>';
            return;
        }

        const tagTree = buildTagTree(Object.keys(bookmarksByTag));
        renderFolderTree(tagTree, bookmarksList, bookmarksByTag);
    }

    function buildTagTree(tags) {
        const tree = {};
        tags.forEach(tag => {
            let currentNode = tree;
            const parts = tag.split('.');
            parts.forEach((part, index) => {
                if (!currentNode[part]) {
                    currentNode[part] = { __children: {} };
                }
                if (index === parts.length - 1) {
                    currentNode[part].__isTag = true;
                    currentNode[part].__fullName = tag;
                }
                currentNode = currentNode[part].__children;
            });
        });
        return tree;
    }

    function renderFolderTree(node, container, bookmarksByTag, path = []) {
        const sortedKeys = Object.keys(node).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        for (const key of sortedKeys) {
            const currentPath = [...path, key];
            const tagNode = node[key];
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';
            const potentialTagName = currentPath.join('.');
            folderItem.dataset.tag = potentialTagName;

            const folderLabel = document.createElement('div');
            folderLabel.className = 'folder-label';

            if (config.showActions) {
                folderLabel.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    folderItem.classList.add('drag-over');
                    e.dataTransfer.dropEffect = 'move';
                });

                folderLabel.addEventListener('dragleave', () => {
                    folderItem.classList.remove('drag-over');
                });

                folderLabel.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    folderItem.classList.remove('drag-over');

                    const payload = JSON.parse(e.dataTransfer.getData('application/json'));
                    const bookmarkId = payload.id;
                    const sourceTag = payload.sourceTag;
                    const targetTag = folderItem.dataset.tag;

                    if (!targetTag || sourceTag === targetTag) {
                        return; // Don't drop on itself or invalid target
                    }

                    const bookmarkToMove = allBookmarksFlat.find(b => b.id === bookmarkId);
                    if (!bookmarkToMove) return;

                    const newTags = bookmarkToMove.tag_names.filter(t => t !== sourceTag);
                    if (!newTags.includes(targetTag)) {
                        newTags.push(targetTag);
                    }

                    const updatedBookmark = await updateBookmark(bookmarkId, { ...bookmarkToMove, tag_names: newTags });
                    const index = allBookmarksFlat.findIndex(b => b.id === bookmarkId);
                    if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                    reRenderUI();
                    await invalidatePopupCache();
                });
            }

            const hasChildren = Object.keys(tagNode.__children).length > 0;

            if (hasChildren) {
                const toggle = document.createElement('span');
                toggle.className = 'folder-toggle';
                folderLabel.appendChild(toggle);
            }

            const folderName = document.createElement('span');
            folderName.className = 'folder-name';
            folderName.textContent = key;
            folderLabel.appendChild(folderName);
            folderItem.appendChild(folderLabel);

            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'folder-children';

            if (hasChildren) {
                renderFolderTree(tagNode.__children, childrenContainer, bookmarksByTag, currentPath);
            }

            if (tagNode.__isTag) {
                const bookmarks = bookmarksByTag[tagNode.__fullName] || [];
                const ul = document.createElement('ul');
                bookmarks.forEach(bookmark => ul.appendChild(createBookmarkElement(bookmark, tagNode.__fullName)));
                const folderContent = document.createElement('div');
                folderContent.className = 'folder-content';
                folderContent.appendChild(ul);
                childrenContainer.appendChild(folderContent);
            }

            folderItem.appendChild(childrenContainer);
            folderLabel.addEventListener('click', () => folderItem.classList.toggle('open'));
            container.appendChild(folderItem);
        }
    }

    async function fetchAllBookmarks(url, token) {
        let bookmarks = [];
        let nextUrl = `${url}/api/bookmarks/?limit=100`;

        while (nextUrl) {
            const response = await fetch(nextUrl, {
                headers: { 'Authorization': `Token ${token}` }
            });

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }
            const data = await response.json();
            bookmarks.push(...data.results);
            nextUrl = data.next;
        }
        return bookmarks;
    }

    function groupBookmarksByTag(bookmarks) {
        const bookmarksByTag = {};
        bookmarks.forEach(bookmark => {
            const tags = bookmark.tag_names.length > 0 ? bookmark.tag_names : ['[Untagged]'];
            tags.forEach(tag => {
                if (!bookmarksByTag[tag]) bookmarksByTag[tag] = [];
                bookmarksByTag[tag].push(bookmark);
            });
        });
        return bookmarksByTag;
    }

    function filterAndRender(searchTerm) {
        const lowerCaseSearchTerm = searchTerm.toLowerCase().trim();
        if (!lowerCaseSearchTerm) {
            renderFoldersAndBookmarks(allBookmarksByTag);
            return;
        }

        const filteredBookmarksByTag = {};
        for (const tag in allBookmarksByTag) {
            const matchingBookmarks = allBookmarksByTag[tag].filter(b =>
                (b.title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (b.website_title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (b.description?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (b.url?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                b.tag_names.some(t => t.toLowerCase().includes(lowerCaseSearchTerm))
            );
            if (matchingBookmarks.length > 0) {
                filteredBookmarksByTag[tag] = matchingBookmarks;
            }
        }
        renderFoldersAndBookmarks(filteredBookmarksByTag);
        // When searching, all folders should be open by default to show results
        document.querySelectorAll('.folder-item').forEach(folder => folder.classList.add('open'));
    }

    function reRenderUI() {
        // 1. Preserve the open/closed state of folders before re-rendering
        const openFolderTags = new Set();
        document.querySelectorAll('#bookmarks-container .folder-item.open').forEach(folder => {
            if (folder.dataset.tag) {
                openFolderTags.add(folder.dataset.tag);
            }
        });

        // 2. Re-calculate derived data from the master list
        allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
        allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();

        // 3. Render the entire folder tree
        renderFoldersAndBookmarks(allBookmarksByTag);

        // 4. Now that the folders are in the DOM, restore their open state.
        if (openFolderTags.size > 0) {
            openFolderTags.forEach(tag => {
                // This logic ensures parent folders are also opened.
                const parts = tag.split('.');
                let currentPath = '';
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}.${part}` : part;
                    const folderToOpen = document.querySelector(`#bookmarks-container .folder-item[data-tag="${currentPath}"]`);
                    if (folderToOpen) folderToOpen.classList.add('open');
                });
            });
        }
    }

    function showAddStatus(message, isError = false) {
        addStatus.textContent = message;
        addStatus.className = isError ? 'error' : 'success';
        addStatus.classList.remove('hidden');
        setTimeout(() => {
            addStatus.classList.add('hidden');
        }, 3000);
    }

    async function addCurrentTab() {
        addTabBtn.disabled = true;
        refreshBtn.disabled = true;
        try {
            if (!config.linkdingUrl || !config.apiToken) {
                showError('Cannot add bookmark. Please configure the extension first.', true);
                return;
            }

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url || tab.url.startsWith('chrome://')) {
                showAddStatus('Cannot bookmark special browser pages.', true);
                return;
            }

            const newBookmark = await createBookmark({ url: tab.url, title: tab.title });

            allBookmarksFlat.push(newBookmark);
            reRenderUI();
            await invalidatePopupCache();

            showAddStatus('Bookmark added successfully!');
        } catch (error) {
            showAddStatus(`Error: ${error.message}`, true);
        } finally {
            addTabBtn.disabled = false;
            refreshBtn.disabled = false;
        }
    }

    async function loadData(isForcedRefresh = false) {
        loadingMessage.classList.remove('hidden');
        bookmarksList.innerHTML = '';
        errorMessage.classList.add('hidden');
        if (isForcedRefresh) {
            refreshBtn.disabled = true;
        }

        try {
            const isSidePanel = window.location.pathname.includes('side_panel.html');

            const settings = await chrome.storage.sync.get({
                linkdingUrl: '',
                apiToken: '',
                showTags: true,
                showActions: true,
                sidePanelShowTags: true,
                sidePanelShowActions: true
            });
            if (!settings.linkdingUrl || !settings.apiToken) {
                showError('Linkding URL or API Token not set.', true);
                return;
            }

            config = {
                linkdingUrl: settings.linkdingUrl,
                apiToken: settings.apiToken,
                cleanedUrl: settings.linkdingUrl.trim().replace(/\/$/, ''),
                showTags: isSidePanel ? settings.sidePanelShowTags : settings.showTags,
                showActions: isSidePanel ? settings.sidePanelShowActions : settings.showActions
            };

            const CACHE_DURATION_MINUTES = 15;
            const cache = await chrome.storage.local.get(['cachedBookmarks', 'cacheTimestamp']);
            const now = new Date().getTime();
            const isCacheValid = cache.cachedBookmarks && cache.cacheTimestamp && (now - cache.cacheTimestamp < CACHE_DURATION_MINUTES * 60 * 1000);

            if (isForcedRefresh || !isCacheValid) {
                allBookmarksFlat = await fetchAllBookmarks(config.cleanedUrl, config.apiToken);
                await chrome.storage.local.set({
                    cachedBookmarks: allBookmarksFlat,
                    cacheTimestamp: new Date().getTime()
                });
            } else {
                allBookmarksFlat = cache.cachedBookmarks;
            }

            reRenderUI();
        } catch (error) {
            console.error('Error fetching bookmarks:', error);
            showError(`Failed to load bookmarks. Error: ${error.message}`);
        } finally {
            loadingMessage.classList.add('hidden');
            if (isForcedRefresh) {
                refreshBtn.disabled = false;
            }
        }
    }

    // Main logic to initialize the popup
    async function init() {
        searchBox.addEventListener('input', (e) => filterAndRender(e.target.value));
        addTabBtn.addEventListener('click', addCurrentTab);
        refreshBtn.addEventListener('click', () => loadData(true));
        openManagerBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'manager.html' });
        });

        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'sync') {
                const uiKeys = ['showTags', 'showActions', 'sidePanelShowTags', 'sidePanelShowActions'];
                const changedKeys = Object.keys(changes);
                const hasUiChange = changedKeys.some(key => uiKeys.includes(key));

                if (hasUiChange) {
                    // A relevant UI setting changed, force a reload of the data and view
                    loadData(true);
                }
            }
        });

        await loadData(false);
    }
    init();
});