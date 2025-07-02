document.addEventListener('DOMContentLoaded', () => {
    const loadingMessage = document.getElementById('loading-message');
    const bookmarksList = document.getElementById('bookmarks-list');
    const folderListContainer = document.getElementById('folder-list-container');
    const errorMessage = document.getElementById('error-message');
    const searchBox = document.getElementById('search-box');
    const refreshBtn = document.getElementById('refresh-btn');

    let allBookmarksByTag = {};
    let tagTree = {};
    let allBookmarksFlat = [];
    let allTags = [];
    let config = {};
    let currentTag = null;
    let contextMenu = null;

    function showError(message, showOptionsLink = false) {
        loadingMessage.classList.add('hidden');
        if (showOptionsLink) {
            const optionsUrl = chrome.runtime.getURL('options.html');
            errorMessage.innerHTML = `${message} Please <a href="${optionsUrl}" target="_blank">configure the extension</a>.`;
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

    // --- DOM & Rendering ---

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

    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        const p = document.createElement('p');
        p.textContent = str;
        return p.innerHTML;
    }

    function createEditForm(bookmark, li) {
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
                ...bookmark, // Preserve other fields like is_archived
                url: formData.get('url'),
                title: formData.get('title'),
                description: formData.get('description'),
                tag_names: formData.get('tags').split(',').map(t => t.trim()).filter(Boolean),
            };
            try {
                const updatedBookmark = await updateBookmark(bookmark.id, updatedData);
                await invalidatePopupCache();

                const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
                allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();

                reRenderUI();
            } catch (error) {
                alert(`An error occurred: ${error.message}`);
            }
        });

        form.querySelector('.cancel-btn').addEventListener('click', () => {
            renderBookmarksForTag(currentTag);
        });

        li.innerHTML = ''; // Clear the list item
        li.appendChild(form); // And add the form
        createTagAutocomplete(form.querySelector('input[name="tags"]'), form.querySelector('.tag-input-container'));
    }

    function createContextMenu() {
        if (contextMenu) document.body.removeChild(contextMenu);

        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu hidden';
        document.body.appendChild(contextMenu);

        document.addEventListener('click', () => {
            contextMenu.classList.add('hidden');
        });
    }

    async function handleAddFolder(parentTag) {
        const newFolderName = prompt(`Enter new folder name inside "${parentTag}":`);
        if (!newFolderName || !newFolderName.trim()) return;
        if (newFolderName.includes('.')) {
            alert('Folder names cannot contain periods.');
            return;
        }

        const newTagName = parentTag === '[Untagged]' ? newFolderName.trim() : `${parentTag}.${newFolderName.trim()}`;

        if (allBookmarksByTag[newTagName]) {
            alert(`Folder "${newTagName}" already exists.`);
            return;
        }

        // Add to local state and re-render to show immediately.
        // The tag becomes permanent when a bookmark is moved to it.
        allBookmarksByTag[newTagName] = [];
        renderFolders();
    }

    async function handleRenameFolder(fullTag, oldName) {
        const newName = prompt(`Rename "${oldName}" to:`, oldName);
        if (!newName || !newName.trim() || newName === oldName) return;
        if (newName.includes('.')) {
            alert('Folder names cannot contain periods.');
            return;
        }

        const parentPath = fullTag.substring(0, fullTag.lastIndexOf('.'));
        const newFullTag = parentPath ? `${parentPath}.${newName.trim()}` : newName.trim();

        const bookmarksToUpdate = allBookmarksFlat.filter(b => b.tag_names.some(t => t.startsWith(fullTag)));

        if (bookmarksToUpdate.length === 0) {
            allBookmarksByTag[newFullTag] = allBookmarksByTag[fullTag];
            delete allBookmarksByTag[fullTag];
            renderFolders();
            return;
        }

        const updatePromises = bookmarksToUpdate.map(bookmark => {
            const updatedTags = bookmark.tag_names.map(tag => tag.startsWith(fullTag) ? newFullTag + tag.substring(fullTag.length) : tag);
            return updateBookmark(bookmark.id, { ...bookmark, tag_names: [...new Set(updatedTags)] });
        });

        try {
            await Promise.all(updatePromises);
            await invalidatePopupCache();
            await loadData(true);
        } catch (error) {
            alert(`An error occurred: ${error.message}`);
        }
    }

    async function handleRemoveFolder(fullTag) {
        const bookmarksToUpdate = allBookmarksFlat.filter(b => b.tag_names.some(t => t.startsWith(fullTag)));
        const confirmation = confirm(`Are you sure you want to remove the "${fullTag}" folder and all its sub-folders? This will remove the tag(s) from ${bookmarksToUpdate.length} bookmark(s). This cannot be undone.`);

        if (!confirmation) return;

        if (bookmarksToUpdate.length === 0) {
            delete allBookmarksByTag[fullTag];
            renderFolders();
            return;
        }

        const updatePromises = bookmarksToUpdate.map(bookmark => {
            const updatedTags = bookmark.tag_names.filter(tag => !tag.startsWith(fullTag));
            return updateBookmark(bookmark.id, { ...bookmark, tag_names: updatedTags });
        });

        try {
            await Promise.all(updatePromises);
            await invalidatePopupCache();
            await loadData(true);
        } catch (error) {
            alert(`An error occurred: ${error.message}`);
        }
    }

    async function handleDrop(e) {
        e.preventDefault();
        const folderItem = e.currentTarget;
        folderItem.classList.remove('drag-over');

        const payload = JSON.parse(e.dataTransfer.getData('application/json'));
        const bookmarkId = payload.id;
        const sourceTag = payload.sourceTag;
        const newTag = folderItem.dataset.tag;

        if (sourceTag === newTag) return;

        const bookmark = allBookmarksFlat.find(b => b.id === bookmarkId);
        if (!bookmark) return;

        let newTags = bookmark.tag_names.filter(t => t !== sourceTag && t !== '[Untagged]');
        if (newTag !== '[Untagged]') {
            newTags.push(newTag);
        }
        const updatedData = { ...bookmark, tag_names: [...new Set(newTags)] };

        try {
            const updatedBookmark = await updateBookmark(bookmark.id, updatedData);
            await invalidatePopupCache();

            const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
            if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
            allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);

            reRenderUI();
        } catch (error) {
            alert(`An error occurred: ${error.message}`);
        }
    }

    function createBookmarkElement(bookmark, sourceTag) {
        const li = document.createElement('li');
        li.dataset.bookmarkId = bookmark.id;
        li.draggable = true;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'bookmark-info';

        const a = document.createElement('a');
        a.href = bookmark.url;
        a.target = '_blank';
        a.className = 'bookmark-title';

        const title = bookmark.title || bookmark.website_title || 'No Title';
        a.textContent = title;

        let tooltip = `${title}\n${bookmark.url}`;
        if (bookmark.description) {
            tooltip += `\n\n---\n${bookmark.description}`;
        }
        a.title = tooltip;

        const urlSpan = document.createElement('span');
        urlSpan.className = 'bookmark-url';
        urlSpan.textContent = bookmark.url;

        infoDiv.appendChild(a);
        infoDiv.appendChild(urlSpan);

        const tagsDiv = document.createElement('div');
        tagsDiv.className = 'bookmark-tags';

        if (bookmark.tag_names.length > 0) {
            bookmark.tag_names.forEach(tagName => {
                const tagItem = document.createElement('span');
                tagItem.className = 'tag-item';
                tagItem.textContent = tagName;

                const removeBtn = document.createElement('button');
                removeBtn.className = 'remove-tag-btn';
                removeBtn.innerHTML = '&times;';
                removeBtn.title = `Remove tag: ${tagName}`;
                removeBtn.addEventListener('click', async () => {
                    const updatedTags = bookmark.tag_names.filter(t => t !== tagName);
                    try {
                        const updatedBookmark = await updateBookmark(bookmark.id, { ...bookmark, tag_names: updatedTags });
                        await invalidatePopupCache();

                        const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                        if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                        allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);

                        reRenderUI();
                    } catch (error) {
                        alert(`An error occurred: ${error.message}`);
                    }
                });

                tagItem.appendChild(removeBtn);
                tagsDiv.appendChild(tagItem);
            });
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'bookmark-actions';

        const editBtn = document.createElement('button');
        editBtn.title = 'Edit';
        editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
        editBtn.addEventListener('click', () => {
            li.draggable = false;
            createEditForm(bookmark, li);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.title = 'Delete';
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
        deleteBtn.addEventListener('click', async () => {
            if (confirm(`Are you sure you want to delete "${title}"?`)) {
                try {
                    await deleteBookmark(bookmark.id);
                    await invalidatePopupCache();
                    allBookmarksFlat = allBookmarksFlat.filter(b => b.id !== bookmark.id);
                    allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
                    allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();
                    reRenderUI();
                } catch (error) {
                    alert(`An error occurred: ${error.message}`);
                }
            }
        });

        li.addEventListener('dragstart', (e) => {
            // We need to pass both the bookmark ID and its original tag
            const payload = { id: bookmark.id, sourceTag: sourceTag };
            e.dataTransfer.setData('application/json', JSON.stringify(payload));
            e.dataTransfer.effectAllowed = 'move';
            // Use a timeout to allow the browser to render the drag image before we apply the class
            setTimeout(() => li.classList.add('dragging'), 0);
        });

        li.addEventListener('dragend', () => li.classList.remove('dragging'));


        actionsDiv.appendChild(editBtn);
        actionsDiv.appendChild(deleteBtn);
        li.appendChild(infoDiv);
        li.appendChild(tagsDiv);
        li.appendChild(actionsDiv);

        return li;
    }

    // --- Cache Invalidation ---
    async function invalidatePopupCache() {
        await chrome.storage.local.remove(['cachedBookmarks', 'cacheTimestamp']);
    }

    function reRenderUI() {
        // Preserve the open/closed state of folders before re-rendering
        const openFolderTags = new Set();
        document.querySelectorAll('#folder-pane .folder-item.open').forEach(folder => {
            if (folder.dataset.tag) {
                openFolderTags.add(folder.dataset.tag);
            }
        });

        // 1. Render the folder structure first.
        renderFolders();

        // 2. Now that the folders are in the DOM, restore their open state.
        if (openFolderTags.size > 0) {
            openFolderTags.forEach(tag => {
                const parts = tag.split('.');
                let currentPath = '';
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}.${part}` : part;
                    const folderToOpen = document.querySelector(`.folder-item[data-tag="${currentPath}"]`);
                    if (folderToOpen) {
                        folderToOpen.classList.add('open');
                    }
                });
            });
        }

        // 3. Finally, render the bookmarks for the active folder.
        // If the current tag was removed or renamed, it might not exist anymore.
        if (!allBookmarksByTag[currentTag]) {
            currentTag = Object.keys(allBookmarksByTag)[0] || null;
        }
        renderBookmarksForTag(currentTag);
    }

    function renderBookmarksForTag(tag, bookmarksToRender) {
        // If searching, bookmarksToRender is provided. Otherwise, use the global map.
        const bookmarks = bookmarksToRender || allBookmarksByTag[tag] || [];

        // Only update active state if not searching
        if (!bookmarksToRender) {
            currentTag = tag;
            document.querySelectorAll('.folder-item').forEach(item => {
                item.classList.toggle('active', item.dataset.tag === tag);
            });
        }

        bookmarks.sort((a, b) => {
            const titleA = (a.title || a.website_title || '').toLowerCase();
            const titleB = (b.title || b.website_title || '').toLowerCase();
            return titleA.localeCompare(titleB);
        });

        bookmarksList.innerHTML = '';
        bookmarksList.classList.remove('hidden');
        loadingMessage.classList.add('hidden');

        if (!tag) {
            bookmarksList.innerHTML = '<p class="empty-state">Select a folder to view bookmarks.</p>';
            return;
        }
        if (bookmarks.length === 0 && !bookmarksToRender) { // Don't show for empty search results
            bookmarksList.innerHTML = '<p class="empty-state">No bookmarks found.</p>';
            return;
        }

        const ul = document.createElement('ul');
        bookmarks.forEach(bookmark => ul.appendChild(createBookmarkElement(bookmark, tag)));
        bookmarksList.appendChild(ul);
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
                // If it's the last part, this node represents a real tag
                if (index === parts.length - 1) {
                    currentNode[part].__isTag = true;
                    currentNode[part].__fullName = tag;
                }
                currentNode = currentNode[part].__children;
            });
        });
        return tree;
    }

    function renderFolderTree(node, container, path = []) {
        const sortedKeys = Object.keys(node).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        for (const key of sortedKeys) {
            const currentPath = [...path, key];
            const tagNode = node[key];
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';

            // Every folder is a potential drop target. The tag is its full path.
            const potentialTagName = currentPath.join('.');
            folderItem.dataset.tag = potentialTagName;
            folderItem.addEventListener('dragover', (e) => { e.preventDefault(); folderItem.classList.add('drag-over'); });
            folderItem.addEventListener('dragleave', () => { folderItem.classList.remove('drag-over'); });
            folderItem.addEventListener('drop', handleDrop);

            const folderLabel = document.createElement('div');
            folderLabel.className = 'folder-label';

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

            folderLabel.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const isUntagged = potentialTagName === '[Untagged]';

                contextMenu.innerHTML = `
                    <div class="context-menu-item" data-action="add">New Sub-folder...</div>
                    <div class="context-menu-item ${isUntagged ? 'disabled' : ''}" data-action="rename">Rename...</div>
                    <div class="context-menu-item ${isUntagged ? 'disabled' : ''}" data-action="remove">Remove</div>
                `;

                contextMenu.style.top = `${e.pageY}px`;
                contextMenu.style.left = `${e.pageX}px`;
                contextMenu.classList.remove('hidden');

                contextMenu.querySelector('[data-action="add"]').addEventListener('click', () => handleAddFolder(potentialTagName));
                if (!isUntagged) {
                    contextMenu.querySelector('[data-action="rename"]').addEventListener('click', () => handleRenameFolder(potentialTagName, key));
                    contextMenu.querySelector('[data-action="remove"]').addEventListener('click', () => handleRemoveFolder(potentialTagName));
                }
            });

            folderItem.appendChild(folderLabel);

            let childrenContainer;
            if (hasChildren) {
                childrenContainer = document.createElement('div');
                childrenContainer.className = 'folder-children';
                renderFolderTree(tagNode.__children, childrenContainer, currentPath);
                folderItem.appendChild(childrenContainer);
            }

            // A single, unified click listener on the entire label.
            folderLabel.addEventListener('click', () => {
                // Action 1: Select the folder to display its bookmarks, but only if it's a real tag.
                if (tagNode.__isTag) {
                    renderBookmarksForTag(tagNode.__fullName);
                }

                // Action 2: Toggle expansion if it has children.
                if (hasChildren) {
                    folderItem.classList.toggle('open');
                }
            });

            // If a folder is not a real tag (just a parent), make it look less interactive.
            if (!tagNode.__isTag) {
                folderName.style.opacity = '0.8';
            }
            container.appendChild(folderItem);
        }
    }
    function renderFolders() {
        folderListContainer.innerHTML = '';
        tagTree = buildTagTree(Object.keys(allBookmarksByTag));
        renderFolderTree(tagTree, folderListContainer);
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
            if (currentTag) renderBookmarksForTag(currentTag);
            return;
        }

        // Correctly filter the flat list of all bookmarks
        const filteredBookmarks = allBookmarksFlat.filter(b =>
            (b.title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (b.website_title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (b.description?.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (b.url?.toLowerCase().includes(lowerCaseSearchTerm))
        );

        document.querySelectorAll('.folder-item.active').forEach(item => item.classList.remove('active'));
        renderBookmarksForTag('Search Results', filteredBookmarks);
    }

    async function loadData(forceRefresh = false) {
        // Preserve the open/closed state of folders before re-rendering
        const openFolderTags = new Set();
        document.querySelectorAll('#folder-pane .folder-item.open').forEach(folder => {
            if (folder.dataset.tag) {
                openFolderTags.add(folder.dataset.tag);
            }
        });

        // Only show the main loading message on the initial load, not on refreshes.
        if (!forceRefresh) {
            loadingMessage.classList.remove('hidden');
            bookmarksList.innerHTML = '';
            errorMessage.classList.add('hidden');
        }

        try {
            const settings = await chrome.storage.sync.get(['linkdingUrl', 'apiToken']);
            if (!settings.linkdingUrl || !settings.apiToken) {
                showError('Linkding URL or API Token not set. Please configure the extension options.', true);
                return;
            }

            config = {
                linkdingUrl: settings.linkdingUrl,
                apiToken: settings.apiToken,
                cleanedUrl: settings.linkdingUrl.trim().replace(/\/$/, '')
            };

            allBookmarksFlat = await fetchAllBookmarks(config.cleanedUrl, config.apiToken);
            allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
            allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();

            // 1. Render the folder structure first.
            renderFolders();

            // 2. Now that the folders are in the DOM, restore their open state.
            if (openFolderTags.size > 0) {
                openFolderTags.forEach(tag => {
                    const parts = tag.split('.');
                    let currentPath = '';
                    parts.forEach(part => {
                        currentPath = currentPath ? `${currentPath}.${part}` : part;
                        const folderToOpen = document.querySelector(`.folder-item[data-tag="${currentPath}"]`);
                        if (folderToOpen) {
                            folderToOpen.classList.add('open');
                        }
                    });
                });
            }

            // 3. Finally, render the bookmarks for the active folder.
            const tagToRender = currentTag && allBookmarksByTag[currentTag] ? currentTag : Object.keys(allBookmarksByTag)[0];
            if (tagToRender) {
                renderBookmarksForTag(tagToRender);
            }
        } catch (error) {
            console.error('Error fetching bookmarks:', error);
            showError(`Failed to load bookmarks. Error: ${error.message}`);
        } finally {
            // On initial load, this hides the loading message. On refresh, this does nothing.
            loadingMessage.classList.add('hidden');
        }
    }

    async function init() {
        createContextMenu();
        searchBox.addEventListener('input', (e) => filterAndRender(e.target.value));
        refreshBtn.addEventListener('click', () => loadData(true));
        await loadData();
    }

    init();
});